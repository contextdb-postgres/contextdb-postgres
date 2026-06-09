/**
 * ContextDB Client
 * Governed Context Database for Enterprise AI
 *
 * A lightweight client wrapper that combines pool management, tenant context,
 * and all ContextDB read/write operations into a single ergonomic interface.
 *
 * @license Apache-2.0
 */

import { Pool } from 'pg';
import { setTenantContext, withTenantContext, withTenantTransaction } from './tenant.js';
import {
  writeContextEvent,
  writeContextEvents,
  redactContextEvent,
  upsertContextPod,
  writeBoundaryPlan,
  createSeedingJob,
  recordSeedingFingerprint,
} from './write.js';
import {
  queryContextEvents,
  getContextEvent,
  getContextPod,
  getPodCurrentVersion,
  getAuditTraceByTransaction,
  getAuditTraceByPod,
  getAuditTraceByReceiptHash,
  getAuditTraceByBackfillBatch,
  getBoundaryPlanByHash,
  getEarlyTerminationStats,
} from './read.js';
import type {
  NewNCE,
  NCE,
  ContextPod,
  ContextBoundaryPlan,
  SeedingJob,
  AuditTraceRow,
} from './types.js';
import type { QueryContextEventsOptions } from './read.js';
import type { PoolClient } from 'pg';

export interface ContextDBClientOptions {
  /** PostgreSQL connection string */
  connectionString: string;
  /** Maximum pool size (default: 10) */
  poolMax?: number;
  /** Connection timeout in ms (default: 30000) */
  connectionTimeoutMillis?: number;
  /** Statement timeout in ms (default: 30000) */
  statementTimeout?: number;
}

/**
 * ContextDB Client
 *
 * Provides a tenant-aware interface for all ContextDB operations.
 *
 * @example
 * ```typescript
 * const db = new ContextDBClient({
 *   connectionString: process.env.DATABASE_URL,
 * });
 *
 * // Write a context event
 * const event = await db.writeContextEvent(tenantId, {
 *   source_system: 'SALESFORCE',
 *   source_event_id: 'sf-case-001',
 *   event_type: 'CASE_ESCALATED',
 *   event_time: new Date(),
 *   participants: [{ role: 'customer', name: 'Jordan Chen' }],
 *   content: { subject: 'Latency issue', priority: 'Critical' },
 * });
 *
 * // Query context events
 * const events = await db.queryContextEvents(tenantId, {
 *   sourceSystem: 'SALESFORCE',
 *   eventType: 'CASE_ESCALATED',
 * });
 *
 * // Get audit trace
 * const trace = await db.getAuditTraceByTransaction(tenantId, transactionId);
 *
 * await db.end();
 * ```
 */
export class ContextDBClient {
  private pool: Pool;

  constructor(options: ContextDBClientOptions) {
    this.pool = new Pool({
      connectionString: options.connectionString,
      max: options.poolMax ?? 10,
      connectionTimeoutMillis: options.connectionTimeoutMillis ?? 30_000,
      statement_timeout: options.statementTimeout ?? 30_000,
    });
  }

  /** Close the connection pool */
  async end(): Promise<void> {
    await this.pool.end();
  }

