# Learnings Workspace Implementation Plan

## Purpose

Enable the Learnings navigation entry: founder-curated insights with evidence.
Per the V1 design (section 13.5), accepted learnings retain evidence, sources,
confidence, sample size, observation dates, contradictions, and the founder
decision. V1 source of learnings is the founder directly (manual capture,
optionally linked to a person and/or a conversation activity), because LLM
transcript analysis is out of scope until an analysis-provider plan exists.
The schema is designed so future analysis-generated suggestions flow through
Review and land in the same tables.

## Global Constraints

Same as the Conversations plan: Node 24 path prefix, TDD RED before GREEN,
one commit per task with the exact message, `.strict()` zod, injected
clock/ids, design tokens only, CSS wired from feature modules, no blended
score. Learnings text is founder data, rendered as text only.

## Task 1: Learnings contract

Files: `src/shared/contracts/learningsContract.ts`,
`tests/shared/learningsContract.test.ts`.

Schemas (all `.strict()`):

- `learningCategorySchema`: enum
  `pain | objection | alternative | winning_language | pricing_reaction |
   product_request | coaching | invalidated_assumption`.
- `learningStatusSchema`: enum `active | contradicted | retired`.
- `learningEvidenceSchema`: `{ id, personId nullable, personName nullable,
  activityId nullable, quote string min 1 max 2000, notedAt datetime-offset }`.
- `learningRowSchema`: `learningId`, `category`, `statement` min 1 max 500,
  `status`, `confidence` enum `low|medium|high`, `sampleSize` int >= 1
  (derived: evidence count), `firstObservedAt`, `latestObservedAt`,
  `evidence` array min 1, `contradictionOf` nullable learningId, `createdAt`,
  `version` positive int.
- `learningsListRequestSchema`: `categories` array of category (empty = all),
  `statuses` array (empty = all), `query` max 200, `limit` 1..200.
- `learningsListResponseSchema`: `rows`, `totalActiveCount` nonneg,
  `revision` nonneg.
- `captureLearningRequestSchema`: `category`, `statement`, `confidence`,
  `evidence` array min 1 of `{ personId nullable, activityId nullable,
  quote, notedAt }`, `contradictionOf` nullable.
- `addEvidenceRequestSchema`: `{ learningId, expectedVersion positive,
  evidence (single) }`.
- `updateLearningStatusRequestSchema`: `{ learningId, expectedVersion,
  status, reason string max 500 nullable }` where status transition to
  `contradicted` requires a non-null reason.

Commit: `feat: learnings contract`

## Task 2: Learnings schema migration

Files: `src/main/db/migrations/0004Learnings.ts`,
`tests/main/learningsMigration.test.ts`. (Number is 0004 assuming the
Conversations plan lands 0003 first; if executed independently, take the next
free number and keep the registry monotonic.)

```sql
CREATE TABLE learnings (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL CHECK (category IN (
    'pain','objection','alternative','winning_language','pricing_reaction',
    'product_request','coaching','invalidated_assumption'
  )),
  statement TEXT NOT NULL CHECK (length(trim(statement)) > 0),
  status TEXT NOT NULL CHECK (status IN ('active','contradicted','retired')),
  status_reason TEXT,
  confidence TEXT NOT NULL CHECK (confidence IN ('low','medium','high')),
  contradiction_of TEXT REFERENCES learnings(id),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (status = 'contradicted' AND status_reason IS NOT NULL)
    OR (status <> 'contradicted')
  )
);
CREATE TABLE learning_evidence (
  id TEXT PRIMARY KEY,
  learning_id TEXT NOT NULL REFERENCES learnings(id),
  person_id TEXT REFERENCES persons(id),
  activity_id TEXT,
  quote TEXT NOT NULL CHECK (length(trim(quote)) > 0),
  noted_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (activity_id, person_id) REFERENCES activities(id, person_id)
);
CREATE INDEX learning_evidence_learning_idx
  ON learning_evidence(learning_id, noted_at);
```

Evidence rows are append-only (immutability triggers in the 0002 style).
Learnings rows allow UPDATE of `status`, `status_reason`, `confidence`,
`version`, `updated_at` only; a trigger rejects UPDATE of `category`,
`statement`, `contradiction_of`, `created_at`. No DELETE on either table.

Tests: creation, trigger coverage for allowed vs rejected updates, FK
enforcement, contradicted-requires-reason CHECK.

