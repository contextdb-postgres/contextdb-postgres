/**
 * ContextDB TypeScript Types
 * Governed Context Database for Enterprise AI
 *
 * Canonical type definitions for the ContextDB schema.
 * These types mirror the SQL schema exactly — use them for type-safe inserts and queries.
 *
 * @license Apache-2.0
 */

// ---------------------------------------------------------------------------
// Source Systems
// ---------------------------------------------------------------------------

export type SourceSystemCategory =
  | 'CRM'
  | 'EMAIL'
  | 'CALENDAR'
  | 'SOCIAL'
  | 'DOCUMENT'
  | 'COLLAB'
  | 'ITSM'
  | 'DEVTOOLS'
  | 'SUPPORT'
  | 'HRIS'
  | 'OTHER';

export interface SourceSystem {
  id: string;
  label: string;
  category: SourceSystemCategory;
  active: boolean;
  created_at: Date;
}

// ---------------------------------------------------------------------------
// Normalized Context Event (NCE) — the ECL record
// ---------------------------------------------------------------------------

export type NCEOriginType =
  | 'fabric_observed'
  | 'historical_backfill'
  | 'synthetic_fixture'
  | 'imported_summary';

export type NCEDecisionStatus =
  | 'ALLOWED'
  | 'DENIED'
  | 'HELD'
  | 'REDACTED'
  | 'ESCALATED';

export interface NCEParticipant {
  role: string;
  name?: string;
  email?: string;
  user_id?: string;
  account_id?: string;
  contact_id?: string;
  title?: string;
  [key: string]: unknown;
}

export interface NCEContent {
  object_type?: string;
  summary?: string;
  subject?: string;
  description?: string;
  [key: string]: unknown;
}

export interface NCEProvenance {
  source_uri?: string;
  principal_id?: string;
  source_permission_model?: string;
  acl_snapshot_hash?: string;
  backfill_batch_id?: string;
  [key: string]: unknown;
}

/** A normalized context event — the fundamental ECL record */
export interface NCE {
  id: string;
  tenant_id: string;
  schema_version: string;

  // Source
  source_system: string;
  source_event_id: string;
  source_object?: string;

  // Event
  event_type: string;
  event_time: Date;

  // Content (JSONB — flexible)
  participants: NCEParticipant[];
  content: NCEContent;
  entity_refs?: Record<string, unknown>;

  // Provenance
  provenance_ingested_at: Date;
  provenance_connector_id?: string;
  provenance_raw_event_hash?: string;
  provenance_thread_id?: string;

  // Governance
  origin_type: NCEOriginType;
  decision_status?: NCEDecisionStatus;
  policy_refs: string[];
  mode_id?: string;
  fabric_transaction_id?: string;
  redacted_at?: Date;
  redaction_reason?: string;

  created_at: Date;
  processed_at?: Date;
}

/** Input type for writing a new NCE */
export type NewNCE = Omit<NCE, 'id' | 'created_at' | 'provenance_ingested_at'> & {
  id?: string;
  provenance_ingested_at?: Date;
};

// ---------------------------------------------------------------------------
// Context Pod
// ---------------------------------------------------------------------------

export type ScopeType = 'TENANT' | 'GROUP' | 'ROLE' | 'BUSINESS_UNIT';

export interface ContextPod {
  id: string;
  tenant_id: string;
  focal_entity_type: string;
  focal_entity_id: string;
  focal_entity_name?: string;

  assembly_trigger?: string;
  assembly_duration_ms?: number;
  assembled_at?: Date;
  valid_until?: Date;
  stale_after?: Date;
  context?: Record<string, unknown>;
  sources?: Record<string, unknown>;

  mode_id?: string;
  scope_type: ScopeType;
  scope_key?: string;
  title?: string;
  created_by?: string;
  current_version_id?: string;
  is_active: boolean;

  created_at: Date;
}

// ---------------------------------------------------------------------------
// Context Pod Version (immutable snapshot)
// ---------------------------------------------------------------------------

export type CompletenessStatus =
  | 'SUFFICIENT'
  | 'INSUFFICIENT'
  | 'PARTIAL'
  | 'PENDING_EVIDENCE';

