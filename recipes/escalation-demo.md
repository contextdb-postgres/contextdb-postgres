# Recipe: Enterprise Escalation Demo

This recipe walks through the ContextDB partner demo scenario — a support escalation
that shows governed context retrieval, early termination, source exclusion, and live
permission revocation.

This is the 15-minute demo scenario for showing enterprise buyers what governed
context retrieval looks like in practice.

## Scenario

> "What do I need to know before responding to the Acme Corp escalation?"

The system assembles context from multiple sources, stops at sufficiency 0.83
(threshold 0.80), excludes two sources for governance reasons, and shows the full
audit trail.

## Setup

Apply the schema and seed the demo data:

```bash
psql $DATABASE_URL -f schema/001_core_ecl.sql
psql $DATABASE_URL -f schema/002_pod_identity.sql
psql $DATABASE_URL -f schema/003_boundary_plans.sql
psql $DATABASE_URL -f schema/004_seeding.sql
```

```typescript
import { createContextDBClient } from 'contextdb-postgres';

const db = createContextDBClient({
  connectionString: process.env.DATABASE_URL,
});

const DEMO_TENANT_ID = '00000000-0000-0000-0000-000000000001';
```

## Step 1: Seed Demo Events

```typescript
// Salesforce escalation events
await db.writeContextEvents(DEMO_TENANT_ID, [
  {
    source_system: 'SALESFORCE',
    source_event_id: 'sf-case-00124891',
    event_type: 'CASE_ESCALATED',
    event_time: new Date('2026-06-07T14:22:00Z'),
    participants: [
      { role: 'customer', name: 'Jordan Chen', email: 'jordan.chen@acme.example', title: 'VP Engineering' },
      { role: 'support_agent', name: 'Priya Mehta', email: 'priya.mehta@company.example' },
    ],
    content: {
      case_number: '00124891',
      subject: 'Critical: Context assembly latency degraded since June 4 deployment',
      priority: 'Critical',
      status: 'Escalated',
      account_name: 'Acme Corp',
    },
    origin_type: 'fabric_observed',
    decision_status: 'ALLOWED',
    policy_refs: ['SOURCE_PERMISSION_VERIFIED'],
  },
  {
    source_system: 'SALESFORCE',
    source_event_id: 'sf-opp-acme-renewal-stage-change-001',
    event_type: 'OPPORTUNITY_STAGE_CHANGED',
    event_time: new Date('2026-06-07T15:10:00Z'),
    participants: [
      { role: 'account_executive', name: 'Marcus Williams' },
    ],
    content: {
      opportunity_name: 'Acme Corp — Enterprise Renewal FY2026',
      stage_from: 'Negotiation/Review',
      stage_to: 'At Risk',
      amount: 485000,
      probability: 55,
    },
    origin_type: 'fabric_observed',
    decision_status: 'ALLOWED',
  },
]);

// ServiceNow incident (prior resolution — same root cause)
await db.writeContextEvent(DEMO_TENANT_ID, {
  source_system: 'SERVICENOW',
  source_event_id: 'snow-inc-0098203-resolved',
  event_type: 'INCIDENT_RESOLVED',
  event_time: new Date('2025-11-12T09:00:00Z'),
  participants: [
    { role: 'resolver', name: 'Dev Patel', title: 'SRE Lead' },
  ],
  content: {
    incident_number: 'INC0098203',
    root_cause: 'Cache key format changed in prior deployment — 100% cache miss rate',
    resolution: 'Restore cache key format and run warmup job',
    prior_resolution_similarity: 0.91,
  },
  origin_type: 'historical_backfill',
  decision_status: 'ALLOWED',
  policy_refs: ['ADMIN_SEED_APPROVED'],
});
```

## Step 2: Assemble Context (with Early Termination)

