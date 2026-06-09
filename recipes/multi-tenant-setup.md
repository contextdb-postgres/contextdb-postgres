# Recipe: Multi-Tenant Setup

This recipe shows how to configure ContextDB for a multi-tenant SaaS application.
All ContextDB tables use PostgreSQL Row-Level Security (RLS) with the `app.tenant_id`
session variable — no application-level tenant filtering is needed in queries.

## Architecture

```
Application Layer
├── Sets app.tenant_id before every query
└── Never passes tenant_id in query parameters (security)

PostgreSQL Layer
├── RLS policies on all tables
├── Each query automatically filtered by current tenant
└── Cross-tenant reads are impossible (PostgreSQL enforces it)
```

## Step 1: Apply the Schema

```bash
# Apply to your PostgreSQL database
psql $DATABASE_URL -f schema/001_core_ecl.sql
psql $DATABASE_URL -f schema/002_pod_identity.sql
psql $DATABASE_URL -f schema/003_boundary_plans.sql
psql $DATABASE_URL -f schema/004_seeding.sql
psql $DATABASE_URL -f schema/005_rls_templates.sql
```

## Step 2: Create a Database User for Your Application

```sql
-- Create a dedicated app user (not a superuser)
CREATE USER contextdb_app WITH PASSWORD 'your-password';

-- Grant permissions (no superuser privileges needed for normal operations)
GRANT CONNECT ON DATABASE your_database TO contextdb_app;
GRANT USAGE ON SCHEMA public TO contextdb_app;
GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA public TO contextdb_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO contextdb_app;

-- UPDATE only permitted on tables that allow it (not normalized_context_events)
GRANT UPDATE ON context_pods TO contextdb_app;
GRANT UPDATE ON context_pod_versions TO contextdb_app;
GRANT UPDATE ON context_pod_assembly_runs TO contextdb_app;
GRANT UPDATE ON context_pod_evidence_refs TO contextdb_app;
GRANT UPDATE ON ecl_seeding_jobs TO contextdb_app;
GRANT UPDATE ON context_boundary_plans TO contextdb_app;

-- DELETE for compliance purge (redact function uses UPDATE, not DELETE)
-- No DELETE grants needed for normal app operations

-- Allow executing helper functions
GRANT EXECUTE ON FUNCTION set_tenant_context(UUID) TO contextdb_app;
GRANT EXECUTE ON FUNCTION current_tenant_id() TO contextdb_app;
GRANT EXECUTE ON FUNCTION current_tenant_id_safe() TO contextdb_app;
```

## Step 3: Configure Your Connection Pool

```typescript
import { Pool } from 'pg';

// Never use a superuser connection for application queries
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // connection string should use contextdb_app credentials, not postgres superuser
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 2_000,
  statement_timeout: 30_000, // Required: prevent runaway queries
});
```

## Step 4: Tenant Context Middleware

In your API framework, set tenant context from the JWT before any database access:

```typescript
// Express middleware example
async function tenantContextMiddleware(req, res, next) {
  // CRITICAL: tenant_id MUST come from JWT — never from request body or headers
  const tenantId = req.auth?.tenantId;

  if (!tenantId) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  // Attach to request for downstream use
  req.tenantId = tenantId;
  next();
}

// Fastify hook example
fastify.addHook('preHandler', async (request, reply) => {
  // Reject attempts to override tenant via request
  if (request.body?.tenant_id || request.headers['x-tenant-id']) {
    return reply.status(403).send({
      error: 'tenant_id must come from JWT, not request body or headers',
    });
  }

  request.tenantId = request.auth?.tenantId;
});
```

## Step 5: Use the ContextDB Client

```typescript
import { createContextDBClient } from 'contextdb-postgres';

const db = createContextDBClient({
  connectionString: process.env.DATABASE_URL,
});

// In your route handler:
app.post('/v1/context/events', async (req, res) => {
  const { tenantId } = req; // From JWT middleware — never from req.body

  const event = await db.writeContextEvent(tenantId, {
    source_system: req.body.source_system,
    source_event_id: req.body.source_event_id,
    event_type: req.body.event_type,
    event_time: new Date(req.body.event_time),
    participants: req.body.participants,
    content: req.body.content,
    origin_type: 'fabric_observed',
  });

  res.json({ id: event?.id });
});
```

## Step 6: Verify Tenant Isolation

Test that RLS is working correctly:

```typescript
async function verifyTenantIsolation(
  db: ContextDBClient,
  tenantA: string,
  tenantB: string
): Promise<void> {
  // Write event for tenant A
  await db.writeContextEvent(tenantA, {
    source_system: 'SALESFORCE',
    source_event_id: 'isolation-test-001',
    event_type: 'TEST_EVENT',
    event_time: new Date(),
    participants: [],
    content: { message: 'This belongs to tenant A only' },
  });

  // Query as tenant B — should return empty
  const events = await db.queryContextEvents(tenantB, {
    sourceSystem: 'SALESFORCE',
  });

  const leaked = events.find(e => e.source_event_id === 'isolation-test-001');
  if (leaked) {
    throw new Error('CRITICAL: Tenant isolation failure — cross-tenant read succeeded');
  }

  console.log('Tenant isolation verified: cross-tenant read returned 0 rows');
}
```

## Step 7: Connection Pooling at Scale

For high-throughput multi-tenant deployments, use PgBouncer in transaction mode:

```
# pgbouncer.ini
[databases]
contextdb = host=postgres port=5432 dbname=contextdb

[pgbouncer]
pool_mode = transaction          # Transaction pooling — allows set_config per transaction
max_client_conn = 1000
default_pool_size = 20
reserve_pool_size = 5
```

> **Important:** Use `transaction` pool mode, not `session` mode.
> `session` mode caches the session variable across connections, which can leak
> tenant context between requests.

## Tenant Onboarding

When a new tenant is created in your system:

```typescript
async function onboardTenant(
  superuserPool: Pool,
  tenantId: string
): Promise<void> {
  // No schema changes needed — RLS handles isolation automatically
  // Just ensure the tenant ID is a valid UUID

  // Optionally: seed initial source system registry entries
  // (already done by 001_core_ecl.sql — no action needed)

  // Optionally: create initial seeding jobs for connected data sources
  const client = await superuserPool.connect();
  try {
    // The tenant is ready to use immediately — no additional provisioning needed
    console.log(`Tenant ${tenantId} onboarded — RLS isolation is automatic`);
  } finally {
    client.release();
  }
}
```

## Security Checklist

- [ ] Application database user is NOT a superuser
- [ ] `tenant_id` is always extracted from JWT, never from request parameters
- [ ] RLS is enabled on all tables (verified with `SELECT relrowsecurity FROM pg_class WHERE relname = 'normalized_context_events'`)
- [ ] `set_config('app.tenant_id', ...)` is called before every tenant-scoped query
- [ ] Connection pool uses `transaction` mode if using PgBouncer
- [ ] `statement_timeout` is set to prevent runaway queries
- [ ] No raw error details are returned in HTTP responses (use generic error messages)
- [ ] Cross-tenant isolation is tested in CI (`verifyTenantIsolation()`)
