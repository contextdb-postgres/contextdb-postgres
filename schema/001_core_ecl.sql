-- ContextDB Core ECL Schema
-- Governed Context Database for Enterprise AI
--
-- Table: normalized_context_events (ECL — Enterprise Context Ledger)
--
-- CRITICAL: This table is APPEND-ONLY.
-- The after-row trigger below raises an exception on any UPDATE or DELETE.
-- Hash chain integrity depends on immutability.
--
-- Compatible with: PostgreSQL 14+ (pgvector optional for embedding column)
-- License: Apache 2.0

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ---------------------------------------------------------------------------
-- Source system registry
-- Extensible lookup replacing hardcoded CHECK constraints.
-- Application-level validation is preferred over FK for throughput.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS source_system_registry (
  id         VARCHAR(50)  PRIMARY KEY,
  label      TEXT         NOT NULL,
  category   TEXT         NOT NULL DEFAULT 'OTHER',
  active     BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Seed common source systems (extend for your integrations)
INSERT INTO source_system_registry (id, label, category) VALUES
  ('SALESFORCE',       'Salesforce Core CRM',           'CRM'),
  ('GMAIL',            'Google Mail Service',           'EMAIL'),
  ('CALENDAR',         'Google Calendar',               'CALENDAR'),
  ('LINKEDIN_SIGNAL',  'LinkedIn Signal Stream',        'SOCIAL'),
  ('MANUAL',           'Manual Operator Ingestion',     'OTHER'),
  ('GOOGLE_DRIVE',     'Google Drive Documents',        'DOCUMENT'),
  ('SHAREPOINT',       'Microsoft SharePoint',          'DOCUMENT'),
  ('CONFLUENCE',       'Atlassian Confluence',          'DOCUMENT'),
  ('BOX',              'Box Enterprise Storage',        'DOCUMENT'),
  ('SLACK',            'Slack Messaging',               'COLLAB'),
  ('SERVICENOW',       'ServiceNow ITSM',               'ITSM'),
  ('JIRA',             'Jira Issue Tracker',            'DEVTOOLS'),
  ('ZENDESK',          'Zendesk Support',               'SUPPORT'),
  ('MICROSOFT365',     'Microsoft 365 / Teams',         'COLLAB'),
  ('HUBSPOT',          'HubSpot CRM',                   'CRM'),
  ('ZOOM',             'Zoom Meetings',                 'CALENDAR'),
  ('WEBEX',            'Cisco Webex',                   'CALENDAR'),
  ('ASANA',            'Asana',                         'DEVTOOLS'),
  ('WORKDAY',          'Workday HRIS',                  'HRIS')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- normalized_context_events — the ECL (Enterprise Context Ledger)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS normalized_context_events (
  -- Identity
  id                         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                  UUID        NOT NULL,
  schema_version             VARCHAR(10) NOT NULL DEFAULT '1.0',

  -- Source identification
  source_system              VARCHAR(50) NOT NULL,
  source_event_id            VARCHAR(500) NOT NULL,
  source_object              VARCHAR(100),

  -- Event classification
  event_type                 VARCHAR(80) NOT NULL,
  event_time                 TIMESTAMPTZ NOT NULL,

  -- Participants and content (JSONB — flexible, indexed)
  participants               JSONB       NOT NULL DEFAULT '[]',
  content                    JSONB       NOT NULL DEFAULT '{}',
  entity_refs                JSONB,

  -- Provenance
  provenance_ingested_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  provenance_connector_id    UUID,
  provenance_raw_event_hash  VARCHAR(64),
  provenance_thread_id       VARCHAR(500),

  -- Governance fields (contextdb-postgres v1)
  origin_type                VARCHAR(30) NOT NULL DEFAULT 'fabric_observed'
    CONSTRAINT nce_origin_type_check CHECK (origin_type IN (
      'fabric_observed',
      'historical_backfill',
      'synthetic_fixture',
      'imported_summary'
    )),
  decision_status            VARCHAR(20)
    CONSTRAINT nce_decision_status_check CHECK (decision_status IN (
      'ALLOWED', 'DENIED', 'HELD', 'REDACTED', 'ESCALATED'
    )),
  policy_refs                TEXT[]      NOT NULL DEFAULT '{}',
  mode_id                    TEXT,
  fabric_transaction_id      TEXT,
  redacted_at                TIMESTAMPTZ,
  redaction_reason           TEXT,

  -- Timestamps
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at               TIMESTAMPTZ,

  -- Idempotency: no duplicate events from the same source per tenant
  CONSTRAINT uq_nce_tenant_source UNIQUE (tenant_id, source_system, source_event_id)
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_nce_tenant_id
  ON normalized_context_events (tenant_id);

CREATE INDEX IF NOT EXISTS idx_nce_tenant_event_time
  ON normalized_context_events (tenant_id, event_time);

CREATE INDEX IF NOT EXISTS idx_nce_tenant_source_system
  ON normalized_context_events (tenant_id, source_system);

CREATE INDEX IF NOT EXISTS idx_nce_origin_type
  ON normalized_context_events (tenant_id, origin_type);

CREATE INDEX IF NOT EXISTS idx_nce_decision_status
  ON normalized_context_events (tenant_id, decision_status)
  WHERE decision_status IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_nce_mode_id
  ON normalized_context_events (tenant_id, mode_id)
  WHERE mode_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_nce_transaction_id
  ON normalized_context_events (tenant_id, fabric_transaction_id)
  WHERE fabric_transaction_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_nce_thread_id
  ON normalized_context_events (tenant_id, provenance_thread_id)
  WHERE provenance_thread_id IS NOT NULL;

-- GIN indexes for JSONB search
CREATE INDEX IF NOT EXISTS idx_nce_participants
  ON normalized_context_events USING GIN (participants);

CREATE INDEX IF NOT EXISTS idx_nce_entity_refs
  ON normalized_context_events USING GIN (entity_refs)
  WHERE entity_refs IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_nce_policy_refs
  ON normalized_context_events USING GIN (policy_refs);

-- ---------------------------------------------------------------------------
-- Append-only trigger
-- Raises an exception on any UPDATE or DELETE to preserve hash chain integrity.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION nce_append_only_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION
    'normalized_context_events is APPEND-ONLY. '
    'UPDATE and DELETE are forbidden. '
    'Use decision_status=REDACTED for compliance purge.';
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS nce_append_only ON normalized_context_events;
CREATE TRIGGER nce_append_only
  BEFORE UPDATE OR DELETE ON normalized_context_events
  FOR EACH ROW EXECUTE FUNCTION nce_append_only_guard();

-- ---------------------------------------------------------------------------
-- Row-level security (RLS) — multi-tenant isolation
-- Call: SELECT set_config('app.tenant_id', '<uuid>', true);
-- ---------------------------------------------------------------------------
ALTER TABLE normalized_context_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY nce_tenant_isolation ON normalized_context_events
  USING (tenant_id = current_setting('app.tenant_id')::uuid);

ALTER TABLE source_system_registry ENABLE ROW LEVEL SECURITY;
-- source_system_registry is global (not tenant-scoped) — no RLS policy needed;
-- all tenants read the same registry. Admins write via super-user connection.
