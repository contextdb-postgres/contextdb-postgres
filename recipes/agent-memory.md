# Recipe: Persistent Agent Memory with the ECL

This recipe shows how to use ContextDB as the persistent memory layer for an AI agent.
The Enterprise Context Ledger (ECL) gives your agent durable, queryable, governed memory
that persists across sessions and can be audited.

## Why the ECL beats in-memory or vector-only memory

| Concern | In-memory | Vector DB | ContextDB ECL |
|---------|-----------|-----------|---------------|
| Persists across restarts | ❌ | ✅ | ✅ |
| Multi-tenant isolation | ❌ | Manual | Built-in (RLS) |
| Permission enforcement | ❌ | Manual | Built-in |
| Append-only audit trail | ❌ | ❌ | ✅ |
| Compliance purge (GDPR) | ❌ | Complex | Built-in (REDACTED) |
| Structured + semantic | Partial | Semantic only | Both |

## Setup

```typescript
import { createContextDBClient } from 'contextdb-postgres';

const db = createContextDBClient({
  connectionString: process.env.DATABASE_URL,
});

const TENANT_ID = 'your-tenant-uuid';
const AGENT_USER_ID = 'agent-service-account-uuid';
```

## Storing Agent Observations

When your agent observes something meaningful (a decision, an outcome, a user preference),
write it to the ECL:

```typescript
// Agent observes a user decision
await db.writeContextEvent(TENANT_ID, {
  source_system: 'MANUAL',
  source_event_id: `agent-obs-${sessionId}-${Date.now()}`,
  event_type: 'AGENT_OBSERVATION',
  event_time: new Date(),
  participants: [
    { role: 'principal', user_id: userId, email: userEmail },
    { role: 'agent', user_id: AGENT_USER_ID },
  ],
  content: {
    object_type: 'observation',
    session_id: sessionId,
    observation_type: 'USER_PREFERENCE',
    subject: 'Communication style',
    value: 'prefers bullet points over prose for technical summaries',
    confidence: 0.87,
    context: 'Observed in 3 consecutive sessions',
  },
  origin_type: 'fabric_observed',
  decision_status: 'ALLOWED',
  mode_id: modeId,
  fabric_transaction_id: transactionId,
});
```

## Storing Agent Decisions

When the agent makes a decision (recommends an action, drafts a response), record it:

```typescript
await db.writeContextEvent(TENANT_ID, {
  source_system: 'MANUAL',
  source_event_id: `agent-decision-${sessionId}`,
  event_type: 'AGENT_DECISION',
  event_time: new Date(),
  participants: [
    { role: 'principal', user_id: userId },
    { role: 'agent', user_id: AGENT_USER_ID },
  ],
  content: {
    object_type: 'decision',
    decision_type: 'ACTION_RECOMMENDED',
    action: 'SCHEDULE_EXECUTIVE_BRIEFING',
    rationale: 'Account health dropped 21 points, renewal at risk, executive sponsor not contacted',
    confidence: 0.91,
    sources_used: ['SALESFORCE:sf-case-00124891', 'SERVICENOW:INC0109450'],
    outcome_pending: true,
  },
  origin_type: 'fabric_observed',
  decision_status: 'ALLOWED',
  mode_id: modeId,
  fabric_transaction_id: transactionId,
});
```

## Retrieving Agent Memory

Query the ECL to give the agent context about past interactions:

```typescript
async function getAgentMemory(
  tenantId: string,
  userId: string,
  options: {
    eventTypes?: string[];
    lookbackDays?: number;
    limit?: number;
  } = {}
): Promise<NCE[]> {
  const fromTime = new Date(
    Date.now() - (options.lookbackDays ?? 30) * 24 * 60 * 60 * 1000
  );

  return db.queryContextEvents(tenantId, {
    eventTypes: options.eventTypes ?? [
      'AGENT_OBSERVATION',
      'AGENT_DECISION',
      'MEETING_COMPLETED',
      'CASE_RESOLVED',
    ],
    fromTime,
    decisionStatus: 'ALLOWED',
    limit: options.limit ?? 20,
  });
}

// In the agent's context assembly:
const recentMemory = await getAgentMemory(TENANT_ID, userId, {
  eventTypes: ['AGENT_OBSERVATION', 'AGENT_DECISION'],
  lookbackDays: 14,
});

const memoryText = recentMemory
  .map(m => `[${m.event_time.toISOString().split('T')[0]}] ${JSON.stringify(m.content)}`)
  .join('\n');
```

