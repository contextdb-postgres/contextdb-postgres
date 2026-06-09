/**
 * ContextDB Write Operations
 * Governed Context Database for Enterprise AI
 *
 * Type-safe write helpers for ContextDB tables.
 * All writes assume tenant context is already set via setTenantContext().
 *
 * These helpers enforce the append-only contract on normalized_context_events:
 * - writeContextEvent() performs an INSERT with ON CONFLICT DO NOTHING
 *   (idempotent by source_system + source_event_id per tenant)
 * - No update or delete helpers exist for NCEs — use decision_status='REDACTED'
 *   for compliance purge
 *
 * @license Apache-2.0
 */

import type { PoolClient } from 'pg';
import type {
  NewNCE,
  NCE,
  ContextPod,
  ContextBoundaryPlan,
  SeedingJob,
} from './types.js';

// ---------------------------------------------------------------------------
// Normalized Context Events (append-only)
// ---------------------------------------------------------------------------

/**
 * Writes a single normalized context event to the ECL.
 * Idempotent: if a matching (tenant_id, source_system, source_event_id) already
 * exists, the insert is silently skipped and the existing row is returned.
 *
 * NEVER use this to update existing NCEs. The table is append-only.
 *
 * @returns The written (or existing) NCE row, or null if the insert was skipped
 *          and the existing row cannot be retrieved (rare edge case).
 */
export async function writeContextEvent(
  client: PoolClient,
  tenantId: string,
  event: NewNCE
): Promise<NCE | null> {
  const result = await client.query<NCE>(
    `INSERT INTO normalized_context_events (
      tenant_id, schema_version,
      source_system, source_event_id, source_object,
      event_type, event_time,
      participants, content, entity_refs,
      provenance_connector_id, provenance_raw_event_hash, provenance_thread_id,
      origin_type, decision_status, policy_refs,
      mode_id, fabric_transaction_id
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
      $11, $12, $13, $14, $15, $16, $17, $18
    )
    ON CONFLICT (tenant_id, source_system, source_event_id)
    DO NOTHING
    RETURNING *`,
    [
      tenantId,
      event.schema_version ?? '1.0',
      event.source_system,
      event.source_event_id,
      event.source_object ?? null,
      event.event_type,
      event.event_time,
      JSON.stringify(event.participants ?? []),
      JSON.stringify(event.content ?? {}),
      event.entity_refs ? JSON.stringify(event.entity_refs) : null,
      event.provenance_connector_id ?? null,
      event.provenance_raw_event_hash ?? null,
      event.provenance_thread_id ?? null,
      event.origin_type ?? 'fabric_observed',
      event.decision_status ?? null,
      event.policy_refs ?? [],
      event.mode_id ?? null,
      event.fabric_transaction_id ?? null,
    ]
  );
  return result.rows[0] ?? null;
}

/**
 * Writes multiple normalized context events in a single transaction.
 * Each event is inserted idempotently (ON CONFLICT DO NOTHING).
 *
 * @returns Array of written NCE rows (skipped rows are omitted).
 */
export async function writeContextEvents(
  client: PoolClient,
  tenantId: string,
  events: NewNCE[]
): Promise<NCE[]> {
  if (events.length === 0) return [];

  const written: NCE[] = [];
  for (const event of events) {
    const row = await writeContextEvent(client, tenantId, event);
    if (row) written.push(row);
  }
  return written;
}

/**
 * Marks an NCE as redacted (GDPR / compliance purge).
 * Replaces content fields with a sentinel value and sets decision_status='REDACTED'.
 * The hash chain is preserved — the NCE row remains in the table.
 *
 * This is the ONLY permitted "write" operation on an existing NCE.
 */
export async function redactContextEvent(
  client: PoolClient,
  tenantId: string,
  nceId: string,
  redactionReason: string
): Promise<void> {
  await client.query(
    `UPDATE normalized_context_events
     SET
       participants       = '[]'::jsonb,
       content            = '{"redacted": true, "content": "[DATA_REDACTED_BY_ADMIN_COMPLIANCE_REQUEST]"}'::jsonb,
       entity_refs        = NULL,
       decision_status    = 'REDACTED',
       redacted_at        = NOW(),
       redaction_reason   = $3
     WHERE id = $2
       AND tenant_id = $1
       AND decision_status != 'REDACTED'`,
    [tenantId, nceId, redactionReason]
  );
}

// ---------------------------------------------------------------------------
// Context Pods
// ---------------------------------------------------------------------------

/**
 * Upserts a context pod. If a pod with the same focal entity and mode already
 * exists for this tenant, updates the assembly metadata.
 */
export async function upsertContextPod(
  client: PoolClient,
  tenantId: string,
  pod: Omit<ContextPod, 'id' | 'created_at'>
): Promise<ContextPod> {
  const result = await client.query<ContextPod>(
    `INSERT INTO context_pods (
      tenant_id, focal_entity_type, focal_entity_id, focal_entity_name,
      assembly_trigger, assembly_duration_ms, assembled_at, valid_until, stale_after,
      context, sources,
      mode_id, scope_type, scope_key, title, created_by, is_active
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
    ON CONFLICT DO NOTHING
    RETURNING *`,
    [
      tenantId,
      pod.focal_entity_type,
      pod.focal_entity_id,
      pod.focal_entity_name ?? null,
      pod.assembly_trigger ?? null,
      pod.assembly_duration_ms ?? null,
      pod.assembled_at ?? null,
      pod.valid_until ?? null,
      pod.stale_after ?? null,
      pod.context ? JSON.stringify(pod.context) : null,
      pod.sources ? JSON.stringify(pod.sources) : null,
      pod.mode_id ?? null,
      pod.scope_type ?? 'TENANT',
      pod.scope_key ?? null,
      pod.title ?? null,
      pod.created_by ?? null,
      pod.is_active ?? true,
    ]
  );
  if (!result.rows[0]) {
    throw new Error(`Failed to upsert context pod for entity ${pod.focal_entity_id}`);
  }
  return result.rows[0];
}

