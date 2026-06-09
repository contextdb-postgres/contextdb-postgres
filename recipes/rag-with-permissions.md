# Recipe: RAG with Permission-Aware Context

This recipe shows how to build a Retrieval-Augmented Generation (RAG) pipeline that
enforces source-system permissions before including evidence in a context package.

## The Problem with Standard RAG

Standard RAG pipelines chunk documents, embed them, and retrieve by vector similarity.
They have no concept of:
- Whether the current user has permission to see this document
- Whether the document was recently revoked from the user
- Whether the document is stale enough that it shouldn't be used
- Which sources are appropriate for this type of query

ContextDB solves this by making permissions a first-class part of retrieval.

## Setup

```sql
-- Apply the ContextDB schema to your PostgreSQL instance
\i schema/001_core_ecl.sql
\i schema/002_pod_identity.sql
\i schema/003_boundary_plans.sql
\i schema/004_seeding.sql
```

```typescript
import { createContextDBClient } from 'contextdb-postgres';

const db = createContextDBClient({
  connectionString: process.env.DATABASE_URL,
});
```

## Step 1: Ingest Documents as NCEs

When a document is shared, uploaded, or updated in a source system (Salesforce, Drive,
Confluence), write a normalized context event:

```typescript
await db.writeContextEvent(tenantId, {
  source_system: 'GOOGLE_DRIVE',
  source_event_id: `drive-doc-${fileId}`,
  event_type: 'DOCUMENT_SHARED',
  event_time: new Date(),
  participants: [
    { role: 'owner', email: ownerEmail },
    { role: 'viewer', email: userEmail },
  ],
  content: {
    object_type: 'document',
    title: document.title,
    mime_type: document.mimeType,
    url: document.webViewLink,
    // Store summary, not full content (governance principle)
    summary: await generateSummary(document.content),
  },
  origin_type: 'fabric_observed',
  decision_status: 'ALLOWED',
  policy_refs: ['SOURCE_PERMISSION_VERIFIED'],
});
```

## Step 2: Record Permission Events

When permissions change (user gains or loses access), write another NCE:

```typescript
// User lost access to a document
await db.writeContextEvent(tenantId, {
  source_system: 'GOOGLE_DRIVE',
  source_event_id: `drive-permission-revoke-${fileId}-${userId}`,
  event_type: 'DOCUMENT_PERMISSION_REVOKED',
  event_time: new Date(),
  participants: [{ role: 'principal', email: userEmail, user_id: userId }],
  content: {
    object_type: 'permission',
    file_id: fileId,
    action: 'REVOKE',
    reason: 'sharing_rule_changed',
  },
  origin_type: 'fabric_observed',
  decision_status: 'DENIED',
  policy_refs: ['ACL_REVOCATION'],
});
```

## Step 3: Query Context with Permission Filtering

When a user asks a question, query events that they are permitted to see:

```typescript
async function getPermittedContext(
  tenantId: string,
  userId: string,
  query: string,
  options: { sourceSystem?: string; fromTime?: Date }
): Promise<NCE[]> {

  // 1. Get the user's current permission set from your source system
  const permittedDocIds = await getUserPermissions(userId);

  // 2. Query ContextDB for relevant events
  const events = await db.queryContextEvents(tenantId, {
    sourceSystem: options.sourceSystem,
    fromTime: options.fromTime,
    // Only include explicitly allowed events — deny any held/denied/redacted
    decisionStatus: 'ALLOWED',
    excludeRedacted: true,
  });

  // 3. Filter by current permissions (JIT check)
  const permittedEvents = events.filter(event => {
    const docId = event.content?.object_id as string | undefined;
    if (!docId) return true; // Non-document events pass through
    return permittedDocIds.has(docId);
  });

  return permittedEvents;
}
```

## Step 4: Build the Context Package

Use the permitted events to build a bounded context package for the LLM:

```typescript
async function buildContextPackage(
  tenantId: string,
  userId: string,
  query: string
): Promise<{
  events: NCE[];
  sources: string[];
  terminatedEarly: boolean;
  sufficiencyScore: number;
}> {
  const SUFFICIENCY_THRESHOLD = 0.80;
  let currentScore = 0;
  const collectedEvents: NCE[] = [];
  const sourcesChecked: string[] = [];

  // Query each source system in priority order
  const sourcePriority = ['SALESFORCE', 'SERVICENOW', 'SLACK', 'GOOGLE_DRIVE'];

  for (const sourceSystem of sourcePriority) {
    if (currentScore >= SUFFICIENCY_THRESHOLD) {
      // Sufficiency gate fired — stop retrieving
      return {
        events: collectedEvents,
        sources: sourcesChecked,
        terminatedEarly: true,
        sufficiencyScore: currentScore,
      };
    }

    const events = await db.queryContextEvents(tenantId, {
      sourceSystem,
      decisionStatus: 'ALLOWED',
      fromTime: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // 30 days
      limit: 10,
    });

    collectedEvents.push(...events);
    sourcesChecked.push(sourceSystem);

    // Update sufficiency score (simplified — real implementation uses IQO)
    currentScore = Math.min(0.95, currentScore + events.length * 0.15);
  }

  return {
    events: collectedEvents,
    sources: sourcesChecked,
    terminatedEarly: false,
    sufficiencyScore: currentScore,
  };
}
```

## Step 5: Generate with Context

Pass the permission-filtered, sufficiency-gated context to your LLM:

```typescript
async function generateResponse(
  query: string,
  contextPackage: Awaited<ReturnType<typeof buildContextPackage>>
): Promise<string> {
  const contextText = contextPackage.events
    .map(event => `[${event.source_system}] ${JSON.stringify(event.content)}`)
    .join('\n\n');

  const response = await llm.generate({
    systemPrompt: `You are answering based on governed enterprise context.
      Sources checked: ${contextPackage.sources.join(', ')}.
      ${contextPackage.terminatedEarly ? 'Context was sufficient after checking these sources.' : ''}`,
    userPrompt: query,
    context: contextText,
  });

  return response;
}
```

## Key Principles

1. **Permissions are live, not cached** — always verify current user permissions before
   including evidence in context, not just at indexing time

2. **Sufficiency stops over-retrieval** — once you have enough context, stop querying.
   Don't fetch Google Drive if Salesforce + ServiceNow already answer the question.

3. **DENIED events are audit, not evidence** — events with `decision_status: 'DENIED'`
   are recorded for audit trails but never included in context packages

4. **Redacted content is always excluded** — check `excludeRedacted: true` (default)
   in all context queries

5. **Seeding is not a permission bypass** — documents seeded with
   `JIT_RECHECK_REQUIRED` strategy always re-check permissions before being served