```typescript
async function assembleEscalationContext(
  tenantId: string,
  principalId: string,
  sfAccessRevoked = false
): Promise<{
  events: NCE[];
  boundaryProvenance: {
    sourcesIncluded: string[];
    sourcesExcluded: Array<{ source: string; reason: string; detail: string }>;
    sufficiencyScore: number;
    sufficiencyThreshold: number;
    terminatedEarly: boolean;
    terminationReason: string;
  };
}> {
  const THRESHOLD = 0.80;
  let score = 0;
  const included: string[] = [];
  const excluded: Array<{ source: string; reason: string; detail: string }> = [];
  const events: NCE[] = [];

  // Source pipeline in priority order
  const sources = [
    {
      system: 'SALESFORCE',
      check: () => !sfAccessRevoked,
      exclusionReason: 'PERMISSION_REVOKED',
      exclusionDetail: 'Access revoked by administrator',
    },
    {
      system: 'SERVICENOW',
      check: () => true,
      exclusionReason: null,
      exclusionDetail: null,
    },
    {
      system: 'SLACK',
      check: () => true,
      exclusionReason: null,
      exclusionDetail: null,
    },
    {
      system: 'GOOGLE_DRIVE',
      check: () => false,
      exclusionReason: 'COLD_TIER',
      exclusionDetail: 'Last relevant document modified 94 days ago — below freshness threshold',
    },
    {
      system: 'LINKEDIN_SIGNAL',
      check: () => false,
      exclusionReason: 'POLICY_DENIED',
      exclusionDetail: 'LinkedIn connector not authorized for this tenant',
    },
  ];

  for (const source of sources) {
    // Sufficiency gate: stop when threshold is met
    if (score >= THRESHOLD) break;

    // Permission / policy check
    if (!source.check()) {
      excluded.push({
        source: source.system,
        reason: source.exclusionReason!,
        detail: source.exclusionDetail!,
      });
      continue;
    }

    // Retrieve from source
    const sourceEvents = await db.queryContextEvents(tenantId, {
      sourceSystem: source.system,
      decisionStatus: 'ALLOWED',
      limit: 5,
    });

    if (sourceEvents.length > 0) {
      events.push(...sourceEvents);
      included.push(source.system);
      score = Math.min(0.95, score + sourceEvents.length * 0.25);
    }
  }

  const terminatedEarly = score >= THRESHOLD && included.length < sources.length;

  return {
    events,
    boundaryProvenance: {
      sourcesIncluded: included,
      sourcesExcluded: excluded,
      sufficiencyScore: Math.round(score * 100) / 100,
      sufficiencyThreshold: THRESHOLD,
      terminatedEarly,
      terminationReason: terminatedEarly
        ? `Sufficiency gate fired after ${included.length} sources — ${excluded.length + (sources.length - included.length - excluded.length)} queued sources not fetched`
        : 'All permitted sources checked',
    },
  };
}
```

## Step 3: Demo Moment 1 — Sufficiency Gate

```typescript
// First assembly: normal state
const result1 = await assembleEscalationContext(DEMO_TENANT_ID, 'priya.mehta@company.example');

console.log('Sources reviewed:', result1.boundaryProvenance.sourcesIncluded);
// → ['SALESFORCE', 'SERVICENOW', 'SLACK']

console.log('Sources excluded:', result1.boundaryProvenance.sourcesExcluded.map(s => `${s.source} (${s.reason})`));
// → ['GOOGLE_DRIVE (COLD_TIER)', 'LINKEDIN_SIGNAL (POLICY_DENIED)']

console.log('Sufficiency:', result1.boundaryProvenance.sufficiencyScore, '/', result1.boundaryProvenance.sufficiencyThreshold);
// → 0.83 / 0.80

console.log('Terminated early:', result1.boundaryProvenance.terminatedEarly);
// → true
```

## Step 4: Demo Moment 2 — Live Permission Revocation

```typescript
// Revoke Salesforce access
console.log('Revoking Salesforce access...');

// Re-query with revoked access
const result2 = await assembleEscalationContext(
  DEMO_TENANT_ID,
  'priya.mehta@company.example',
  true // sfAccessRevoked = true
);

console.log('After revocation:');
console.log('Sources reviewed:', result2.boundaryProvenance.sourcesIncluded);
// → ['SERVICENOW', 'SLACK']

console.log('New exclusion:', result2.boundaryProvenance.sourcesExcluded.find(s => s.source === 'SALESFORCE'));
// → { source: 'SALESFORCE', reason: 'PERMISSION_REVOKED', detail: 'Access revoked by administrator' }

console.log('New sufficiency score:', result2.boundaryProvenance.sufficiencyScore);
// → 0.61 (below threshold — context is incomplete)
```

## Step 5: Demo Moment 3 — Audit Trail

