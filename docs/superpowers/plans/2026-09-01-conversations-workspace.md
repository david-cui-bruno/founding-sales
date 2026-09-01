# Conversations Workspace Implementation Plan

## Purpose

Enable the Conversations navigation entry with a real workspace: browse every
recorded call/voicemail activity, read attached transcripts, and manually
attach a transcript to a call. This plan covers the manual-recovery paths from
the V1 design (section 13.1/13.4): paste/import a transcript. It deliberately
excludes live Apple call observation, audio import, cloud speech-to-text, and
LLM analysis; those remain behind the Apple feasibility spike and a future
analysis-provider plan.

## Global Constraints

- Node 24 (`export PATH="/opt/homebrew/opt/node@24/bin:$PATH"`).
- TDD RED before GREEN for every task; one commit per task with the exact
  message given.
- All new zod schemas are `.strict()`. No ambient time or IDs in the domain:
  clock and id generator are injected.
- No blended lead score anywhere. Fit and Timing stay separate.
- Renderer uses design tokens only (no hex literals); every new CSS file must
  be imported from its feature module (cssWiring.test.ts enforces this).
- Transcript text is untrusted data. It is rendered as text, never
  interpreted, never fed to `dangerouslySetInnerHTML`, never executed.
- `activities.transcript_storage_ref` has a DB CHECK requiring a consent
  policy record. Manual attach therefore writes a
  `consent_policy_records` row (`policy_kind='recording'`,
  `decision='granted'`, evidence `{ "kind": "founder_manual_attach" }`,
  versioned `policy_version='manual-attach-v1'`) in the same transaction.

## Task 1: Conversations contract

Files: `src/shared/contracts/conversationsContract.ts`,
`tests/shared/conversationsContract.test.ts`.

Schemas (all `.strict()`):

- `conversationRowSchema`: `activityId`, `personId`, `salesCycleId` nullable,
  `personName`, `kind` enum `call|voicemail`, `direction`
  enum `inbound|outbound`, `occurredAt` datetime-offset, `durationSeconds`
  int nullable, `recordingAvailable` bool, `transcriptAvailable` bool,
  `summary` string nullable.
- `conversationsListRequestSchema`: `query` string (may be empty, max 200),
  `filter` enum `all|with_recording|with_transcript|without_transcript`,
  `limit` int 1..200, `cursor` string nullable.
- `conversationsListResponseSchema`: `rows`, `total` nonneg int, `nextCursor`
  nullable, `revision` nonneg int.
- `transcriptUtteranceSchema`: `id`, `sequence` nonneg int, `speaker` enum
  `founder|lead|unknown`, `text` min 1.
- `conversationDetailSchema`: row fields plus `transcript` nullable
  `{ transcriptId, source: 'manual_paste', createdAt, utterances: [...] min 1 }`.
- `conversationDetailRequestSchema`: `{ activityId }`.
- `attachTranscriptRequestSchema`: `{ activityId, personId, rawText }` with
  `rawText` min 1 max 200_000.

Contract tests: strict rejection of extra keys, enum boundaries, rawText
bounds.

Commit: `feat: conversations contract`

## Task 2: Transcript schema migration

Files: `src/main/db/migrations/0003Transcripts.ts`,
`tests/main/transcriptMigration.test.ts`. Registry wiring in
`src/main/db/migrate.ts` is done by the integrator, not this task; the
migration test uses the migration object directly on a temp encrypted DB.

Tables:

```sql
CREATE TABLE transcripts (
  id TEXT PRIMARY KEY,
  activity_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('manual_paste')),
  format_version INTEGER NOT NULL CHECK (format_version = 1),
  raw_text TEXT NOT NULL CHECK (length(raw_text) > 0),
  created_at TEXT NOT NULL,
  UNIQUE (activity_id),
  FOREIGN KEY (activity_id, person_id) REFERENCES activities(id, person_id)
);
CREATE TABLE transcript_utterances (
  id TEXT PRIMARY KEY,
  transcript_id TEXT NOT NULL REFERENCES transcripts(id),
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  speaker TEXT NOT NULL CHECK (speaker IN ('founder','lead','unknown')),
  text TEXT NOT NULL CHECK (length(trim(text)) > 0),
  UNIQUE (transcript_id, sequence)
);
```

Immutability triggers matching the 0002 style: transcripts and utterances are
append-only (no UPDATE, no DELETE).

Tests: table creation, immutability triggers reject UPDATE/DELETE, FK
enforcement, one transcript per activity.

Commit: `feat: transcript schema migration`

## Task 3: Domain conversations module

Files: `src/main/domain/conversations/conversationsDomain.ts`,
`tests/main/conversationsDomain.test.ts`.