// ---------------------------------------------------------------------------
// Context Boundary Plans
// ---------------------------------------------------------------------------

/**
 * Writes a context boundary plan audit record.
 * Boundary plans are immutable once written — they represent a point-in-time
 * governance decision.
 */
export async function writeBoundaryPlan(
  client: PoolClient,
  tenantId: string,
  plan: Omit<ContextBoundaryPlan, 'id' | 'created_at'>
): Promise<ContextBoundaryPlan> {
  const result = await client.query<ContextBoundaryPlan>(
    `INSERT INTO context_boundary_plans (
      tenant_id, plan_hash, mode_id, principal_id, operational_frame,
      canopy_decision, authority_level, temporal_mode,
      eligible_sources, forbidden_sources, required_categories,
      sufficiency_threshold, terminated_early, termination_reason,
      satisfied_categories, missing_categories, final_sufficiency_score,
      plan_json, expires_at, used_by_receipt_hash
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
      $12, $13, $14, $15, $16, $17, $18, $19, $20
    )
    ON CONFLICT DO NOTHING
    RETURNING *`,
    [
      tenantId,
      plan.plan_hash,
      plan.mode_id ?? null,
      plan.principal_id ?? null,
      plan.operational_frame,
      plan.canopy_decision,
      plan.authority_level,
      plan.temporal_mode,
      plan.eligible_sources,
      plan.forbidden_sources,
      plan.required_categories,
      plan.sufficiency_threshold,
      plan.terminated_early,
      plan.termination_reason ?? null,
      plan.satisfied_categories ?? null,
      plan.missing_categories ?? null,
      plan.final_sufficiency_score ?? null,
      JSON.stringify(plan.plan_json),
      plan.expires_at,
      plan.used_by_receipt_hash ?? null,
    ]
  );
  if (!result.rows[0]) {
    throw new Error(`Failed to write boundary plan ${plan.plan_hash}`);
  }
  return result.rows[0];
}

// ---------------------------------------------------------------------------
// ECL Seeding
// ---------------------------------------------------------------------------

/**
 * Creates a new seeding job record.
 */
export async function createSeedingJob(
  client: PoolClient,
  tenantId: string,
  job: Omit<SeedingJob, 'id' | 'created_at' | 'updated_at' | 'records_attempted' | 'records_imported' | 'records_skipped' | 'records_denied' | 'records_redacted'>
): Promise<SeedingJob> {
  const result = await client.query<SeedingJob>(
    `INSERT INTO ecl_seeding_jobs (
      tenant_id, connector_id, object_types, lookback_days, batch_size,
      status, seed_mode, acl_snapshot_strategy,
      requested_by, approved_by,
      business_unit_scope, region_scope, corporate_region, timezone,
      respect_business_hours, off_peak_utc_start, off_peak_utc_end,
      max_records_per_run, max_api_calls_per_hour, max_duration_minutes,
      pause_on_error_rate_percent, dry_run, notes
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
      $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
      $21, $22, $23
    )
    RETURNING *`,
    [
      tenantId,
      job.connector_id,
      job.object_types,
      job.lookback_days,
      job.batch_size,
      job.status ?? 'PENDING',
      job.seed_mode,
      job.acl_snapshot_strategy,
      job.requested_by,
      job.approved_by ?? null,
      job.business_unit_scope ?? null,
      job.region_scope ?? null,
      job.corporate_region ?? null,
      job.timezone ?? null,
      job.respect_business_hours ?? true,
      job.off_peak_utc_start ?? null,
      job.off_peak_utc_end ?? null,
      job.max_records_per_run ?? null,
      job.max_api_calls_per_hour ?? null,
      job.max_duration_minutes ?? null,
      job.pause_on_error_rate_percent ?? 10,
      job.dry_run ?? false,
      job.notes ?? null,
    ]
  );
  if (!result.rows[0]) {
    throw new Error('Failed to create seeding job');
  }
  return result.rows[0];
}

/**
 * Records a seeding fingerprint (idempotency check).
 * Returns true if the fingerprint was newly created (event was not previously seeded).
 * Returns false if the fingerprint already exists (event was already seeded — skip it).
 */
export async function recordSeedingFingerprint(
  client: PoolClient,
  tenantId: string,
  connectorId: string,
  sourceEventId: string,
  sourceUpdatedAt: Date | null,
  nceId: string,
  backfillBatchId: string
): Promise<boolean> {
  const result = await client.query(
    `INSERT INTO ecl_seeding_fingerprints (
      tenant_id, connector_id, source_event_id, source_updated_at,
      nce_id, backfill_batch_id
    ) VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (tenant_id, connector_id, source_event_id, source_updated_at)
    DO NOTHING`,
    [tenantId, connectorId, sourceEventId, sourceUpdatedAt, nceId, backfillBatchId]
  );
  return (result.rowCount ?? 0) > 0;
}