  /** Low-level: execute a function with a tenant-scoped client */
  async withClient<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return withTenantContext(this.pool, tenantId, fn);
  }

  /** Low-level: execute a function within a tenant-scoped transaction */
  async withTransaction<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return withTenantTransaction(this.pool, tenantId, fn);
  }

  // ---------------------------------------------------------------------------
  // Context Events (ECL)
  // ---------------------------------------------------------------------------

  async writeContextEvent(tenantId: string, event: NewNCE): Promise<NCE | null> {
    return this.withClient(tenantId, (c) => writeContextEvent(c, tenantId, event));
  }

  async writeContextEvents(tenantId: string, events: NewNCE[]): Promise<NCE[]> {
    return this.withClient(tenantId, (c) => writeContextEvents(c, tenantId, events));
  }

  async redactContextEvent(tenantId: string, nceId: string, reason: string): Promise<void> {
    return this.withClient(tenantId, (c) => redactContextEvent(c, tenantId, nceId, reason));
  }

  async queryContextEvents(
    tenantId: string,
    options?: QueryContextEventsOptions
  ): Promise<NCE[]> {
    return this.withClient(tenantId, (c) => queryContextEvents(c, tenantId, options));
  }

  async getContextEvent(tenantId: string, nceId: string): Promise<NCE | null> {
    return this.withClient(tenantId, (c) => getContextEvent(c, tenantId, nceId));
  }

  // ---------------------------------------------------------------------------
  // Context Pods
  // ---------------------------------------------------------------------------

  async upsertContextPod(
    tenantId: string,
    pod: Omit<ContextPod, 'id' | 'created_at'>
  ): Promise<ContextPod> {
    return this.withClient(tenantId, (c) => upsertContextPod(c, tenantId, pod));
  }

  async getContextPod(
    tenantId: string,
    focalEntityType: string,
    focalEntityId: string,
    modeId?: string
  ): Promise<ContextPod | null> {
    return this.withClient(tenantId, (c) =>
      getContextPod(c, tenantId, focalEntityType, focalEntityId, modeId)
    );
  }

  async getPodCurrentVersion(tenantId: string, podId: string) {
    return this.withClient(tenantId, (c) => getPodCurrentVersion(c, tenantId, podId));
  }

  // ---------------------------------------------------------------------------
  // Audit Trace
  // ---------------------------------------------------------------------------

  async getAuditTraceByTransaction(
    tenantId: string,
    transactionId: string
  ): Promise<AuditTraceRow[]> {
    return this.withClient(tenantId, (c) =>
      getAuditTraceByTransaction(c, tenantId, transactionId)
    );
  }

  async getAuditTraceByPod(tenantId: string, podId: string): Promise<AuditTraceRow[]> {
    return this.withClient(tenantId, (c) => getAuditTraceByPod(c, tenantId, podId));
  }

  async getAuditTraceByReceiptHash(
    tenantId: string,
    receiptHash: string
  ): Promise<AuditTraceRow | null> {
    return this.withClient(tenantId, (c) =>
      getAuditTraceByReceiptHash(c, tenantId, receiptHash)
    );
  }

  async getAuditTraceByBackfillBatch(
    tenantId: string,
    backfillBatchId: string
  ): Promise<AuditTraceRow[]> {
    return this.withClient(tenantId, (c) =>
      getAuditTraceByBackfillBatch(c, tenantId, backfillBatchId)
    );
  }

  // ---------------------------------------------------------------------------
  // Boundary Plans
  // ---------------------------------------------------------------------------

  async writeBoundaryPlan(
    tenantId: string,
    plan: Omit<ContextBoundaryPlan, 'id' | 'created_at'>
  ): Promise<ContextBoundaryPlan> {
    return this.withClient(tenantId, (c) => writeBoundaryPlan(c, tenantId, plan));
  }

  async getBoundaryPlanByHash(
    tenantId: string,
    planHash: string
  ): Promise<ContextBoundaryPlan | null> {
    return this.withClient(tenantId, (c) => getBoundaryPlanByHash(c, tenantId, planHash));
  }

  async getEarlyTerminationStats(tenantId: string, options?: { fromTime?: Date; limit?: number }) {
    return this.withClient(tenantId, (c) => getEarlyTerminationStats(c, tenantId, options));
  }

  // ---------------------------------------------------------------------------
  // Seeding
  // ---------------------------------------------------------------------------

  async createSeedingJob(
    tenantId: string,
    job: Omit<SeedingJob, 'id' | 'created_at' | 'updated_at' | 'records_attempted' | 'records_imported' | 'records_skipped' | 'records_denied' | 'records_redacted'>
  ): Promise<SeedingJob> {
    return this.withClient(tenantId, (c) => createSeedingJob(c, tenantId, job));
  }

  async recordSeedingFingerprint(
    tenantId: string,
    connectorId: string,
    sourceEventId: string,
    sourceUpdatedAt: Date | null,
    nceId: string,
    backfillBatchId: string
  ): Promise<boolean> {
    return this.withClient(tenantId, (c) =>
      recordSeedingFingerprint(
        c, tenantId, connectorId, sourceEventId, sourceUpdatedAt, nceId, backfillBatchId
      )
    );
  }
}

/**
 * Creates a ContextDB client from environment variables.
 *
 * Required env vars:
 *   DATABASE_URL — PostgreSQL connection string
 *
 * Optional:
 *   CONTEXTDB_POOL_MAX — max pool connections (default: 10)
 *   CONTEXTDB_STATEMENT_TIMEOUT — statement timeout ms (default: 30000)
 */
export function createContextDBClient(overrides?: Partial<ContextDBClientOptions>): ContextDBClient {
  const connectionString = overrides?.connectionString ?? process.env['DATABASE_URL'];
  if (!connectionString) {
    throw new Error(
      'ContextDB: DATABASE_URL environment variable is required. ' +
      'Pass connectionString explicitly or set DATABASE_URL.'
    );
  }

  return new ContextDBClient({
    connectionString,
    poolMax: overrides?.poolMax ?? parseInt(process.env['CONTEXTDB_POOL_MAX'] ?? '10', 10),
    statementTimeout: overrides?.statementTimeout ??
      parseInt(process.env['CONTEXTDB_STATEMENT_TIMEOUT'] ?? '30000', 10),
  });
}