Standalone functions taking `{ database, clock, ids }` (NOT methods on
`FounderSalesDomain`; the integrator adds thin delegating methods later so only
one person edits the facade file):

- `listConversations(deps, request)`: query `activities` where
  `kind IN ('call','voicemail')` joined to persons, LIKE-escaped name search,
  filter mapping (`with_transcript` = `transcript_storage_ref IS NOT NULL`,
  etc.), offset cursor identical to `listLeadRows` style, newest first
  (`occurred_at DESC, id ASC`).
- `getConversationDetail(deps, request)`: row plus utterances when a
  transcript row exists.
- `attachTranscript(deps, request)`: single immediate transaction that
  1. loads the activity, requires `kind='call'|'voicemail'` and matching
     `person_id`, rejects when `transcript_storage_ref` already set
     (`TRANSCRIPT_ALREADY_ATTACHED`),
  2. parses rawText into utterances: split lines, trim, drop empties; a line
     matching `/^(me|founder):/i` is speaker `founder`, `/^[^:]{1,40}:/`
     is `lead` with prefix stripped, otherwise `unknown` with full text;
     reject when zero utterances remain (`TRANSCRIPT_EMPTY`),
  3. inserts consent record + transcript + utterances,
  4. updates `activities.transcript_storage_ref = 'db:transcripts/' || id`
     and `consent_policy_record_id` (activities has no immutability trigger on
     these columns; verify and adjust the UPDATE to touch only these columns),
  5. returns a `MutationReceipt`.

Error type mirrors `FounderSalesDomainError` codes:
`ACTIVITY_NOT_FOUND`, `TRANSCRIPT_ALREADY_ATTACHED`, `TRANSCRIPT_EMPTY`.

Tests use the real encrypted temp database fixture
(`tests/fixtures/tempDatabase.ts`) with seeded persons/activities.

Commit: `feat: conversations domain module`

## Task 4: Conversations UI feature

Files under `src/renderer/features/conversations/`:
`ConversationsRoute.tsx`, `ConversationsPage.tsx`, `ConversationList.tsx`,
`ConversationDetail.tsx`, `AttachTranscriptDialog.tsx`,
`conversations.css`, plus `tests/renderer/conversationsPage.test.tsx`.

Props-injected API type (defined in the feature, satisfied later by preload):

```ts
type ConversationsApi = {
  list(request: ConversationsListRequest): Promise<ConversationsListResponse>;
  get(request: ConversationDetailRequest): Promise<ConversationDetail>;
  attachTranscript(request: AttachTranscriptRequest): Promise<MutationReceipt>;
};
```

Layout: master-detail. Left: search input, filter segmented control, list rows
(person name, when, duration, direction glyph, recording/transcript pills
reusing `StatusPill`). Right: detail with meta header, `Open lead` button
(calls `onOpenLead(personId)`), transcript as a list of utterances (speaker
label + text, founder utterances visually distinct via accent-tinted border),
and `Attach transcript` button opening a dialog with a textarea + preview of
parsed utterance count; disabled when a transcript exists. Empty states via
`EmptyState`. All colors via tokens. Keyboard: list rows focusable,
Enter opens.

Tests (jsdom, mocked api): list renders, filter round-trips to api, detail
loads on selection, attach dialog submits rawText and refreshes, error surface
on rejection, no transcript -> attach enabled, transcript -> attach disabled.

Commit: `feat: conversations workspace page`

## Task 5: Integration (single integrator, owns shared files)

Files: `src/main/db/migrate.ts`, `src/main/domain/founderSalesDomain.ts`
(delegating methods `listConversations`, `getConversationDetail`,
`attachTranscript`), `src/main/conversations/registerConversationsIpc.ts`,
`src/main/ipc/registerApplicationIpc.ts`, `src/preload/apis/conversationsApi.ts`,
`src/preload.ts`, `src/shared/preload.d.ts`, `src/renderer/app/routeRegistry.tsx`,
`src/renderer/app/navigationItems.ts` (enable entry), `src/renderer/App.tsx`
if needed, plus `tests/integration/conversationsService.test.ts` and an E2E
extension in `tests/e2e/founderWorkflow.spec.ts` or a new
`tests/e2e/conversations.spec.ts`: import a lead, log a call from the
inspector, open Conversations, attach a pasted transcript, relaunch, verify
persistence; axe gate adds the Conversations route.

README: Conversations paragraph replaces the "remains disabled" sentence.

Commit: `feat: enable conversations workspace end to end`

## Explicitly out of scope

Apple bridge recording ingestion, audio playback, speech-to-text, LLM
analysis passes, Mom Test critique, review-item generation from transcripts,
transcript editing or deletion (append-only V1).
