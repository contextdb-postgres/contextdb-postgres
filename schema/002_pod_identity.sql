-- ContextDB Context Pod Identity Schema
-- Governed Context Database for Enterprise AI
--
-- Tables: context_pods, context_pod_versions, context_pod_assembly_runs,
--         context_pod_evidence_refs
-- View:   context_audit_trace_v
--
-- These tables implement the durable, versioned pod identity model.
-- Every context assembly is traceable from transaction → pod → version → evidence.
--
-- Key rule: transaction_id is correlation-only — it is NEVER pod identity.
-- Pod identity is stable across all transactions.
--
-- License: Apache 2.0

-- ---------------------------------------------------------------------------
-- context_pods — durable logical pod identity
-- One pod per (tenant, focal entity, mode) combination.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS context_pods (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID        NOT NULL,
  focal_entity_type    TEXT        NOT NULL,
  focal_entity_id      TEXT        NOT NULL,
  focal_entity_name    TEXT,

  -- Assembly context
  assembly_trigger     TEXT,
  assembly_duration_ms INTEGER,
  assembled_at         TIMESTAMPTZ,
  valid_until          TIMESTAMPTZ,
  stale_after          TIMESTAMPTZ,
  context              JSONB,
  sources              JSONB,

  -- Extended identity (added by this schema)
  mode_id              TEXT,
  scope_type           TEXT        NOT NULL DEFAULT 'TENANT'
    CONSTRAINT context_pods_scope_type_check CHECK (scope_type IN ('TENANT','GROUP','ROLE','BUSINESS_UNIT')),
  scope_key            TEXT,
  title                TEXT,
  created_by           UUID,
  current_version_id   UUID,         -- FK set after context_pod_versions created (DEFERRABLE)
  is_active            BOOLEAN     NOT NULL DEFAULT TRUE,

  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_context_pods_tenant
  ON context_pods (tenant_id);

CREATE INDEX IF NOT EXISTS idx_context_pods_focal
  ON context_pods (tenant_id, focal_entity_type, focal_entity_id);

CREATE INDEX IF NOT EXISTS idx_context_pods_mode
  ON context_pods (tenant_id, mode_id)
  WHERE mode_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_context_pods_scope
  ON context_pods (tenant_id, scope_type, scope_key);

CREATE INDEX IF NOT EXISTS idx_context_pods_active
  ON context_pods (tenant_id, is_active);

ALTER TABLE context_pods ENABLE ROW LEVEL SECURITY;
CREATE POLICY context_pods_tenant_isolation ON context_pods
  USING (tenant_id = current_setting('app.tenant_id')::uuid);

-- ---------------------------------------------------------------------------
-- context_pod_versions — immutable snapshots of pod state
-- A new version is created whenever evidence, policy, or completeness changes.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS context_pod_versions (
  id                              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                       UUID        NOT NULL,
  pod_id                          UUID        NOT NULL REFERENCES context_pods(id) ON DELETE CASCADE,
  version_number                  INTEGER     NOT NULL,   -- monotonically increasing per pod

  -- Hash chain (canonical serialization — strip transient fields before hashing)
  pod_hash                        TEXT        NOT NULL,   -- SHA-256 of canonical pod content
  prev_version_hash               TEXT,                   -- hash chain integrity
  policy_hash                     TEXT,                   -- adaptive policy state at version time
  evidence_set_hash               TEXT,                   -- SHA-256 of sorted evidence_ref ids
  retrieval_receipt_hash          TEXT,

  -- Correlation refs (NOT identity — used for audit tracing only)
  created_by_transaction_id       TEXT,
  created_by_backfill_batch_id    TEXT,

  -- Completeness snapshot
  completeness_status             TEXT
    CONSTRAINT cpv_completeness_check CHECK (completeness_status IN (
      'SUFFICIENT','INSUFFICIENT','PARTIAL','PENDING_EVIDENCE'
    )),
  confidence_requirement          TEXT,
  source_policy                   TEXT,
  freshness_requirement           TEXT,
  manual_review_required          BOOLEAN     NOT NULL DEFAULT FALSE,

  created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT cpv_unique UNIQUE (tenant_id, pod_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_cpv_pod
  ON context_pod_versions (tenant_id, pod_id);

CREATE INDEX IF NOT EXISTS idx_cpv_receipt
  ON context_pod_versions (tenant_id, retrieval_receipt_hash)
  WHERE retrieval_receipt_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cpv_txn
  ON context_pod_versions (tenant_id, created_by_transaction_id)
  WHERE created_by_transaction_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cpv_backfill
  ON context_pod_versions (tenant_id, created_by_backfill_batch_id)
  WHERE created_by_backfill_batch_id IS NOT NULL;

-- Compound index to speed up context_audit_trace_v
CREATE INDEX IF NOT EXISTS idx_cpv_version_artifact
  ON context_pod_versions (pod_id, id);

ALTER TABLE context_pod_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY cpv_tenant_isolation ON context_pod_versions
  USING (tenant_id = current_setting('app.tenant_id')::uuid);

-- Add FK from context_pods.current_version_id (after versions table exists)
ALTER TABLE context_pods
  ADD CONSTRAINT IF NOT EXISTS fk_current_version
  FOREIGN KEY (current_version_id)
  REFERENCES context_pod_versions(id)
  DEFERRABLE INITIALLY DEFERRED;

-- ---------------------------------------------------------------------------
-- context_pod_assembly_runs — one record per assembly execution
-- Tracks every run: on-demand, scheduled, seeding, prefetch, recompute.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS context_pod_assembly_runs (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID        NOT NULL,
  pod_id                  UUID        NOT NULL REFERENCES context_pods(id) ON DELETE CASCADE,

  -- Correlation (NOT identity)
  transaction_id          TEXT,       -- request lifecycle correlation only
  mode_id                 TEXT,
  job_to_be_done          TEXT,
  requested_by            UUID,

  trigger_type            TEXT        NOT NULL
    CONSTRAINT cpar_trigger_check CHECK (trigger_type IN (
      'ON_DEMAND','SCHEDULED','EVENT_DRIVEN',
      'BACKFILL_SEED','PREFETCH','RECOMPUTE'
    )),

  status                  TEXT        NOT NULL DEFAULT 'PENDING'
    CONSTRAINT cpar_status_check CHECK (status IN (
      'PENDING','RUNNING','COMPLETED','FAILED','CANCELLED'
    )),

  produced_version_id     UUID        REFERENCES context_pod_versions(id),
  retrieval_receipt_hash  TEXT,
  adaptation_reasons      JSONB,
  error                   TEXT,

  started_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at            TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_cpar_pod
  ON context_pod_assembly_runs (tenant_id, pod_id);

CREATE INDEX IF NOT EXISTS idx_cpar_txn
  ON context_pod_assembly_runs (tenant_id, transaction_id)
  WHERE transaction_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cpar_version
  ON context_pod_assembly_runs (tenant_id, produced_version_id)
  WHERE produced_version_id IS NOT NULL;

-- Compound index for context_audit_trace_v
CREATE INDEX IF NOT EXISTS idx_cpar_txn_pod_version
  ON context_pod_assembly_runs (transaction_id, produced_version_id)
  WHERE transaction_id IS NOT NULL;

ALTER TABLE context_pod_assembly_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY cpar_tenant_isolation ON context_pod_assembly_runs
  USING (tenant_id = current_setting('app.tenant_id')::uuid);

-- ---------------------------------------------------------------------------
-- context_pod_evidence_refs — links evidence to pod versions
-- Every piece of evidence (NCE, receipt, external ref) that contributed to
-- a pod version is recorded here with status and provenance.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS context_pod_evidence_refs (
  id                              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                       UUID        NOT NULL,
  pod_id                          UUID        NOT NULL REFERENCES context_pods(id) ON DELETE CASCADE,
  pod_version_id                  UUID        NOT NULL REFERENCES context_pod_versions(id) ON DELETE CASCADE,

  artifact_type                   TEXT        NOT NULL
    CONSTRAINT cper_artifact_type_check CHECK (artifact_type IN (
      'NCE','RETRIEVAL_RECEIPT','CONTEXT_PLAN','OUTCOME_TELEMETRY',
      'CFA_RECEIPT','EXTERNAL_REFERENCE','BACKFILL_RECORD'
    )),
  artifact_id                     TEXT        NOT NULL,   -- UUID or external ref
  nce_id                          UUID        REFERENCES normalized_context_events(id),
  source_system                   TEXT,
  source_event_id                 TEXT,
  source_uri                      TEXT,

  evidence_role                   TEXT
    CONSTRAINT cper_evidence_role_check CHECK (evidence_role IN (
      'PRIMARY','SUPPORTING','CONTRADICTING','AUDIT_ONLY','NOT_PROVEN'
    )),
  evidence_status                 TEXT        NOT NULL DEFAULT 'ACTIVE'
    CONSTRAINT cper_evidence_status_check CHECK (evidence_status IN (
      'ACTIVE','STALE','REVOKED','REDACTED'
    )),
  temperature_tier                TEXT
    CONSTRAINT cper_temperature_tier_check CHECK (temperature_tier IN (
      'HOT','WARM','COOL','COLD','ARCHIVED'
    )),

  provenance_hash                 TEXT,
  included_by_transaction_id      TEXT,       -- correlation only
  included_by_backfill_batch_id   TEXT,       -- seeding job ref

  created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cper_pod_version
  ON context_pod_evidence_refs (tenant_id, pod_id, pod_version_id);

CREATE INDEX IF NOT EXISTS idx_cper_nce
  ON context_pod_evidence_refs (tenant_id, nce_id)
  WHERE nce_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cper_txn
  ON context_pod_evidence_refs (tenant_id, included_by_transaction_id)
  WHERE included_by_transaction_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cper_backfill
  ON context_pod_evidence_refs (tenant_id, included_by_backfill_batch_id)
  WHERE included_by_backfill_batch_id IS NOT NULL;

-- Compound index for context_audit_trace_v view
CREATE INDEX IF NOT EXISTS idx_cper_version_artifact
  ON context_pod_evidence_refs (pod_version_id, artifact_type, artifact_id);

ALTER TABLE context_pod_evidence_refs ENABLE ROW LEVEL SECURITY;
CREATE POLICY cper_tenant_isolation ON context_pod_evidence_refs
  USING (tenant_id = current_setting('app.tenant_id')::uuid);

-- ---------------------------------------------------------------------------
-- context_audit_trace_v — full trace reconstruction view
-- Queryable by: transaction_id, pod_id, pod_version_id,
--               retrieval_receipt_hash, backfill_batch_id
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW context_audit_trace_v AS
SELECT
  -- Assembly run (entry point for transaction-based trace)
  r.id                                AS pod_run_id,
  r.transaction_id                    AS transaction_id,
  r.trigger_type                      AS trigger_type,
  r.started_at                        AS run_started_at,
  r.completed_at                      AS run_completed_at,
  r.status                            AS run_status,
  r.mode_id                           AS mode_id,
  r.job_to_be_done                    AS job_to_be_done,
  r.adaptation_reasons                AS adaptation_reasons,
  r.error                             AS run_error,

  -- Pod identity
  p.id                                AS pod_id,
  p.tenant_id                         AS tenant_id,
  p.focal_entity_type                 AS focal_entity_type,
  p.focal_entity_id                   AS focal_entity_id,
  p.scope_type                        AS scope_type,
  p.scope_key                         AS scope_key,
  p.is_active                         AS pod_is_active,

  -- Version snapshot
  v.id                                AS pod_version_id,
  v.version_number                    AS version_number,
  v.pod_hash                          AS pod_hash,
  v.retrieval_receipt_hash            AS retrieval_receipt_hash,
  v.completeness_status               AS completeness_status,
  v.confidence_requirement            AS confidence_requirement,
  v.source_policy                     AS source_policy,
  v.manual_review_required            AS manual_review_required,
  v.created_by_transaction_id         AS version_created_by_transaction_id,
  v.created_by_backfill_batch_id      AS version_created_by_backfill_batch_id,

  -- Evidence refs (aggregated)
  COALESCE(
    jsonb_agg(DISTINCT jsonb_build_object(
      'artifact_type',    e.artifact_type,
      'artifact_id',      e.artifact_id,
      'nce_id',           e.nce_id,
      'source_system',    e.source_system,
      'source_event_id',  e.source_event_id,
      'evidence_role',    e.evidence_role,
      'evidence_status',  e.evidence_status,
      'temperature_tier', e.temperature_tier,
      'provenance_hash',  e.provenance_hash
    )) FILTER (WHERE e.id IS NOT NULL),
    '[]'::jsonb
  )                                   AS evidence_refs

FROM context_pod_assembly_runs  r
JOIN context_pods                p ON p.id = r.pod_id AND p.tenant_id = r.tenant_id
LEFT JOIN context_pod_versions   v ON v.id = r.produced_version_id
LEFT JOIN context_pod_evidence_refs e
  ON e.pod_version_id = v.id AND e.tenant_id = r.tenant_id

GROUP BY r.id, p.id, v.id;

COMMENT ON VIEW context_audit_trace_v IS
  'Full governance trace: run → pod → version → evidence. '
  'Filter by transaction_id (correlation), pod_id, pod_version_id, '
  'retrieval_receipt_hash, or version_created_by_backfill_batch_id. '
  'RLS is enforced via the underlying tables — set app.tenant_id before querying.';
