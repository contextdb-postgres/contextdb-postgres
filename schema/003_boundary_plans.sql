-- ContextDB Boundary Plans Audit Schema
-- Governed Context Database for Enterprise AI
--
-- Table: context_boundary_plans
--
-- Records every governed context boundary plan produced before an assembly run.
-- A boundary plan captures: which sources were eligible/forbidden, the authority
-- level, temporal mode, sufficiency threshold, whether retrieval terminated early,
-- and the final sufficiency score.
--
-- This table is the audit trail for governed context retrieval decisions.
-- It answers: "Why did the system retrieve these sources and stop when it did?"
--
-- License: Apache 2.0

CREATE TABLE IF NOT EXISTS context_boundary_plans (
  id                        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 UUID        NOT NULL,

  -- Plan hash: SHA-256 of canonical inputs (tenantId + modeId + principalId +
  -- operationalFrame + requestHash). Enables cache lookups and deduplication.
  plan_hash                 TEXT        NOT NULL,

  -- Context
  mode_id                   TEXT,
  principal_id              TEXT,
  operational_frame         TEXT        NOT NULL,

  -- Authority boundary result
  canopy_decision           TEXT        NOT NULL
    CONSTRAINT cbp_canopy_decision_check CHECK (canopy_decision IN (
      'REUSED_TRUST',
      'STEP_UP_REQUIRED',
      'APPROVAL_REQUIRED',
      'DENIED',
      'BLOCKED_CERTIFICATION_DRIFT',
      'NOT_EVALUATED'
    )),
  authority_level           TEXT        NOT NULL
    CONSTRAINT cbp_authority_level_check CHECK (authority_level IN (
      'ADMIN','OWNER','CONTRIBUTOR','VIEWER','NONE'
    )),

  -- Temporal boundary result
  temporal_mode             TEXT        NOT NULL
    CONSTRAINT cbp_temporal_mode_check CHECK (temporal_mode IN (
      'OPERATIONAL','HISTORICAL','COMPLIANCE','HYBRID'
    )),

  -- Source eligibility (arrays for querying / reporting)
  eligible_sources          TEXT[]      NOT NULL DEFAULT '{}',
  forbidden_sources         TEXT[]      NOT NULL DEFAULT '{}',
  required_categories       TEXT[]      NOT NULL DEFAULT '{}',

  -- Sufficiency gate outcome
  sufficiency_threshold     NUMERIC(5,4) NOT NULL,
  terminated_early          BOOLEAN     NOT NULL DEFAULT FALSE,
  termination_reason        TEXT,
  satisfied_categories      TEXT[],
  missing_categories        TEXT[],
  final_sufficiency_score   NUMERIC(5,4),

  -- Full plan snapshot (queryable JSONB for advanced analysis)
  plan_json                 JSONB       NOT NULL DEFAULT '{}',

  -- Lifecycle
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at                TIMESTAMPTZ NOT NULL,

  -- Back-reference to the retrieval receipt that used this plan
  used_by_receipt_hash      TEXT
);

-- Primary lookup: plan by hash (cache hit / dedup)
CREATE INDEX IF NOT EXISTS idx_cbp_tenant_hash
  ON context_boundary_plans (tenant_id, plan_hash);

-- Query boundary plans by mode
CREATE INDEX IF NOT EXISTS idx_cbp_tenant_mode
  ON context_boundary_plans (tenant_id, mode_id)
  WHERE mode_id IS NOT NULL;

-- Query boundary plans by principal
CREATE INDEX IF NOT EXISTS idx_cbp_tenant_principal
  ON context_boundary_plans (tenant_id, principal_id)
  WHERE principal_id IS NOT NULL;

-- Query boundary plans by operational frame
CREATE INDEX IF NOT EXISTS idx_cbp_tenant_frame
  ON context_boundary_plans (tenant_id, operational_frame);

-- Expiry cleanup (background job: DELETE WHERE expires_at < NOW())
CREATE INDEX IF NOT EXISTS idx_cbp_expiry
  ON context_boundary_plans (expires_at);

-- Query plans that terminated early (common analytics pattern)
CREATE INDEX IF NOT EXISTS idx_cbp_terminated_early
  ON context_boundary_plans (tenant_id, terminated_early)
  WHERE terminated_early = TRUE;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
ALTER TABLE context_boundary_plans ENABLE ROW LEVEL SECURITY;

CREATE POLICY cbp_tenant_isolation ON context_boundary_plans
  USING (tenant_id = current_setting('app.tenant_id')::uuid);

-- ---------------------------------------------------------------------------
-- Useful queries (documentation)
-- ---------------------------------------------------------------------------

-- Find all plans that terminated early for a tenant:
-- SELECT operational_frame, sufficiency_threshold, final_sufficiency_score,
--        termination_reason, eligible_sources, forbidden_sources
-- FROM context_boundary_plans
-- WHERE terminated_early = TRUE
-- ORDER BY created_at DESC LIMIT 50;

-- Find how often each source appears in eligible vs. forbidden lists:
-- SELECT unnest(eligible_sources) AS source, COUNT(*) AS eligible_count
-- FROM context_boundary_plans GROUP BY 1 ORDER BY 2 DESC;
-- SELECT unnest(forbidden_sources) AS source, COUNT(*) AS forbidden_count
-- FROM context_boundary_plans GROUP BY 1 ORDER BY 2 DESC;

-- Find plans by the receipt hash (join back to pod versions):
-- SELECT cbp.*, cpv.pod_id, cpv.version_number
-- FROM context_boundary_plans cbp
-- JOIN context_pod_versions cpv ON cpv.retrieval_receipt_hash = cbp.used_by_receipt_hash
-- WHERE cbp.used_by_receipt_hash IS NOT NULL;