export interface ContextPodVersion {
  id: string;
  tenant_id: string;
  pod_id: string;
  version_number: number;

  // Hash chain
  pod_hash: string;
  prev_version_hash?: string;
  policy_hash?: string;
  evidence_set_hash?: string;
  retrieval_receipt_hash?: string;

  // Correlation refs (NOT identity)
  created_by_transaction_id?: string;
  created_by_backfill_batch_id?: string;

  // Completeness
  completeness_status?: CompletenessStatus;
  confidence_requirement?: string;
  source_policy?: string;
  freshness_requirement?: string;
  manual_review_required: boolean;

  created_at: Date;
}

// ---------------------------------------------------------------------------
// Context Pod Assembly Run
// ---------------------------------------------------------------------------

export type AssemblyTriggerType =
  | 'ON_DEMAND'
  | 'SCHEDULED'
  | 'EVENT_DRIVEN'
  | 'BACKFILL_SEED'
  | 'PREFETCH'
  | 'RECOMPUTE';

export type AssemblyRunStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export interface ContextPodAssemblyRun {
  id: string;
  tenant_id: string;
  pod_id: string;

  // Correlation (NOT identity)
  transaction_id?: string;
  mode_id?: string;
  job_to_be_done?: string;
  requested_by?: string;

  trigger_type: AssemblyTriggerType;
  status: AssemblyRunStatus;

  produced_version_id?: string;
  retrieval_receipt_hash?: string;
  adaptation_reasons?: Record<string, unknown>;
  error?: string;

  started_at: Date;
  completed_at?: Date;
}

// ---------------------------------------------------------------------------
// Context Pod Evidence Ref
// ---------------------------------------------------------------------------

export type ArtifactType =
  | 'NCE'
  | 'RETRIEVAL_RECEIPT'
  | 'CONTEXT_PLAN'
  | 'OUTCOME_TELEMETRY'
  | 'CFA_RECEIPT'
  | 'EXTERNAL_REFERENCE'
  | 'BACKFILL_RECORD';

export type EvidenceRole =
  | 'PRIMARY'
  | 'SUPPORTING'
  | 'CONTRADICTING'
  | 'AUDIT_ONLY'
  | 'NOT_PROVEN';

export type EvidenceStatus = 'ACTIVE' | 'STALE' | 'REVOKED' | 'REDACTED';
export type TemperatureTier = 'HOT' | 'WARM' | 'COOL' | 'COLD' | 'ARCHIVED';

export interface ContextPodEvidenceRef {
  id: string;
  tenant_id: string;
  pod_id: string;
  pod_version_id: string;

  artifact_type: ArtifactType;
  artifact_id: string;
  nce_id?: string;
  source_system?: string;
  source_event_id?: string;
  source_uri?: string;

  evidence_role?: EvidenceRole;
  evidence_status: EvidenceStatus;
  temperature_tier?: TemperatureTier;

  provenance_hash?: string;

  // Correlation refs (NOT identity)
  included_by_transaction_id?: string;
  included_by_backfill_batch_id?: string;

  created_at: Date;
}

// ---------------------------------------------------------------------------
// Context Boundary Plan
// ---------------------------------------------------------------------------

export type CanopyDecision =
  | 'REUSED_TRUST'
  | 'STEP_UP_REQUIRED'
  | 'APPROVAL_REQUIRED'
  | 'DENIED'
  | 'BLOCKED_CERTIFICATION_DRIFT'
  | 'NOT_EVALUATED';

export type AuthorityLevel = 'ADMIN' | 'OWNER' | 'CONTRIBUTOR' | 'VIEWER' | 'NONE';
export type TemporalMode = 'OPERATIONAL' | 'HISTORICAL' | 'COMPLIANCE' | 'HYBRID';

export interface ContextBoundaryPlan {
  id: string;
  tenant_id: string;
  plan_hash: string;
  mode_id?: string;
  principal_id?: string;
  operational_frame: string;

  canopy_decision: CanopyDecision;
  authority_level: AuthorityLevel;
  temporal_mode: TemporalMode;

  eligible_sources: string[];
  forbidden_sources: string[];
  required_categories: string[];

