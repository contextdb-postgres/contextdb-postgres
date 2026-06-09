/**
 * ContextDB Read Operations
 * Governed Context Database for Enterprise AI
 *
 * Type-safe read helpers for ContextDB tables.
 * All reads assume tenant context is already set via setTenantContext().
 *
 * @license Apache-2.0
 */

import type { PoolClient } from 'pg';
import type {
  NCE,
  ContextPod,
  ContextPodVersion,
  ContextBoundaryPlan,
  AuditTraceRow,
  NCEDecisionStatus,
  NCEOriginType,
} from './types.js';

// ---------------------------------------------------------------------------
// Normalized Context Events
// ---------------------------------------------------------------------------

export interface QueryContextEventsOptions {
  sourceSystem?: string;
  eventType?: string;
  eventTypes?: string[];
  originType?: NCEOriginType;
  decisionStatus?: NCEDecisionStatus;
  modeId?: string;
  transactionId?: string;
  fromTime?: Date;
  toTime?: Date;
  limit?: number;
  offset?: number;
  /** Exclude redacted records (default: true) */
  excludeRedacted?: boolean;
}

/**
 * Queries normalized context events for the current tenant.
 * Supports filtering by source, event type, time range, and governance fields.
 */
export async function queryContextEvents(
  client: PoolClient,
  tenantId: string,
  options: QueryContextEventsOptions = {}
): Promise<NCE[]> {
  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [tenantId];
  let paramIdx = 2;

  if (options.sourceSystem) {
    conditions.push(`source_system = $${paramIdx++}`);
    params.push(options.sourceSystem);
  }

  if (options.eventType) {
    conditions.push(`event_type = $${paramIdx++}`);
    params.push(options.eventType);
  }

  if (options.eventTypes && options.eventTypes.length > 0) {
    conditions.push(`event_type = ANY($${paramIdx++})`);
    params.push(options.eventTypes);
  }

  if (options.originType) {
    conditions.push(`origin_type = $${paramIdx++}`);
    params.push(options.originType);
  }

  if (options.decisionStatus) {
    conditions.push(`decision_status = $${paramIdx++}`);
    params.push(options.decisionStatus);
  }

  if (options.modeId) {
    conditions.push(`mode_id = $${paramIdx++}`);
    params.push(options.modeId);
  }

  if (options.transactionId) {
    conditions.push(`fabric_transaction_id = $${paramIdx++}`);
    params.push(options.transactionId);
  }

  if (options.fromTime) {
    conditions.push(`event_time >= $${paramIdx++}`);
    params.push(options.fromTime);
  }

  if (options.toTime) {
    conditions.push(`event_time <= $${paramIdx++}`);
    params.push(options.toTime);
  }

  if (options.excludeRedacted !== false) {
    conditions.push(`(decision_status IS NULL OR decision_status != 'REDACTED')`);
  }

  const where = conditions.join(' AND ');
  const limit = options.limit ?? 50;
  const offset = options.offset ?? 0;

  const result = await client.query<NCE>(
    `SELECT * FROM normalized_context_events
     WHERE ${where}
     ORDER BY event_time DESC
     LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
    [...params, limit, offset]
  );
  return result.rows;
}

/**
 * Gets a single NCE by its ID.
 */
export async function getContextEvent(
  client: PoolClient,
  tenantId: string,
  nceId: string
): Promise<NCE | null> {
  const result = await client.query<NCE>(
    'SELECT * FROM normalized_context_events WHERE tenant_id = $1 AND id = $2',
    [tenantId, nceId]
  );
  return result.rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Context Pods
// ---------------------------------------------------------------------------

/**
 * Gets an active context pod for a focal entity.
 */
export async function getContextPod(
  client: PoolClient,
  tenantId: string,
  focalEntityType: string,
  focalEntityId: string,
  modeId?: string
): Promise<ContextPod | null> {
  const params: unknown[] = [tenantId, focalEntityType, focalEntityId];
  let modeClause = 'AND mode_id IS NULL';
  if (modeId) {
    modeClause = 'AND mode_id = $4';
    params.push(modeId);
  }

  const result = await client.query<ContextPod>(
    `SELECT * FROM context_pods
     WHERE tenant_id = $1
       AND focal_entity_type = $2
       AND focal_entity_id = $3
       AND is_active = TRUE
       ${modeClause}
     ORDER BY created_at DESC
     LIMIT 1`,
    params
  );
  return result.rows[0] ?? null;
}

/**
 * Gets the current version of a context pod.
 */
export async function getPodCurrentVersion(
  client: PoolClient,
  tenantId: string,
  podId: string
): Promise<ContextPodVersion | null> {
  const result = await client.query<ContextPodVersion>(
    `SELECT v.*
     FROM context_pod_versions v
     JOIN context_pods p ON p.current_version_id = v.id
     WHERE p.tenant_id = $1 AND p.id = $2`,
    [tenantId, podId]
  );
  return result.rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Audit Trace
// ---------------------------------------------------------------------------

/**
 * Reconstructs the full audit trace for a transaction.
 * Returns all pod runs, versions, and evidence refs associated with a
 * transaction_id.
 */
export async function getAuditTraceByTransaction(
  client: PoolClient,
  tenantId: string,
  transactionId: string
): Promise<AuditTraceRow[]> {
  const result = await client.query<AuditTraceRow>(
    `SELECT * FROM context_audit_trace_v
     WHERE tenant_id = $1 AND transaction_id = $2
     ORDER BY run_started_at DESC`,
    [tenantId, transactionId]
  );
  return result.rows;
}

/**
 * Reconstructs the full audit trace for a pod (all versions and runs).
 */
export async function getAuditTraceByPod(
  client: PoolClient,
  tenantId: string,
  podId: string
): Promise<AuditTraceRow[]> {
  const result = await client.query<AuditTraceRow>(
    `SELECT * FROM context_audit_trace_v
     WHERE tenant_id = $1 AND pod_id = $2
     ORDER BY run_started_at DESC`,
    [tenantId, podId]
  );
  return result.rows;
}

/**
 * Reconstructs the audit trace for a specific retrieval receipt hash.
 * Useful for tracing which pod assembly produced a given receipt.
 */
export async function getAuditTraceByReceiptHash(
  client: PoolClient,
  tenantId: string,
  receiptHash: string
): Promise<AuditTraceRow | null> {
  const result = await client.query<AuditTraceRow>(
    `SELECT * FROM context_audit_trace_v
     WHERE tenant_id = $1 AND retrieval_receipt_hash = $2
     LIMIT 1`,
    [tenantId, receiptHash]
  );
  return result.rows[0] ?? null;
}

/**
 * Gets all audit trace rows associated with a seeding job (backfill batch).
 * Useful for auditing what a seeding run contributed to pod evidence.
 */
export async function getAuditTraceByBackfillBatch(
  client: PoolClient,
  tenantId: string,
  backfillBatchId: string
): Promise<AuditTraceRow[]> {
  const result = await client.query<AuditTraceRow>(
    `SELECT * FROM context_audit_trace_v
     WHERE tenant_id = $1
       AND version_created_by_backfill_batch_id = $2
     ORDER BY run_started_at DESC`,
    [tenantId, backfillBatchId]
  );
  return result.rows;
}

// ---------------------------------------------------------------------------
// Boundary Plans
// ---------------------------------------------------------------------------

/**
 * Looks up a cached boundary plan by hash.
 * Returns null if not found or expired.
 */
export async function getBoundaryPlanByHash(
  client: PoolClient,
  tenantId: string,
  planHash: string
): Promise<ContextBoundaryPlan | null> {
  const result = await client.query<ContextBoundaryPlan>(
    `SELECT * FROM context_boundary_plans
     WHERE tenant_id = $1
       AND plan_hash = $2
       AND expires_at > NOW()
     ORDER BY created_at DESC
     LIMIT 1`,
    [tenantId, planHash]
  );
  return result.rows[0] ?? null;
}

/**
 * Gets boundary plans that terminated early for analytics.
 */
export async function getEarlyTerminationStats(
  client: PoolClient,
  tenantId: string,
  options: { fromTime?: Date; limit?: number } = {}
): Promise<{
  operational_frame: string;
  count: number;
  avg_sufficiency_score: number;
  avg_sources_eligible: number;
}[]> {
  const params: unknown[] = [tenantId];
  let timeClause = '';
  if (options.fromTime) {
    timeClause = 'AND created_at >= $2';
    params.push(options.fromTime);
  }

  const result = await client.query(
    `SELECT
       operational_frame,
       COUNT(*) AS count,
       ROUND(AVG(final_sufficiency_score)::numeric, 3) AS avg_sufficiency_score,
       ROUND(AVG(array_length(eligible_sources, 1))::numeric, 1) AS avg_sources_eligible
     FROM context_boundary_plans
     WHERE tenant_id = $1
       AND terminated_early = TRUE
       ${timeClause}
     GROUP BY operational_frame
     ORDER BY count DESC
     LIMIT $${params.length + 1}`,
    [...params, options.limit ?? 20]
  );
  return result.rows;
}
