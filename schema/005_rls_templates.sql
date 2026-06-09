-- ContextDB Row-Level Security Templates
-- Governed Context Database for Enterprise AI
--
-- These templates show the canonical RLS pattern used across all ContextDB tables.
-- All tenant data is isolated via the app.tenant_id session variable.
--
-- Usage: before any query, call:
--   SELECT set_config('app.tenant_id', '<uuid>', true);
--
-- License: Apache 2.0

-- ---------------------------------------------------------------------------
-- Template 1 — Standard tenant isolation (most tables)
-- ---------------------------------------------------------------------------
-- ALTER TABLE <your_table> ENABLE ROW LEVEL SECURITY;
--
-- CREATE POLICY <your_table>_tenant_isolation ON <your_table>
--   USING (tenant_id = current_setting('app.tenant_id')::uuid);
--
-- This policy applies to all operations (SELECT, INSERT, UPDATE, DELETE).
-- For INSERT, add a WITH CHECK clause if you want to prevent cross-tenant writes:
--
-- CREATE POLICY <your_table>_tenant_isolation ON <your_table>
--   USING (tenant_id = current_setting('app.tenant_id')::uuid)
--   WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);

-- ---------------------------------------------------------------------------
-- Template 2 — Separate read and write policies (finer-grained)
-- ---------------------------------------------------------------------------
-- ALTER TABLE <your_table> ENABLE ROW LEVEL SECURITY;
--
-- -- Read: tenant-scoped
-- CREATE POLICY <your_table>_read ON <your_table>
--   FOR SELECT
--   USING (tenant_id = current_setting('app.tenant_id')::uuid);
--
-- -- Write: tenant-scoped + not completed/archived
-- CREATE POLICY <your_table>_write ON <your_table>
--   FOR INSERT
--   WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);

-- ---------------------------------------------------------------------------
-- Template 3 — Read-only (append-only tables like normalized_context_events)
-- ---------------------------------------------------------------------------
-- ALTER TABLE <your_table> ENABLE ROW LEVEL SECURITY;
--
-- CREATE POLICY <your_table>_tenant_isolation ON <your_table>
--   FOR SELECT
--   USING (tenant_id = current_setting('app.tenant_id')::uuid);
--
-- CREATE POLICY <your_table>_insert_only ON <your_table>
--   FOR INSERT
--   WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
--
-- -- No UPDATE or DELETE policies → those operations will always fail

-- ---------------------------------------------------------------------------
-- Template 4 — Global reference table (no tenant isolation needed)
-- Applied to: source_system_registry
-- ---------------------------------------------------------------------------
-- ALTER TABLE <your_table> ENABLE ROW LEVEL SECURITY;
-- -- No policies needed — all tenants read the same global reference data.
-- -- Admin writes via super-user (bypasses RLS).

-- ---------------------------------------------------------------------------
-- Helper function: set tenant context
-- Call this at the start of every transaction.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_tenant_context(tenant_uuid UUID)
RETURNS void
LANGUAGE sql
SET search_path = public
AS $$
  SELECT set_config('app.tenant_id', tenant_uuid::text, true);
$$;

COMMENT ON FUNCTION set_tenant_context IS
  'Sets the app.tenant_id session variable used by all RLS policies. '
  'Call once per transaction/connection before any tenant-scoped queries. '
  'The third parameter (true) makes this session-local: resets on transaction end.';

-- ---------------------------------------------------------------------------
-- Helper function: current tenant context
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION current_tenant_id()
RETURNS UUID
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT current_setting('app.tenant_id')::uuid;
$$;

COMMENT ON FUNCTION current_tenant_id IS
  'Returns the currently active tenant UUID from the session variable. '
  'Raises an error if app.tenant_id is not set.';

-- ---------------------------------------------------------------------------
-- Helper function: safe tenant context check
-- Returns NULL instead of raising an error if not set.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION current_tenant_id_safe()
RETURNS UUID
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  raw TEXT;
BEGIN
  raw := current_setting('app.tenant_id', true);  -- true = return NULL if not set
  IF raw IS NULL OR raw = '' THEN
    RETURN NULL;
  END IF;
  RETURN raw::uuid;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION current_tenant_id_safe IS
  'Returns the currently active tenant UUID, or NULL if not set. '
  'Safe version for use in triggers and system contexts.';

-- ---------------------------------------------------------------------------
-- Example: enforcing tenant context in application code (TypeScript)
--
-- import { Pool } from 'pg';
--
-- const pool = new Pool({ connectionString: process.env.DATABASE_URL });
--
-- async function withTenantContext<T>(
--   tenantId: string,
--   fn: (client: PoolClient) => Promise<T>
-- ): Promise<T> {
--   const client = await pool.connect();
--   try {
--     await client.query('SELECT set_tenant_context($1)', [tenantId]);
--     return await fn(client);
--   } finally {
--     client.release();
--   }
-- }
--
-- // Usage:
-- const events = await withTenantContext(tenantId, async (client) => {
--   const result = await client.query(
--     'SELECT * FROM normalized_context_events WHERE event_type = $1',
--     ['CASE_ESCALATED']
--   );
--   return result.rows;
-- });
-- ---------------------------------------------------------------------------
