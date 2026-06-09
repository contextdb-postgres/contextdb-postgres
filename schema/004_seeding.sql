-- ContextDB Historical Seeding Schema
-- Governed Context Database for Enterprise AI
--
-- Tables: ecl_seeding_jobs, ecl_seeding_fingerprints
--
-- Historical seeding allows organizations to backfill their Enterprise Context
-- Ledger with past signals from connected source systems. The ECL starts with
-- context from Day 1, not just from the moment of deployment.
--
-- Security note: The seeding_fingerprints table prevents seeding from becoming
-- a permission side door. Documents seeded with aclSnapshotStrategy='JIT_RECHECK_REQUIRED'
-- have evidence_status='STALE' — a live permission check always runs before serving
-- seeded evidence to users.
--
-- License: Apache 2.0

-- ---------------------------------------------------------------------------
-- ecl_seeding_jobs — one record per seeding run
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ecl_seeding_jobs (
  id                            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                     UUID        NOT NULL,
  connector_id                  TEXT        NOT NULL,
  object_types                  TEXT[]      NOT NULL,
  lookback_days                 INTEGER     NOT NULL DEFAULT 90,
  batch_size                    INTEGER     NOT NULL DEFAULT 100,

  status                        TEXT        NOT NULL DEFAULT 'PENDING'
    CONSTRAINT esj_status_check CHECK (status IN (
      'PENDING','RUNNING','PAUSED','COMPLETED','FAILED','CANCELLED'
    )),

  seed_mode                     TEXT        NOT NULL DEFAULT 'LIMITED_LOOKBACK'
    CONSTRAINT esj_seed_mode_check CHECK (seed_mode IN (
      'DAY_ZERO_FORWARD_ONLY',
      'LIMITED_LOOKBACK',
      'FULL_HISTORICAL_BACKFILL',
      'KNOWLEDGE_BASE_BOOTSTRAP'
    )),

  -- ACL handling for seeded records
  acl_snapshot_strategy         TEXT        NOT NULL DEFAULT 'ACL_HASH_ONLY'
    CONSTRAINT esj_acl_strategy_check CHECK (acl_snapshot_strategy IN (
      'SOURCE_PERMISSION_REF',
      'ACL_HASH_ONLY',
      'ACL_METADATA_COPY',
      'JIT_RECHECK_REQUIRED'
    )),

  -- Attribution
  requested_by                  UUID        NOT NULL,
  approved_by                   UUID,

  -- Scoping
  business_unit_scope           TEXT,
  region_scope                  TEXT,
  corporate_region              TEXT
    CONSTRAINT esj_region_check CHECK (corporate_region IN ('AMER','EMEA','APAC','GLOBAL') OR corporate_region IS NULL),
  timezone                      TEXT,
  respect_business_hours        BOOLEAN     NOT NULL DEFAULT TRUE,
  off_peak_utc_start            INTEGER     CONSTRAINT esj_off_peak_start_check CHECK (off_peak_utc_start BETWEEN 0 AND 23 OR off_peak_utc_start IS NULL),
  off_peak_utc_end              INTEGER     CONSTRAINT esj_off_peak_end_check CHECK (off_peak_utc_end BETWEEN 0 AND 23 OR off_peak_utc_end IS NULL),

  -- Blast-radius controls
  max_records_per_run           INTEGER,
  max_api_calls_per_hour        INTEGER,
  max_duration_minutes          INTEGER,
  pause_on_error_rate_percent   INTEGER     NOT NULL DEFAULT 10,

  -- Progress counters
  records_attempted             INTEGER     NOT NULL DEFAULT 0,
  records_imported              INTEGER     NOT NULL DEFAULT 0,
  records_skipped               INTEGER     NOT NULL DEFAULT 0,
  records_denied                INTEGER     NOT NULL DEFAULT 0,
  records_redacted              INTEGER     NOT NULL DEFAULT 0,

  -- Resumable cursor (JSONB for composite cursors: nextLink, offset+shard, etc.)
  -- Schema: { cursor_type, opaque_token, captured_at, expires_at,
  --           fallback_checkpoint: { last_successful_id, last_successful_timestamp } }
  last_source_cursor            JSONB,

  -- Dry-run estimates
  dry_run                       BOOLEAN     NOT NULL DEFAULT FALSE,
  estimated_records             INTEGER,
  estimated_api_calls           INTEGER,
  estimated_duration_seconds    INTEGER,

  error_message                 TEXT,
  notes                         TEXT,

  started_at                    TIMESTAMPTZ,
  paused_at                     TIMESTAMPTZ,
  completed_at                  TIMESTAMPTZ,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_esj_tenant_status
  ON ecl_seeding_jobs (tenant_id, status);

CREATE INDEX IF NOT EXISTS idx_esj_tenant_connector
  ON ecl_seeding_jobs (tenant_id, connector_id);

CREATE INDEX IF NOT EXISTS idx_esj_tenant_requested_by
  ON ecl_seeding_jobs (tenant_id, requested_by);

ALTER TABLE ecl_seeding_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY esj_tenant_isolation ON ecl_seeding_jobs
  USING (tenant_id = current_setting('app.tenant_id')::uuid);

-- ---------------------------------------------------------------------------
-- ecl_seeding_fingerprints — idempotency for seeding reruns
--
-- Before writing a new NCE during seeding, the seeding engine checks this
-- table. If a fingerprint exists for (tenant, connector, source_event_id,
-- source_updated_at), the event is skipped — it was already ingested.
--
-- This ensures seeding jobs are safe to pause, retry, and re-run without
-- creating duplicate NCEs.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ecl_seeding_fingerprints (
  tenant_id             UUID        NOT NULL,
  connector_id          TEXT        NOT NULL,
  source_event_id       TEXT        NOT NULL,
  source_updated_at     TIMESTAMPTZ,          -- NULL for immutable event records
  nce_id                UUID        NOT NULL, -- the NCE that was written
  backfill_batch_id     UUID        NOT NULL REFERENCES ecl_seeding_jobs(id) ON DELETE CASCADE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Idempotency constraint: same event from same connector at same version = same NCE
  CONSTRAINT ecl_seeding_fp_unique
    UNIQUE (tenant_id, connector_id, source_event_id, source_updated_at)
);

CREATE INDEX IF NOT EXISTS idx_esfp_batch
  ON ecl_seeding_fingerprints (backfill_batch_id);

CREATE INDEX IF NOT EXISTS idx_esfp_nce
  ON ecl_seeding_fingerprints (nce_id);

ALTER TABLE ecl_seeding_fingerprints ENABLE ROW LEVEL SECURITY;
CREATE POLICY esfp_tenant_isolation ON ecl_seeding_fingerprints
  USING (tenant_id = current_setting('app.tenant_id')::uuid);

-- ---------------------------------------------------------------------------
-- IMPORTANT: Seeding is NOT a permission side door.
--
-- Seeded records do NOT grant users access to evidence they are not
-- authorized to see in the source system.
--
-- When aclSnapshotStrategy = 'JIT_RECHECK_REQUIRED':
--   → evidence_status is set to 'STALE' at seed time (in context_pod_evidence_refs)
--   → before serving this evidence in context, a live permission check is made
--   → if the user lacks access in the source system, the evidence is excluded
--   → the exclusion is recorded in the audit trail
--
-- When aclSnapshotStrategy = 'ACL_HASH_ONLY':
--   → the hash of the permission state at seed time is stored
--   → permission drift is detected on the next evidence review cycle
--   → evidence transitions to STALE, then JIT re-check is triggered
-- ---------------------------------------------------------------------------