  sufficiency_threshold: number;
  terminated_early: boolean;
  termination_reason?: string;
  satisfied_categories?: string[];
  missing_categories?: string[];
  final_sufficiency_score?: number;

  plan_json: Record<string, unknown>;

  created_at: Date;
  expires_at: Date;
  used_by_receipt_hash?: string;
}

// ---------------------------------------------------------------------------
// ECL Seeding
// ---------------------------------------------------------------------------

export type SeedJobStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'PAUSED'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export type SeedMode =
  | 'DAY_ZERO_FORWARD_ONLY'
  | 'LIMITED_LOOKBACK'
  | 'FULL_HISTORICAL_BACKFILL'
  | 'KNOWLEDGE_BASE_BOOTSTRAP';

export type AclSnapshotStrategy =
  | 'SOURCE_PERMISSION_REF'
  | 'ACL_HASH_ONLY'
  | 'ACL_METADATA_COPY'
  | 'JIT_RECHECK_REQUIRED';

export interface SeedingJob {
  id: string;
  tenant_id: string;
  connector_id: string;
  object_types: string[];
  lookback_days: number;
  batch_size: number;
  status: SeedJobStatus;
  seed_mode: SeedMode;
  acl_snapshot_strategy: AclSnapshotStrategy;
  requested_by: string;
  approved_by?: string;
  business_unit_scope?: string;
  region_scope?: string;
  corporate_region?: 'AMER' | 'EMEA' | 'APAC' | 'GLOBAL';
  timezone?: string;
  respect_business_hours: boolean;
  off_peak_utc_start?: number;
  off_peak_utc_end?: number;
  max_records_per_run?: number;
  max_api_calls_per_hour?: number;
  max_duration_minutes?: number;
  pause_on_error_rate_percent: number;
  records_attempted: number;
  records_imported: number;
  records_skipped: number;
  records_denied: number;
  records_redacted: number;
  last_source_cursor?: SeedingCursor;
  dry_run: boolean;
  estimated_records?: number;
  estimated_api_calls?: number;
  estimated_duration_seconds?: number;
  error_message?: string;
  notes?: string;
  started_at?: Date;
  paused_at?: Date;
  completed_at?: Date;
  created_at: Date;
  updated_at: Date;
}

export interface SeedingCursor {
  cursor_type: string;
  opaque_token: string;
  captured_at: string;
  expires_at?: string;
  fallback_checkpoint?: {
    last_successful_id?: string;
    last_successful_timestamp?: string;
  };
}

export interface SeedingFingerprint {
  tenant_id: string;
  connector_id: string;
  source_event_id: string;
  source_updated_at?: Date;
  nce_id: string;
  backfill_batch_id: string;
  created_at: Date;
}

// ---------------------------------------------------------------------------
// Audit Trace View
// ---------------------------------------------------------------------------

export interface AuditTraceRow {
  pod_run_id: string;
  transaction_id?: string;
  trigger_type: AssemblyTriggerType;
  run_started_at: Date;
  run_completed_at?: Date;
  run_status: AssemblyRunStatus;
  mode_id?: string;
  job_to_be_done?: string;
  adaptation_reasons?: Record<string, unknown>;
  run_error?: string;

  pod_id: string;
  tenant_id: string;
  focal_entity_type: string;
  focal_entity_id: string;
  scope_type: ScopeType;
  scope_key?: string;
  pod_is_active: boolean;

  pod_version_id?: string;
  version_number?: number;
  pod_hash?: string;
  retrieval_receipt_hash?: string;
  completeness_status?: CompletenessStatus;
  confidence_requirement?: string;
  source_policy?: string;
  manual_review_required?: boolean;
  version_created_by_transaction_id?: string;
  version_created_by_backfill_batch_id?: string;

  evidence_refs: Array<{
    artifact_type: ArtifactType;
    artifact_id: string;
    nce_id?: string;
    source_system?: string;
    source_event_id?: string;
    evidence_role?: EvidenceRole;
    evidence_status: EvidenceStatus;
    temperature_tier?: TemperatureTier;
    provenance_hash?: string;
  }>;
}