```typescript
// Record the boundary plan for audit
const planHash = `sha256:acme-escalation-${Date.now()}`;
await db.writeBoundaryPlan(DEMO_TENANT_ID, {
  tenant_id: DEMO_TENANT_ID,
  plan_hash: planHash,
  operational_frame: 'support_resolution',
  canopy_decision: 'REUSED_TRUST',
  authority_level: 'CONTRIBUTOR',
  temporal_mode: 'OPERATIONAL',
  eligible_sources: ['SALESFORCE', 'SERVICENOW', 'SLACK'],
  forbidden_sources: ['GOOGLE_DRIVE', 'LINKEDIN_SIGNAL'],
  required_categories: ['CRM', 'ITSM'],
  sufficiency_threshold: 0.80,
  terminated_early: true,
  termination_reason: 'Sufficiency gate fired after 3 sources',
  satisfied_categories: ['CRM', 'ITSM', 'COLLAB'],
  missing_categories: [],
  final_sufficiency_score: 0.83,
  plan_json: result1.boundaryProvenance as unknown as Record<string, unknown>,
  expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
});

// Query the audit trail
const earlyTermStats = await db.getEarlyTerminationStats(DEMO_TENANT_ID, {
  fromTime: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
});
console.log('Early termination stats:', earlyTermStats);
// → [{ operational_frame: 'support_resolution', count: 1, avg_sufficiency_score: 0.83, avg_sources_eligible: 3 }]
```

## Step 6: Demo Moment 4 — GDPR Purge

```typescript
// Right to erasure request for jordan.chen@acme.example
const events = await db.queryContextEvents(DEMO_TENANT_ID, { limit: 100 });

const eventsToRedact = events.filter(e =>
  e.participants?.some((p: { email?: string }) => p.email === 'jordan.chen@acme.example')
);

for (const event of eventsToRedact) {
  await db.redactContextEvent(
    DEMO_TENANT_ID,
    event.id,
    'GDPR_RIGHT_TO_ERASURE:jordan.chen@acme.example'
  );
}

console.log(`Redacted ${eventsToRedact.length} events. Hash chain preserved.`);

// Verify redaction
const redactedEvent = await db.getContextEvent(DEMO_TENANT_ID, eventsToRedact[0].id);
console.log('Content after redaction:', redactedEvent?.content);
// → { redacted: true, content: '[DATA_REDACTED_BY_ADMIN_COMPLIANCE_REQUEST]' }
console.log('Decision status:', redactedEvent?.decision_status);
// → 'REDACTED'
console.log('Redacted at:', redactedEvent?.redacted_at);
// → 2026-06-08T... (timestamp preserved in audit trail)
```

## The Partner Demo Script

Use this sequence for the 15-minute partner demo:

| Minute | Demo Action | What to Show |
|--------|-------------|--------------|
| 0–2 | Problem statement | "Your AI doesn't know when to stop. It queries everything." |
| 2–5 | Submit escalation query | Show assembly animation, sufficiency score, early termination |
| 5–7 | Show excluded sources | Google Drive (COLD_TIER), LinkedIn (POLICY_DENIED) — user-facing labels |
| 7–10 | Revoke Salesforce access | Re-query, show Salesforce disappears, score drops to 0.61 |
| 10–12 | GDPR purge demo | Redact Jordan Chen's data, show sentinel content, hash chain intact |
| 12–15 | SQL audit query | `SELECT * FROM context_audit_trace_v WHERE transaction_id = '...'` |

## Key Talking Points

1. **"We stopped at 0.83."** — The system knew it had enough. It didn't query Drive (stale)
   or LinkedIn (policy denied). It saved 2 API calls per assembly.

2. **"Revoke access in your source system — we see it immediately."** — JIT permission
   re-checks mean ContextDB reflects your real ACLs, not a stale snapshot.

3. **"At scale, that's 750,000 API calls saved per day per enterprise."** —
   Temperature governance (HOT/WARM/COOL/COLD) eliminates redundant fetches.

4. **"This runs on your Postgres."** — No new database. No new vendor. ContextDB is
   a schema + governance layer on top of the Postgres you already trust.

5. **"Every decision is auditable."** — The `context_audit_trace_v` view lets compliance
   teams trace any AI-informed decision back to its sources.