## Recording Outcomes

When the agent's recommendation leads to an outcome, record it. This closes the loop
and teaches the system which types of recommendations work:

```typescript
await db.writeContextEvent(TENANT_ID, {
  source_system: 'MANUAL',
  source_event_id: `agent-outcome-${sessionId}`,
  event_type: 'AGENT_OUTCOME',
  event_time: new Date(),
  participants: [{ role: 'principal', user_id: userId }],
  content: {
    object_type: 'outcome',
    related_decision_id: `agent-decision-${sessionId}`,
    outcome_type: 'POSITIVE',
    outcome_summary: 'Executive briefing scheduled, account health improved to 74',
    recommendation_was_followed: true,
  },
  origin_type: 'fabric_observed',
  decision_status: 'ALLOWED',
  fabric_transaction_id: transactionId,
});
```

## Building a Context Pod for Agent Sessions

For long-running agent tasks (a sales deal, an incident, an ongoing project), use a
context pod as the durable working memory:

```typescript
import { withTenantTransaction } from 'contextdb-postgres/sdk/tenant';

const pod = await db.upsertContextPod(TENANT_ID, {
  tenant_id: TENANT_ID,
  focal_entity_type: 'OPPORTUNITY',
  focal_entity_id: opportunityId,
  focal_entity_name: 'Acme Corp — Enterprise Renewal FY2026',
  mode_id: 'sales_intelligence',
  scope_type: 'TENANT',
  assembly_trigger: 'AGENT_SESSION_START',
  is_active: true,
  context: {
    current_stage: 'At Risk',
    renewal_date: '2026-07-31',
    contract_value: 485000,
    last_agent_action: 'DRAFTED_EXECUTIVE_BRIEF',
  },
  sources: {
    salesforce: { last_sync: new Date().toISOString() },
    servicenow: { last_sync: new Date().toISOString() },
  },
});

console.log(`Pod ID: ${pod.id} — stable across all sessions for this opportunity`);
```

## Audit: What Did the Agent Do?

Use the audit trace to reconstruct the agent's full reasoning trail:

```typescript
// Trace all agent actions in a session
const trace = await db.getAuditTraceByTransaction(TENANT_ID, transactionId);

for (const row of trace) {
  console.log(`Run: ${row.pod_run_id} | Status: ${row.run_status}`);
  console.log(`  Pod: ${row.pod_id} | Version: ${row.version_number}`);
  console.log(`  Evidence: ${row.evidence_refs.length} refs`);
  console.log(`  Sources: ${[...new Set(row.evidence_refs.map(e => e.source_system))].join(', ')}`);
}
```

## GDPR: Delete an Agent's Memory of a User

If a user invokes their right to erasure:

```typescript
async function eraseUserMemory(tenantId: string, userEmail: string): Promise<number> {
  // Find all NCEs where the user was a participant
  const events = await db.queryContextEvents(tenantId, {
    decisionStatus: 'ALLOWED',
    limit: 1000,
  });

  // Filter events that reference this user
  const userEvents = events.filter(event =>
    event.participants?.some((p: { email?: string }) => p.email === userEmail)
  );

  // Redact each one
  let redactedCount = 0;
  for (const event of userEvents) {
    await db.redactContextEvent(
      tenantId,
      event.id,
      `GDPR_RIGHT_TO_ERASURE:${userEmail}`
    );
    redactedCount++;
  }

  return redactedCount;
}
```

The hash chain is preserved — the audit trail shows that events existed and were
redacted. But the PII content is gone.

## Key Design Principles

1. **One append per observation** — never update existing NCEs. Write a new observation
   when the agent's understanding changes.

2. **Transaction IDs are correlation** — use `fabric_transaction_id` to link all events
   from a single agent session. Never use it as pod identity.

3. **Mode ID scopes memory** — use `mode_id` to segment memory by agent type
   (sales intelligence, SRE mode, support resolution). This prevents memory bleed
   across unrelated agent contexts.

4. **Outcomes close the loop** — always record `AGENT_OUTCOME` events. They feed the
   learning loop that improves future retrieval quality.