Commit: `feat: learnings schema migration`

## Task 3: Domain learnings module

Files: `src/main/domain/learnings/learningsDomain.ts`,
`tests/main/learningsDomain.test.ts`.

Standalone functions over `{ database, clock, ids }` (facade delegation is the
integrator's job):

- `listLearnings(deps, request)`: joins evidence, aggregates sampleSize,
  firstObservedAt/latestObservedAt from evidence `noted_at` min/max, resolves
  personName via join, LIKE-escaped query against statement and quotes,
  ordering: `status='active'` first, then `latestObservedAt DESC`.
- `captureLearning(deps, request)`: transaction inserting learning + evidence
  rows; when `contradictionOf` is set, requires the referenced learning to
  exist and be `active`, and marks it `contradicted` with
  `status_reason = 'Contradicted by ' || newId` bumping its version.
- `addLearningEvidence(deps, request)`: optimistic-lock on expectedVersion,
  appends evidence, bumps version and updated_at.
- `updateLearningStatus(deps, request)`: optimistic-lock, enforces the
  reason rule, bumps version.

Errors: `LEARNING_NOT_FOUND`, `LEARNING_VERSION_CONFLICT`,
`LEARNING_STATUS_INVALID`, `EVIDENCE_PERSON_NOT_FOUND` (when personId given
but absent), `CONTRADICTION_TARGET_INVALID`.

Tests on the real encrypted temp DB fixture, including the
contradiction-marks-target flow and version conflicts.

Commit: `feat: learnings domain module`

## Task 4: Learnings UI feature

Files under `src/renderer/features/learnings/`: `LearningsRoute.tsx`,
`LearningsPage.tsx`, `LearningCard.tsx`, `CaptureLearningDialog.tsx`,
`learnings.css`, plus `tests/renderer/learningsPage.test.tsx`.

Props-injected api:

```ts
type LearningsApi = {
  list(request: LearningsListRequest): Promise<LearningsListResponse>;
  capture(request: CaptureLearningRequest): Promise<MutationReceipt>;
  addEvidence(request: AddEvidenceRequest): Promise<MutationReceipt>;
  updateStatus(request: UpdateLearningStatusRequest): Promise<MutationReceipt>;
};
```

Layout: toolbar with category filter chips (one per category, multi-select),
status filter, search input, and a `Capture learning` primary button. Body:
card grid (2-col at >=1200px). Card: category label, statement (weight 590),
confidence pill, `n = sampleSize` with first/latest observation dates
(tabular-nums), evidence quotes (collapsed to 2, `Show all` expands), person
links via `onOpenLead`, status controls (`Retire`, `Mark contradicted` with
reason prompt, `Reactivate`), `Add evidence` inline form. Contradicted cards
render struck-through statement + reason. Empty state explains capture.
Capture dialog: category select, statement textarea, confidence select,
one or more evidence rows (quote + optional person picker fed by a
`searchPersons` callback prop — reuse the leads api list by name if trivial,
otherwise plain free-text personId omitted in V1: investigate during RED and
pick the simpler honest option).

Tests: list/filter/search round-trips, capture submits strict payload,
status transitions call api with expectedVersion, contradiction requires
reason, evidence expansion, axe-clean roles/labels on dialog.

Commit: `feat: learnings workspace page`

## Task 5: Integration (single integrator, owns shared files)

Files: `src/main/db/migrate.ts`, facade delegating methods,
`src/main/learnings/registerLearningsIpc.ts`,
`src/main/ipc/registerApplicationIpc.ts`, `src/preload/apis/learningsApi.ts`,
`src/preload.ts`, `src/shared/preload.d.ts`, `src/renderer/app/routeRegistry.tsx`,
`src/renderer/app/navigationItems.ts` (enable entry), plus
`tests/integration/learningsService.test.ts` and E2E
`tests/e2e/learnings.spec.ts`: capture a learning with evidence, relaunch,
verify persistence, retire it, axe gate on the route. README paragraph.

Commit: `feat: enable learnings workspace end to end`

## Explicitly out of scope

LLM cross-call synthesis, transcript-suggestion acceptance into learnings
(comes with the analysis plan; the Review kind `transcript_suggestion` already
reserves the pathway), learning deletion (retire instead), editing statements
(capture a contradiction instead).
