/**
 * ContextDB Tenant Context
 * Governed Context Database for Enterprise AI
 *
 * Utilities for setting and managing tenant context in PostgreSQL sessions.
 * All ContextDB tables use Row-Level Security (RLS) via the app.tenant_id
 * session variable — this module provides the helpers to set it correctly.
 *
 * @license Apache-2.0
 */

import type { Pool, PoolClient } from 'pg';

/**
 * Sets the tenant context for the current PostgreSQL session.
 * Must be called before any query on a tenant-scoped table.
 *
 * The third parameter to set_config (true) makes this session-local:
 * the value is automatically reset when the transaction ends.
 *
 * @example
 * const client = await pool.connect();
 * await setTenantContext(client, tenantId);
 * const rows = await client.query('SELECT * FROM normalized_context_events LIMIT 10');
 */
export async function setTenantContext(
  client: PoolClient | Pool,
  tenantId: string
): Promise<void> {
  await client.query(
    "SELECT set_config('app.tenant_id', $1, true)",
    [tenantId]
  );
}

/**
 * Gets the current tenant ID from the PostgreSQL session variable.
 * Returns null if not set.
 */
export async function getCurrentTenantId(
  client: PoolClient | Pool
): Promise<string | null> {
  const result = await client.query<{ tenant_id: string | null }>(
    "SELECT current_setting('app.tenant_id', true) AS tenant_id"
  );
  const value = result.rows[0]?.tenant_id;
  return value && value.length > 0 ? value : null;
}

/**
 * Executes a function within a tenant-scoped database context.
 * Acquires a client from the pool, sets the tenant context, runs the function,
 * and releases the client.
 *
 * @example
 * const events = await withTenantContext(pool, tenantId, async (client) => {
 *   const result = await client.query(
 *     'SELECT * FROM normalized_context_events WHERE event_type = $1',
 *     ['CASE_ESCALATED']
 *   );
 *   return result.rows;
 * });
 */
export async function withTenantContext<T>(
  pool: Pool,
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await setTenantContext(client, tenantId);
    return await fn(client);
  } finally {
    client.release();
  }
}

/**
 * Executes a function within a tenant-scoped transaction.
 * Starts a transaction, sets the tenant context, runs the function,
 * commits on success, rolls back on error.
 *
 * @example
 * await withTenantTransaction(pool, tenantId, async (client) => {
 *   await writeContextEvent(client, tenantId, event);
 *   await updatePodVersion(client, tenantId, podId, versionData);
 * });
 */
export async function withTenantTransaction<T>(
  pool: Pool,
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await setTenantContext(client, tenantId);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
