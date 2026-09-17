# Automatic Discovery Triage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace routine manual lead qualification with a prepared daily discovery shortlist, evidence-based briefs and genuine exceptions, while preserving explicit outreach and supporting the existing conversation-to-pilot workflow.

**Architecture:** A local main-process worker assesses retained evidence in bounded batches and stores versioned assessments separately from sales lifecycle state. Read-only discovery queries power Today and the inspector. Choosing a prepared next action performs fresh, atomic qualification, priority recalculation and action creation with automated provenance. It never contacts the prospect.

**Tech Stack:** Existing Node 24, TypeScript, Zod, encrypted better-sqlite3/Kysely, React, Vitest and Playwright. No new dependency or external model provider is required for the first delivery.

**Spec:** `docs/superpowers/specs/2026-09-06-fss-automatic-triage-design.md`, approved 2026-09-06 at 23:25 UTC.

## Global Constraints

- "Work runs while FSS is open. This slice does not install an always-on daemon or promise processing while the app is closed."
- "Do not change outreach permission, initiate calls/messages, invent manual communication events, or enable bulk paid contact enrichment as a side effect of triage."
- "Existing founder decisions take precedence." Superseding an assessment never rewinds sales history or closes a cycle automatically.
- "Label an absent assessment as **Not assessed**." Cloud Fit 0–100 is not local Fit 0–30. Timing remains a separate local 0–40 axis, persisted in millipoints.
- "Never turn an unknown-owner placeholder or merely nonempty name into verified ownership for enrichment."
- "Keep due promises, replies and existing follow-ups ahead of prospecting."
- "The deterministic assessment and evidence-based discovery questions work without a model." Optional research adapters default to explicitly unavailable, not simulated research.
- "The running real workspace and its preserved backup are not test fixtures."
- "Put **Callie** on a separate row directly below" the macOS traffic-light controls. Preserve drag regions and non-macOS layout.
- Preserve one-lead enrichment's existing qualification, medium/high local Fit, identity/address, suppression and rate gates. A shortlist rank is never outbound authorization or buying intent.
- Billing/free-first-job correction belongs in the dispatch repository in a separate follow-up. Do not edit that repository, accept payment, deploy, send, call, or enable production Phone capabilities in this plan.
- Base source: `94f2b01` on `fix/release-task12-continuation`. Sole checkout: `/Users/davidcui824/Documents/Codex/2026-08-29/can/callie-founder-sales-system/.worktrees/release-task12-continuation`. Other checkouts and the currently running packaged app remain untouched during source work.
- Every npm/npx command starts with the literal Node 24 PATH export and the explicit checkout `cd` shown below. Use installed dependencies, not downloads or native rebuilds. Stop and diagnose any ABI failure instead of repairing the shared environment blindly.

---

## Delivery decisions and ownership

The first release is useful without an AI account: it assesses existing records, ranks evidence, writes deterministic discovery questions and revisits changed records. A typed research port permits a later configured provider; its production default displays **Additional research not configured**. Do not make every missing fact wait for a provider. Unknown management style or door count can be a discovery question, not a rejection.

### Fixed policy v1

1. Operational blocks, deletion, existing disqualification, merged identity and closed cycles remain excluded from new preparation. A merge-review identity is a genuine judgment item, not an automatically qualified prospect.
2. A source-supported named owner/person or owner entity with a linked property is enough to consider a discovery conversation. It does not establish self-management, a specific human buyer, maintenance pain or willingness to pay. Placeholder identity is insufficient.
3. Primary candidates have supported property context and at least medium known-evidence Fit. Reserve up to two of ten places for other source-supported ownership/property candidates with incomplete Fit. Do not fill unused places with blocked or unresolved identities. Thus missing management does not starve the entire queue.
4. Order the primary bucket by the existing local priority comparator using explicitly provisional assessment inputs, not by cycle ID. Order the exploration bucket by evidence freshness, oldest last conversation, then stable Person ID. Unknown axes sort after known axes, never as a purported actual zero. No new blended score or cloud-score promotion.
5. The shortlist is advisory and capped by `min(10, remainingDiscretionaryCapacity)`. A contactless candidate consumes an advisory slot but not a completed dial. Existing commitments remain above it. Re-evaluate capacity again before a prepared action is created.
6. Fit is `null` when no scoreable property/profile evidence exists, otherwise marked `partial` whenever rubric inputs are missing. A partial 15/30 means **15 supported points**, not a complete negative judgment. Timing with no supported trigger says **No current trigger established**.
7. Assessment exclusion requires a specific existing gate or supported reason. Low Fit, missing contact, an LLC name or a lack of purchase evidence cannot generate `non_paying_operator` or another canonical disqualification.
8. Canonical qualification is lazy. Inspecting a card does not write. **Contact options** is the next-action CTA: it prepares the selected prospect and opens the existing inspector. The founder then uses the existing explicit contact/enrichment/composer flow. There is no separate Mark ready approval in the prepared workflow.
9. Manual overrides are `watch`, `exclude`, or `reconsider` with a reason. They affect discovery visibility only, not lifecycle disqualification. Keep the existing explicit dismissal/opt-out controls separately available. Same-evidence results cannot erase an override; new evidence is shown as revised with the prior override visible.
10. Future pilot suggestions require actual conversation evidence. Reuse Interviewed/Offered confirmation and existing domain Won evidence rules. Add only the missing explicit manual price-stated input to the existing past-activity form; generated text cannot execute any transition. An offer is not a payment.

### File structure

| Unit | Files | Responsibility |
|---|---|---|
| Public discovery contract | `src/shared/contracts/discoveryContract.ts` | Strict bounded DTOs, references, requests and receipts |
| Internal assessment types/policy | `src/main/domain/discovery/discoveryTypes.ts`, `discoveryPolicy.ts`, `discoveryBrief.ts` | Pure disposition, ordering inputs, completeness and deterministic questions |
| Evidence collection | `src/main/domain/discovery/discoveryEvidence.ts` | Coherent full linked evidence, source ownership and citation validation |
| Durable store | `src/main/db/migrations/0017DiscoveryAssessments.ts`, `src/main/domain/discovery/discoveryRepository.ts` | Assessments, current pointer, overrides, preparation receipts and scan cursor |
| Canonical fact materialization | `src/main/domain/discovery/discoveryFactWriter.ts` | Only supported fact updates and valid source-backed triggers in an existing UOW |
| Read service | `src/main/domain/discovery/discoveryReadService.ts` | Read-only shortlist, briefs and same-snapshot capacity calculation |
| Application service | `src/main/domain/discovery/discoveryService.ts` | Assess/persist, override and atomic lazy preparation |
| Worker | `src/main/discovery/discoveryWorker.ts`, `discoveryResearchPort.ts` | Bounded local scans, durable jobs, refresh and cancellation |
| Boundary | `src/main/discovery/discoveryProvider.ts`, `registerDiscoveryIpc.ts`, `src/preload/apis/discoveryApi.ts` | Dedicated `discovery` API through the existing runtime lease |
| UI | `src/renderer/features/discovery/DiscoverySection.tsx`, `DiscoveryBrief.tsx`, `useDiscovery.ts` | Today shortlist, progress, evidence, exception and override UI |
| Existing integration | Domain composition, lifecycle/prioritization writers, Today/inspector, startup and API composition | Narrow delegates, no unrelated facade rewrite |
| Verification | New focused tests below plus existing encrypted fixtures and packaged helpers | Real source interfaces, synthetic data only |

Tasks 1–8 are sequential where they share contracts. Task 9 (wordmark) is independent source work but must not race Task 8's sidebar edits. Task 10 is the assembled gate. Use a fresh reviewer for each meaningful deliverable, not another user approval for routine implementation details.

## Locked interfaces

Task 1 owns the definitions below. Subsequent tasks must consume these names rather than invent parallel DTOs. Existing shared types/schemas come from `commonContract` and the other shared contracts. Only internal main-process types import `prioritizationTypes`/`domainSchema`; the new shared contract never imports a main-process module. Task 1 exports each named runtime schema used below, including `discoveryBriefRequestSchema`.

```ts
// src/shared/contracts/discoveryContract.ts
export type DiscoveryDisposition = 'candidate' | 'research' | 'judgment' | 'watch' | 'excluded';
export type DiscoveryEvidenceRef =
  | { kind: 'source'; sourceEventId: string; field: string; observedAt: string }
  | { kind: 'activity'; activityId: string; field: string; observedAt: string }
  | { kind: 'utterance'; activityId: string; transcriptId: string; utteranceId: string;
      quote: string; observedAt: string };
export type DiscoveryClaim = {
  id: string; label: string; value: string | number | boolean | null;
  certainty: 'fact' | 'inference' | 'unknown'; refs: DiscoveryEvidenceRef[];
};
export type DiscoveryAxes = {
  fit: { points: number; band: FitBand; completeness: 'complete' | 'partial' } | null;
  timing: { milliPoints: number; band: TimingBand; hasSupportedTrigger: boolean };
  reachability: Reachability;
};
export type DiscoveryAssessment = {
  id: string; personId: string; prospectId: string; salesCycleId: string;
  fingerprint: string; policyVersion: 'discovery-v1'; ruleVersionId: string;
  modelVersion: string | null; evaluatedAt: string; expiresAt: string;
  localDate: string; overrideId: string | null;
  disposition: DiscoveryDisposition; reasonCodes: string[]; axes: DiscoveryAxes;
  claims: DiscoveryClaim[]; unknowns: string[]; questions: string[];
  identitySupported: boolean; needsResearch: boolean;
  ranking: { priority: 'p0' | 'p1' | 'p2' | 'p3' | null;
    earliestTriggerExpiresAt: string | null; dataConfidence: number;
    lastContactAt: string | null; latestSourceObservedAt: string | null };
};
export type DiscoveryOverride = {
  id: string; assessmentId: string; decision: 'watch' | 'exclude' | 'reconsider';
  reason: string; createdAt: string; evidenceChanged: boolean;
};
export type DiscoveryBrief = {
  personId: string; salesCycleId: string; personName: string;
  assessment: DiscoveryAssessment | null; stale: boolean;
  latestOverride: DiscoveryOverride | null;
  pilotNextStep: { label: string; activityIds: string[] } | null;
};
export type DiscoverySnapshot = {
  prepared: DiscoveryBrief[]; judgment: DiscoveryBrief[];
  counts: { unassessed: number; research: number; watch: number; excluded: number };
  processing: 'idle' | 'running' | 'paused' | 'error';
  researchCapability: 'not_configured' | 'available';
  generatedAt: string; revision: number;
};
export type BeginDiscoveryRequest = {
  commandId: string; personId: string; salesCycleId: string;
  assessmentId: string; expectedFingerprint: string;
};
export type BeginDiscoveryReceipt = {
  mutation: MutationReceipt; personId: string; salesCycleId: string;
  assessmentId: string; actionId: string;
};
export type OverrideDiscoveryRequest = {
  commandId: string; personId: string; assessmentId: string;
  expectedFingerprint: string; decision: 'watch' | 'exclude' | 'reconsider'; reason: string;
};
export type DiscoveryApi = {
  get(): Promise<DiscoverySnapshot>;
  getBrief(input: { personId: string }): Promise<DiscoveryBrief>;
  begin(input: BeginDiscoveryRequest): Promise<BeginDiscoveryReceipt>;
  override(input: OverrideDiscoveryRequest): Promise<MutationReceipt>;
};
```

Implement all DTOs with strict Zod schemas and derive the exported types rather than maintaining duplicate handwritten runtime shapes. IDs are nonempty canonical strings, command/assessment/override IDs are UUIDs, fingerprints are lowercase 64-hex, timestamps are canonical UTC; `localDate` is the validated founder-timezone `YYYY-MM-DD` date and `overrideId` is the effective override UUID or null. Bound claims to 100, refs per claim to 20, questions to 3, prepared to 10, judgment to 20, reason/unknown lists to 50; validate finite axis values and exact units. Claims marked fact require at least one reference. A schema-valid reference is not necessarily valid evidence: Task 3 checks actual ownership and values.

```ts
// src/main/domain/discovery/discoveryTypes.ts
export type DiscoveryEvidenceSnapshot = Readonly<{
  personId: string; prospectId: string; salesCycleId: string; personName: string;
  personVersion: number; prospectVersion: number; cycleVersion: number;
  stage: LifecycleStage; workflowStatus: WorkflowStatus;
  qualificationState: ProspectsTable['qualification_state'];
  qualificationGateReason: string | null; operationallyBlocked: boolean;
  unresolvedIdentity: boolean; identitySupported: boolean; resurfaceAt: string | null;
  originalSource: OriginalSourceFact;
  properties: readonly PropertyFact[]; contacts: readonly ContactMethodFact[];
  triggers: readonly TriggerEvent[];
  validatedClaims: readonly DiscoveryClaim[];
  claims: readonly DiscoveryClaim[];
  lastConversationAt: string | null;
  conversationActivityIds: readonly string[];
  inputFingerprint: string; ruleVersionId: string;
}>;
export type DiscoveryAssessmentDraft = Omit<DiscoveryAssessment,
  'id' | 'modelVersion' | 'evaluatedAt' | 'expiresAt' | 'localDate' | 'overrideId'>;
export type DiscoveryEvaluationInput = {
  snapshot: DiscoveryEvidenceSnapshot; rule: PrioritizationRuleDocument; asOf: string;
};
export type DiscoveryScanPage = { prospectIds: string[]; cursor: string | null; done: boolean };
export type DiscoveryProcessResult = { assessmentId: string; unchanged: boolean };
```

`ProspectsTable['qualification_state']` is the existing database union, not a new eligibility model. `validatedClaims` contains the complete supported reference/value pairs, while `claims` is the bounded presentation subset selected only after conflict detection. Reference validation compares kind, owner linkage, field, observed time and actual value/quote, not just an ID in the displayed subset. The immutable evidence fingerprint includes identity/cycle/qualification versions, all relevant source bytes, linked facts, contact facts/compliance versions, relevant activity amendments and rule ID. It excludes overrides, renderer state, generated prose and evaluation time. Assessment cache identity additionally includes policy version, effective override ID and founder-local date. Check the latest override independently before applying a result, so an override does not look like changed source evidence. Treat trigger expiry separately so a same-day expiry still causes reassessment.

---

### Task 1: Strict discovery contracts and useful deterministic policy

**Files:**
- Create: `src/shared/contracts/discoveryContract.ts`
- Create: `src/main/domain/discovery/{discoveryTypes,discoveryPolicy,discoveryBrief}.ts`
- Create: `tests/main/{discoveryContract,discoveryPolicy}.test.ts`
- Create: `tests/fixtures/discoveryEvidence.ts`
- Read: `src/main/domain/prioritization/{qualificationEngine,triggerMath,priorityOrdering,priorityMatrix,builtinPrioritizationRules}.ts`

**Interfaces:** Produces the locked DTOs and `evaluateDiscovery(input: DiscoveryEvaluationInput): DiscoveryAssessmentDraft`, `buildDiscoveryQuestions(snapshot: DiscoveryEvidenceSnapshot): string[]`, and `compareDiscoveryCandidates(a: DiscoveryAssessment, b: DiscoveryAssessment): number`. The fixture exports `evidence(overrides?: Partial<DiscoveryEvidenceSnapshot>): DiscoveryEvidenceSnapshot` with an active Unreviewed cycle, `identitySupported:true`, a named owner, a supported ten-unit property, no contact and unknown management. No I/O, clock read, credential, repository or lifecycle call is allowed in policy.

- [ ] **Step 1: Write the RED contract/policy tests.** Include exact unknown semantics, safe named-owner exploration, heuristic handling and partial-score presentation.

```ts
const snapshot = evidence();
const result = evaluateDiscovery({ snapshot,
  rule: BUILTIN_PRIORITIZATION_RULE_V1, asOf: '2026-09-06T12:00:00.000Z' });
expect(result.disposition).toBe('candidate');
expect(result.axes.fit).toMatchObject({ points: 15, completeness: 'partial' });
expect(result.axes.reachability).toBe('none');
expect(result.questions).toContain('Do you handle maintenance yourself or use a property manager?');
expect(evaluateDiscovery({ snapshot: evidence({ unresolvedIdentity: true }),
  rule: BUILTIN_PRIORITIZATION_RULE_V1, asOf: '2026-09-06T12:00:00.000Z' })
  .disposition).toBe('research');
const stored = { ...result, id: '11111111-1111-4111-8111-111111111111', modelVersion: null,
  localDate: '2026-09-06', overrideId: null,
  evaluatedAt: '2026-09-06T12:00:00.000Z', expiresAt: '2026-09-07T04:00:00.000Z' };
expect(discoveryAssessmentSchema.safeParse(stored).success).toBe(true);
const invalid = discoveryAssessmentSchema.safeParse({ ...stored, axes: { ...stored.axes,
  fit: { points: 100, band: 'high', completeness: 'complete' } } });
expect(invalid.success).toBe(false);
if (!invalid.success) expect(invalid.error.issues.some(i => i.path.join('.') === 'axes.fit.points')).toBe(true);
```

- [ ] **Step 2: Run RED:** `npm test -- tests/main/discoveryContract.test.ts tests/main/discoveryPolicy.test.ts`. Prefix with the global exact PATH/cd. Observe absent-module/API failure, then behavioral RED before implementation.
- [ ] **Step 3: Implement the pure rules and question templates.** Preserve source support and axis units. Call `calculateFit` only over admissible `PropertyFact`s; do not call canonical `evaluateQualification` after pretending Unreviewed is Eligible. Use `evaluateTriggers` over supported triggers only. Gate actual blocks first. Suggested questions are questions, not asserted pain.

```ts
if (snapshot.workflowStatus !== 'active' || snapshot.operationallyBlocked
  || snapshot.qualificationState === 'disqualified') {
  return excludedDraft(snapshot, 'existing_operational_or_qualification_block');
}
if (snapshot.qualificationState === 'merge_review') return judgmentDraft(snapshot, 'identity_conflict');
if (snapshot.unresolvedIdentity || !snapshot.identitySupported) {
  return researchDraft(snapshot, 'owner_identity_unknown');
}
// Private helpers above and below return DiscoveryAssessmentDraft, retaining
// owner IDs/fingerprint/rule ID and the exact bounded fields from the contract.
const fit = hasScoreablePropertyFacts(snapshot.properties)
  ? calculateFit({ properties: snapshot.properties, rule }) : null;
```

Implement `excludedDraft`, `judgmentDraft`, `researchDraft` and `hasScoreablePropertyFacts` as private helpers in this task, not unresolved imports. Unknown dimensions are described in `unknowns`; no source assertion is inferred from an organization name. For primary candidates, map `axes` and `ranking` to the existing `OrderablePriorityRow` and call `compareProspectPriority`, with both cloud tie-breaker fields `null`. Never invent a primary priority for a null-Fit exploration record. Exploration uses latest supported observation descending, last actual conversation ascending with never-contacted first, and Person ID. Geography belongs in the dated brief and discovery question, not a silent new scoring rule; distinguish a US-wide product proposition from stronger Texas delivery evidence.

- [ ] **Step 4: Run GREEN plus `tests/main/qualificationEngine.test.ts`, `triggerMath.test.ts` and `noBlendedScore.test.ts`.** Add tests for actual zero versus missing, no contact penalty, two exploration slots, equal-date deterministic order, expired triggers, evidence conflicts, unsupported self-managed flag, source freshness and no fabricated pilot promise.
- [ ] **Step 5: Typecheck, scoped lint, review and commit:** `feat(discovery): define evidence-based automatic triage policy`.

### Task 2: Schema 17 and immutable assessment persistence

**Files:**
- Create: `src/main/db/migrations/0017DiscoveryAssessments.ts`
- Create: `src/main/domain/discovery/discoveryRepository.ts`
- Modify: `src/main/db/{migrate,domainSchema}.ts`, `src/main/domain/{createDomainServices,domainRuntime}.ts`, `src/main/domain/startup/storageReadiness.ts`
- Modify current-version guards: `src/main/backup/preReleaseBackupRuntime.ts`, `scripts/createPreReleaseBackup.mjs`
- Create: `tests/main/db/migrations/0017DiscoveryAssessments.test.ts`, `tests/main/discoveryRepository.test.ts`, `tests/fixtures/discoveryDatabase.ts`
- Compatibility test/support paths: see the explicit current/historical matrix immediately below.

**Interfaces:** `DiscoveryRepository({database, unitOfWork})`, `assertBoundTo(database, unitOfWork)`, `appendAssessment(assessment: DiscoveryAssessment): void`, `getCurrent(prospectId: string): DiscoveryAssessment | null`, `setCurrent(prospectId: string, assessmentId: string): void`, `appendOverride(input: OverrideDiscoveryRequest & {createdAt: string}): void`, `getLatestOverride(prospectId: string): DiscoveryOverride | null`, `getPreparation(commandId: string): {request: BeginDiscoveryRequest; receipt: BeginDiscoveryReceipt} | null`, `appendPreparation(request: BeginDiscoveryRequest, receipt: BeginDiscoveryReceipt): void`, `readScanCursor(): string | null`, `writeScanCursor(cursor: string | null): void`. All mutations require the exact bound UOW; construction does no reads/time/ID work.

- [ ] **Step 1: Write a real encrypted migration RED.** Use `productionMigrations.filter(x => x.schemaVersion <= 16)` for the old database, then apply the new registry. Assert prior selected rows unchanged, five discovery tables plus typed job index exist, exact new ledger entry, immutable history, FK ownership rejection and valid current-manifest acceptance.

```ts
expect(f.database.raw.prepare('SELECT schema_version FROM app_meta WHERE singleton = 1')
  .get()).toMatchObject({ schema_version: 17 });
expect(f.database.raw.prepare("SELECT name FROM sqlite_master WHERE name = 'discovery_assessments'").get())
  .toBeDefined();
expect(() => f.database.raw.prepare('DELETE FROM discovery_assessments WHERE id = ?').run(assessment.id))
  .toThrow();
```

Use the fixture database consistently as `f.database` in these assertions. The test's `assessment` is a fully validated Task 1 fixture, not an arbitrary JSON blob. The migration reader in `migrate.ts` is private; do not export it just for the test.

- [ ] **Step 2: Run the new migration/repository suites before production changes.** Require table/API absence RED. Add commit/reopen/replay and cross-owner receipt tests before repository implementation.
- [ ] **Step 3: Add the schema and repository.** Use the migration style already in `0015RecoveryMetadata.ts`/`0016ContactPresentationEvidence.ts`; no edits to historical migration bytes.

| Table | Required content and invariants |
|---|---|
| `discovery_assessments` | UUID primary key; Person/Prospect/Cycle IDs; fingerprint, policy/rule/model versions, evaluated/expiry timestamps, disposition, strict bounded assessment JSON; immutable update/delete triggers; owner tuple must match canonical Prospect and Cycle |
| `discovery_current` | One row per Prospect, current assessment ID, positive version; matching ownership enforced on insert/update; historical assessment remains immutable |
| `discovery_overrides` | UUID command primary key, assessment/owner identity, input fingerprint, decision, bounded reason, created time; append-only; exact command replay or conflict |
| `discovery_preparations` | UUID command primary key, assessment/owner/cycle/action identity, canonical request JSON and result receipt JSON; append-only; exact replay or conflict |
| `discovery_scan_state` | Singleton bounded scan cursor and last complete scan/local date metadata, initialized explicitly by the worker rather than constructor |

Add indexes for `(prospect_id,evaluated_at,id)`, `(disposition,expires_at)`, owner override lookup and runnable jobs `(type,state,created_at,id)`. Use existing owner composite unique constraints where available; otherwise validate owner tuples with SQL triggers rather than adding incompatible parent uniqueness blindly. Every table has CHECK constraints for enums/JSON/version/timestamps; application readers revalidate and return fixed corruption errors, never empty success. Immutable tables use both UPDATE and DELETE guards, for example:

```sql
CREATE TRIGGER discovery_assessments_no_update
BEFORE UPDATE ON discovery_assessments
BEGIN SELECT RAISE(ABORT, 'Discovery assessment history is immutable.'); END;
CREATE TRIGGER discovery_assessments_no_delete
BEFORE DELETE ON discovery_assessments
BEGIN SELECT RAISE(ABORT, 'Discovery assessment history is immutable.'); END;
```

Implement the other table columns/owner checks from the matrix in the same migration. Register it once as schemaVersion 17; repository writes bind every column as a parameter and parse the strict Task 1 schema before serialization.

`tests/fixtures/discoveryDatabase.ts` exports `createDiscoveryDatabase(): Promise<{database: AppDatabase; services: DomainServices; temp: TempDatabase; key: WorkspaceKey; close(): void}>`. Build from `createTempDatabase`, `createTestWorkspaceKey`, `openDatabase`, `migrateToLatest` and `DomainRuntime.initialize`, with a fixed injected clock. It also exports `seedDiscoveryOwner(fixture, {prefix: string; units: number | null}): {personId: string; prospectId: string; salesCycleId: string; sourceEventId: string}` using real source intake and lifecycle creation. Seed an actual validated parcel/FRBO event, not only `seedProspect`'s `{fixture:true}` source.

- [ ] **Step 4: Update the current schema-17 manifest/ledger using a disposable encrypted database.** Generate the exact catalog hash with the existing `storageReadiness` hashing algorithm after all new tables/indexes/triggers are final. Record the derivation in the task report. Never weaken catalog equality or generate from the founder workspace.
- [ ] **Step 5: Complete current/historical compatibility and run GREEN.**

Current-version expectations may change in:
`tests/support/domainSchemaScenario.ts`, `tests/main/{migrations,domainStartupAudit,healthService}.test.ts`, `tests/integration/{foundationRecovery,plaintextDatabaseUpgrade,restoreDrill,migrationBackup}.test.ts`, `tests/support/{plaintextUpgradeScenario,migrationBackupScenario,packagedFixtureDatabase}.ts`, `tests/main/{packagedFixtureDatabase,packagedTestEnvironment}.test.ts`, `tests/e2e/foundation.spec.ts`, `test/{createPreReleaseBackup,preReleaseLauncher,preReleaseElectronHost}.test.mjs`.

Historical migration tests `tests/main/db/migrations/{0009SourcingFileLedger,0011ContactDncFlags,0012UpstreamRequestState,0016ContactPresentationEvidence}.test.ts` must explicitly stop at their intended version when they currently use `migrateToLatest`. In particular, a 15→16 test stays a 15→16 test. Replace `slice(0,-1)` with a version predicate where the intent was through15. `packagedFixtureDatabase` must inspect historical15 with its frozen validated table catalog, not the new current17 table list.

**Do not change** the historical15 hash/ledger in `src/main/db/readOnlyEncryptedDatabase.ts` or broaden identity audit's seven-module build graph. Add genuine current17/old16/future18 guard tests to the current pre-release host/launcher. Preserve historical15 recovery cases separately.

- [ ] **Step 6: Typecheck, scoped lint, run migration/startup/recovery/backup focused suites and commit:** `feat(discovery): persist versioned assessments with schema 17`.

### Task 3: Coherent source evidence and conservative fact materialization

**Files:**
- Create: `src/main/domain/discovery/{discoveryEvidence,discoveryFactWriter}.ts`
- Create: `src/main/domain/prioritization/prioritizationTransactionWriter.ts`
- Modify: `src/main/domain/prioritization/prioritizationService.ts`
- Extend: `tests/main/prioritizationService.test.ts`
- Create: `tests/main/discoveryEvidence.test.ts`, `tests/integration/discoveryFacts.test.ts`
- Modify only if needed for shared typed helpers: `src/main/domain/identity/identityRepository.ts`
- Read: `src/main/sourcing/intakeMapper.ts`, `src/main/domain/source/{sourceRepository,sourceService}.ts`, `src/shared/contracts/cloudSourceEventContract.ts`

**Interfaces:** `collectDiscoveryEvidence({database, services, prospectId, asOf}): DiscoveryEvidenceSnapshot` executes inside an already-owned coherent read/write transaction and never starts one itself. `validateDiscoveryClaim({snapshot, claim}): boolean` validates references AND value support. `DiscoveryFactWriter({database, unitOfWork, services}).apply(snapshot: DiscoveryEvidenceSnapshot): void` is scoped-write-only. `services` is `Pick<DomainServices, 'identities' | 'sourceRepository' | 'events' | 'outboundPermission' | 'prioritizationRepository' | 'prioritization' | 'workspaceSettings'>`, so collection/fact writing does not require a circular dependency on the service graph being constructed.

- [ ] **Step 1: Write evidence RED with genuine source-intake fixtures.** Cover multiple linked properties/orgs, owner entity versus unknown-owner placeholder, duplicate source replay, wrong-person source/utterance, marked-in-error activity, stale versus fetched/evaluated dates, missing property address, conflicting source versus founder values and unsupported heuristic flags.

```ts
const f = await createDiscoveryDatabase();
try {
  const owner = seedDiscoveryOwner(f, { prefix: 'owner', units: 10 });
  const snapshot = f.services.unitOfWork.immediate(() => collectDiscoveryEvidence({
    database: f.database, services: f.services, prospectId: owner.prospectId,
    asOf: '2026-09-06T12:00:00.000Z',
  }));
  expect(snapshot.properties).toHaveLength(1);
  expect(snapshot.unresolvedIdentity).toBe(false);
  expect(snapshot.claims.some(c => c.label === 'Self-managed' && c.certainty === 'fact')).toBe(false);
  expect(validateDiscoveryClaim({ snapshot, claim: {
    id: 'bad', label: 'Ownership', value: true, certainty: 'fact',
    refs: [{kind:'source', sourceEventId:'other-person-source', field:'entity.person.full_name',
      observedAt:'2026-09-01T12:00:00.000Z'}],
  }})).toBe(false);
} finally { f.close(); }
```

- [ ] **Step 2: Run `npm test -- tests/main/discoveryEvidence.test.ts tests/integration/discoveryFacts.test.ts` and observe RED.** No founder database or public-network research.
- [ ] **Step 3a: Extract the existing prioritization mutation bodies into a transaction-scoped writer first.** `PrioritizationService.scopedWriter()` returns `recordTriggerEvent(input: RecordTriggerEventInput): TriggerEvent` and `recalculateProspect(input: RecalculateProspectInput): RecalculationResult`. Export `RecalculateProspectInput` with the exact current five fields. Public methods still own their UOW and delegate; keep calculation, trigger proof, exact replay and stale semantics unchanged. No duplicated algorithm or nested public service calls.

```ts
scopedWriter(): PrioritizationTransactionWriter {
  this.unitOfWork.assertWriteScope();
  return this.writer;
}
recalculateProspect(input: RecalculateProspectInput): RecalculationResult {
  return this.unitOfWork.immediate(() => this.writer.recalculateProspect(input));
}
```

`PrioritizationTransactionWriter` uses the existing database/UOW/clock/repository/permission dependencies and exposes only the two scoped mutation operations. Its constructor performs no reads. Run prior public/scoped parity and rollback tests before using it in `DiscoveryFactWriter`.

- [ ] **Step 3b: Implement exact ownership joins and value validation.** Decode `source_record_json` through `SourceRepository`: cloud data lives under the typed `sourceRecord.cloudSourceEvent` wrapper. Call the full `validateCloudSourceEvent`, not only the envelope schema. Read all linked rows in stable order. Traverse source fields using a fixed supported-field allowlist, not arbitrary property paths from a model. Utterance references must join through transcript and activity to the same Person, preserve the exact quote, and exclude amended/invalid evidence.

Canonical materialization rules:
- Existing property `door_count` and address fields are usable with their source references, but a missing ownership link is not established by matching a name alone.
- Only fill an absent canonical value when an explicit supported fact maps to the exact linked property. Never overwrite a conflicting existing non-null value or founder maintenance profile; produce a judgment assessment instead.
- Add a small scoped identity repository method for supported property updates if needed; do not write canonical identity tables from renderer/worker SQL.
- Municipal observed ownership is not verification of management. FRBO `self_managed` is an inference, never 8 canonical management points. No guessed `verifiedAt`, maintenance profile or relationship.
- Source-backed trigger mapping v1 supports FRBO `frbo_listing` → `live_vacancy` only when the full valid source and its vacancy/listing evidence support it, through the existing source-proof validator. Reuse already-valid canonical triggers. One source event permits one trigger. Do not invent a compliance deadline from `violation.opened_at`, use a cloud window peak as a deadline, or add unsupported permit/deed payload mappings. Unmapped signals remain dated facts/questions.
- Do not change wire schemas, cloud scoring, upstream uploads or old intake receipts to enable this work. The same collector/materializer handles backfill and new ingestion; an eventual bounded rescan repairs an interrupted notification.

Bound each coherent evidence snapshot to 1 MiB of canonical JSON. Oversize evidence produces a retryable/research diagnostic, not a truncated first-property score or a human identity judgment. Brief limits do not permit silently discarding contradicting evidence before classification.

- [ ] **Step 4: Run GREEN with `tests/main/qualificationEngine.test.ts`, `tests/main/prioritizationService.test.ts`, `tests/main/sourceService.test.ts` and `tests/main/sourcing/intakeMapper.test.ts`.** Verify no-op replay and canonical row invariance for heuristic-only inputs.
- [ ] **Step 5: Review and commit:** `feat(discovery): derive linked evidence without inventing lead facts`.

### Task 4: Read-only daily shortlist and evidence brief composition

**Files:**
- Create: `src/main/domain/discovery/discoveryReadService.ts`
- Modify: `src/main/domain/discovery/{discoveryRepository,discoveryBrief}.ts`, `src/main/domain/createDomainServices.ts`
- Modify: `src/main/domain/today/todayService.ts` for the transaction-scoped read helper
- Read existing capacity/ordering: `src/main/domain/today/{todayOrdering,todayRepository,todayTypes}.ts`
- Create: `tests/integration/discoverySnapshot.test.ts`
- Extend: `tests/main/discoveryPolicy.test.ts`

**Interfaces:** `DiscoveryReadService({database, unitOfWork, services, clock})` exposes `get(): DiscoverySnapshot`, `getBrief(personId: string): DiscoveryBrief`, and `remainingCapacityInScope(asOf: string): number`. Here `services` is `Pick<DomainServices, 'discoveryRepository' | 'today' | 'workspaceSettings' | 'jobs' | 'identities' | 'sourceRepository' | 'events' | 'outboundPermission' | 'prioritizationRepository' | 'prioritization'>`. Compose it as `DomainServices.discoveryRead` before the write service in Task 5. Public reads own one deferred read transaction with `ROLLBACK` in `finally`; the scoped capacity method requires an existing transaction. Extract `TodayService.buildInCurrentSnapshot(input: {timezone: string; capacity: TodayCapacity; channelPolicies: ChannelPolicySnapshots; generatedAt: string}): TodayQueue`. It requires `raw.inTransaction`, performs the original read/calculation body, and never opens/closes a transaction. Existing `build` still validates input, owns its read transaction and delegates. Use the exact existing settings/capacity defaults and `TodayQueue.remainingDiscretionaryDialCount` directly. It already subtracts completed and queued discretionary work, so do not subtract that work twice. The preparation command consumes this same helper.

- [ ] **Step 1: Write encrypted query RED:** 40 owner fixtures, current and expired assessments, two eligible exploration records, conflicting identity, opt-out, founder override, scheduled commitments and completed dials. Reverse insertion order must not change ranking. Reading repeatedly must not add jobs/assessments/actions or change revision.

```ts
const before = selectedBusinessRows(f.database);
const result = f.services.discoveryRead.get();
expect(result.prepared.length).toBeLessThanOrEqual(10);
expect(new Set(result.prepared.map(x => x.personId)).size).toBe(result.prepared.length);
expect(result.prepared.filter(x => x.assessment?.axes.fit === null).length).toBeLessThanOrEqual(2);
expect(selectedBusinessRows(f.database)).toEqual(before);
```

`selectedBusinessRows` is a test-local sorted snapshot of persons, prospects, cycles, activities, stage events, next actions, discovery tables and jobs. It excludes no mutable business table used by the query. Seed assessed rows through the accepted Task 2 repository inside its bound UOW, using Task 1 policy over Task 3 evidence. This task must pass before `DiscoveryService` exists; it cannot depend on an absent write service or a stub.

- [ ] **Step 2: Implement all read fields, progress counts and deterministic briefs.** Use indexed durable job/scan state for processing status, never a global mutable worker reference. Until Task 6 starts work, pending inputs produce `idle` plus the unassessed count. Available research is not claimed by this read service: production capability is `not_configured`. Return stale assessments only in inspector evidence/history with `stale:true`, never as current prepared action. Include unknowns and actual dated facts. Keep lower-confidence candidates in the exploration allocation, without treating unknown contact as failed Fit. Keep watch/excluded entries accessible through Leads and brief history.

```ts
get(): DiscoverySnapshot {
  if (this.database.raw.inTransaction) throw new Error('DISCOVERY_READ_SCOPE_REQUIRED');
  this.database.raw.exec('BEGIN');
  try {
    const asOf = this.clock.now();
    return discoverySnapshotSchema.parse(this.readSnapshotInScope(asOf));
  } finally {
    this.database.raw.exec('ROLLBACK');
  }
}
```

`readSnapshotInScope(asOf)` is a private method implemented here: load current owner-linked assessment rows and latest overrides, discard expired/invalid current candidates, compare prospective cards' current Task 3 fingerprints/rule/override within the same read snapshot, order by Task 1 comparator, reserve up to two eligible exploration slots, cap at `min(10, remainingCapacityInScope(asOf))`, and compute counts/job state from the same read snapshot. `getBrief` follows the same transaction pattern, selects the requested Person's current cycle and includes prior override provenance. No getter enqueues a refresh. Scan candidate rows in indexed pages ordered by the complete persisted ranking tuple, not by arbitrary IDs before applying a 50-row cap. Use strict JSON extraction or indexed ranking columns consistent with the Task 1 comparator, with SQL/TypeScript parity tests. Check at most 50 evidence snapshots per query; report unverified remainder as pending rather than claim it is current. If stale candidates exhaust this bounded page, return a partial shortlist while Task 6 catches up, never a false zero-backlog success.
- [ ] **Step 3: Derive pilot-next-step text only from actual accepted conversation evidence and current lifecycle stage.** For Contacted, suggest a discovery conversation. For Interviewed with relevant evidence, suggest discussing a supervised trial. For Offered, show the actual existing follow-up action. Do not auto-write pain dimensions, price-said evidence, readiness, offers or wins. If no admissible evidence exists, return `pilotNextStep:null`.
- [ ] **Step 4: Run GREEN with existing Today/priority ordering suites.** Assert due commitments are never displaced, capacity zero yields no new prepared actions, old-cycle evidence does not become current buyer intent, invalid/amended transcript quotes are absent, and counts explain unprocessed/research work.
- [ ] **Step 5: Review and commit:** `feat(discovery): compose a bounded evidence-backed conversation shortlist`.

### Task 5: Atomic preparation with honest automated provenance

**Files:**
- Create: `src/main/domain/discovery/discoveryService.ts`
- Modify: `src/main/domain/prioritization/prioritizationService.ts` only if needed for the accepted scoped writer binding, not another extraction
- Modify: `src/main/domain/lifecycle/{lifecycleService,lifecycleTransactionWriter}.ts`
- Modify: `src/main/domain/{createDomainServices,founderSalesDomain}.ts`
- Extend: `tests/main/sourcing/enrichmentRequestWriter.test.ts`, `tests/main/sourcing/founderSalesDomainUpstream.test.ts`
- Create: `tests/main/discoveryService.test.ts`, `tests/integration/discoveryPreparation.test.ts`
- Extend: `tests/main/{prioritizationService,createDomainServices}.test.ts`

**Interfaces:**
- `PrioritizationService.scopedWriter()` returns scoped `recordTriggerEvent(input: RecordTriggerEventInput): TriggerEvent` and `recalculateProspect(input: RecalculateProspectInput): RecalculationResult`. Export `RecalculateProspectInput` with the exact existing five fields from the public method. Public methods keep owning their UOW and delegate to the same implementation.
- `LifecycleTransactionCommands.prepareFromAssessment(input: ReviewToReadyInput & {assessmentId: string; fingerprint: string}): SalesCycle` exists only as a scoped writer, not renderer input. It validates a persisted, matching current assessment and automated authority.
- `DiscoveryService({database, unitOfWork, services, factWriter, clock, ids})` exposes `assess(prospectId: string): DiscoveryProcessResult`, `get(): DiscoverySnapshot`, `getBrief(personId: string): DiscoveryBrief`, `begin(input: BeginDiscoveryRequest): BeginDiscoveryReceipt`, `override(input: OverrideDiscoveryRequest): MutationReceipt`. `get/getBrief` delegate directly to Task 4's `services.discoveryRead`. `services` is exactly `Pick<DomainServices, 'identities' | 'sourceRepository' | 'events' | 'outboundPermission' | 'prioritizationRepository' | 'prioritization' | 'lifecycle' | 'workspaceSettings' | 'discoveryRepository' | 'discoveryRead'>`; `factWriter` is the separately constructed `DiscoveryFactWriter`.
- Facade delegates: `getDiscovery`, `getDiscoveryBrief`, `beginDiscovery`, `overrideDiscovery`, `assessDiscoveryProspect`. Domain composition remains construction-only with exact same-instance dependencies.

- [ ] **Step 1: Write true transactional RED.** Start from real Unreviewed source intake. Assessing must leave qualification/cycle/action/cadence/stage-event counts unchanged. `begin` changes them once, creates a matching canonical projection and persists a receipt. Tests inject failure after qualification, action, projection and receipt to prove rollback.

```ts
const assessmentId = discovery.assess(owner.prospectId).assessmentId;
const a = f.services.discoveryRepository.getCurrent(owner.prospectId)!;
const request: BeginDiscoveryRequest = { commandId: crypto.randomUUID(),
  personId: owner.personId, salesCycleId: owner.salesCycleId, assessmentId,
  expectedFingerprint: a.fingerprint };
const first = discovery.begin(request);
expect(discovery.begin(request)).toEqual(first);
expect(f.database.raw.prepare('SELECT qualification_state FROM prospects WHERE id = ?')
  .get(owner.prospectId)).toMatchObject({ qualification_state: 'eligible' });
expect(f.database.raw.prepare('SELECT confirmation_kind FROM stage_events WHERE sales_cycle_id = ? ORDER BY transition_sequence DESC LIMIT 1')
  .get(owner.salesCycleId)).toMatchObject({ confirmation_kind: 'mechanical' });
```

Construct `discovery` from the Task 5 composed `DomainServices.discovery` instance; do not instantiate a second UOW. Inspect the preparation receipt to prove assessment ID/fingerprint/provenance, not only the mechanical label.

- [ ] **Step 2: Run RED including public prioritization regressions.** Existing `recalculateProspect` and `recordTriggerEvent` own UOWs; demonstrate that simply nesting those public calls is not the solution.
- [ ] **Step 3: Consume Task 3's scoped prioritization writer and implement atomic preparation.** No await, network call or async callback inside any transaction. `DiscoveryService` consumes only the exact dependency pick above, not the complete graph containing itself. Construct the Task 3 fact writer and Task 4 read service first, then discovery service, then freeze the final graph. All binding checks happen without database reads.

```ts
begin(input: BeginDiscoveryRequest): BeginDiscoveryReceipt {
  const request = beginDiscoveryRequestSchema.parse(input);
  return this.unitOfWork.immediate(() => {
    const replay = this.repository.getPreparation(request.commandId);
    if (replay) return this.requireExactReplay(replay, request);
    const evidence = this.collectCurrentEvidence(request.personId);
    const assessment = this.requireCurrentAssessment(request, evidence);
    this.requireCapacityAndEligibility(assessment, evidence);
    this.factWriter.apply(evidence);
    const cycle = this.services.lifecycle.scopedWriter().prepareFromAssessment({
      cycleId: evidence.salesCycleId, expectedCycleVersion: evidence.cycleVersion,
      expectedProspectVersion: evidence.prospectVersion, effectiveAt: this.clock.now(),
      assessmentId: assessment.id, fingerprint: assessment.fingerprint,
    });
    this.recalculateInScope(evidence.prospectId);
    return this.persistPreparationReceipt(request, cycle);
  });
}
```

All helper methods in this snippet are private Task 5 implementations. They use the Task 3 collector/validator and the Task 2 repository. Fresh gate covers owner tuple, source fingerprint, expiry, active rule, identity ambiguity, deleted/opted-out status, cycle state, founder override, resurface time and capacity. Replay reuses only the exact stored result, never authorizes a new outreach operation. Returned receipt must bind exactly one Person/Cycle/action.

Assessing runs one UOW: collect evidence, apply only supported canonical fact/trigger repairs, recollect after those repairs, evaluate, then append/set the current assessment with the post-repair fingerprint. It does not change qualification, lifecycle, actions or cadence. Exact repeated input returns the current ID without a write. `begin` reuses that same materializer idempotently.

Reuse the existing cadence/action recipe inside a narrowly extracted private Ready writer helper. Keep `reviewToReady`'s founder provenance intact. The chosen prospect must receive its normal segment's cadence A/B/C and one primary discretionary-prospecting action because the current invariant audit requires that for Ready. Do not disguise prospecting as `internal_review` to evade it. Automated preparation uses a mechanical stage event, qualification reason containing the assessment UUID, and an immutable assessment-linked preparation receipt. It does not change Interviewed/Offered/Won evidence rules. Do not fabricate an activity solely to satisfy a transition.

Also correct `getEnrichmentRequestCandidate`'s identity projection: select/validate `persons.provenance_json` and reject `needsIdentity:true`/unknown-owner placeholders, even after a name edit. Supported ownership must come from the same evidence collector. Retain the exact other enrichment gates and post-credential final recheck. This prevents automation from making a pre-existing weak nonempty-name check newly permissive.

- [ ] **Step 4: GREEN matrix:** same UUID/same input replay across encrypted reopen; changed UUID input conflict; stale evidence before preparation; opt-out/identity conflict/cycle mutation during selection; actual override after assessment; zero-capacity refusal; no contact fabrication; unknown-owner refusal; no accidental enrichment. Existing founder review and public prioritization tests remain unchanged in meaning.
- [ ] **Step 5: Typecheck, scoped lint, review and commit:** `feat(discovery): prepare selected prospects atomically from current evidence`.

### Task 6: Bounded assessment worker and actual priority refresh execution

**Files:**
- Create: `src/main/discovery/{discoveryWorker,discoveryResearchPort}.ts`
- Modify: `src/main/jobs/jobRepository.ts`
- Modify: `src/main/startApplication.ts`
- Modify: `src/main/domain/founderSalesDomain.ts` only for scoped worker delegates
- Create: `tests/main/{discoveryWorker,discoveryResearchPort}.test.ts`, `tests/integration/discoveryRestart.test.ts`
- Extend: `tests/main/{startApplication,priorityProjectionRefresh,jobRepository}.test.ts`

**Interfaces:**

```ts
export type DiscoveryResearchPort = {
  capability(): 'not_configured' | 'available';
  research(input: { personId: string; claims: readonly DiscoveryClaim[];
    questions: readonly string[]; signal: AbortSignal }): Promise<readonly DiscoveryClaim[]>;
};
export type DiscoveryWorker = {
  start(): void; wake(): void; stop(): void; idle(): Promise<void>;
};
export function createDiscoveryWorker(input: {
  domainGate: Pick<FoundationRuntime, 'withDomain'>;
  clock: Clock; research: DiscoveryResearchPort;
  schedule: (run: () => void, delayMs: number) => () => void;
}): DiscoveryWorker;
```

`unavailableDiscoveryResearch` returns `not_configured` and refuses `research` with a fixed error. No production provider or invented credential loader. Add `DiscoveryJobType = 'discovery_assessment' | 'priority_projection_rebuild'` and typed `JobRepository.listByTypeState(type: DiscoveryJobType, state: JobState, limit: number): JobRecord[]` and `retryFailed(id: string, at: string): JobRecord`. Limit queries to 1–50 rows in stable `created_at,id` order. Retry accepts only these two owned types, failed state and fewer than three retries, clears lifecycle error/timestamps and increments retry count, retaining payload/idempotency identity. Validate canonical time. Reuse existing `JobState` and `JobRecord`, without a second job state model.

Worker facade methods owned here: `scanDiscoveryPage({afterProspectId: string | null, limit: number}): DiscoveryScanPage`, `enqueueDiscoveryPage(page: DiscoveryScanPage): void`, `processDiscoveryJob(jobId: string): void`, `processPriorityRefreshJob(jobId: string): void`. They access the existing same-runtime `DomainServices`, not global database handles. Scan cursor and job enqueue advance together in a UOW.

- [ ] **Step 1: Write clock/timer-controlled RED.** Seed 125 genuine owners. One pump processes at most 25 jobs and scans at most 50 Prospects, yields to the event loop, and ultimately processes all eligible records without any call/enrichment. Unrelated job types remain queued. Simulate close/reopen after assessment persistence but before job completion.

```ts
worker.start();
await runScheduledTurn(); // test-owned scheduler drains one callback, no wall-clock sleep
expect(processedThisTurn).toBeLessThanOrEqual(25);
worker.stop();
await worker.idle();
await runAllCapturedLateCallbacks();
expect(databaseTouchesAfterStop).toBe(0);
expect(outboundCalls).toBe(0);
expect(enrichmentUploads).toBe(0);
```

Define the test scheduler in this task with a queue of callbacks and cancellation flags. Observe database calls through the real runtime gate plus spies, not a copied implementation. Use fake research only for the available-adapter branch.

- [ ] **Step 2: Run RED and inspect the existing unprocessed `priority_projection_rebuild` jobs.** The new worker must actually dispatch that type through the real prioritization service after checking current fingerprint/rule/version; merely adding another queue is insufficient.
- [ ] **Step 3: Implement bounded scanning, dispatch and refresh.** The scheduler body owns one turn and uses the actual runtime lease per synchronous operation:

```ts
for (let processed = 0; processed < 25 && !stopped; processed += 1) {
  const didWork = await domainGate.withDomain(domain => domain.processNextDiscoveryJob());
  if (!didWork) break;
}
if (!stopped) cancelScheduled = schedule(() => { void pump(); }, nextDelayMs);
```

Add `processNextDiscoveryJob(): boolean` to the worker facade methods: select the oldest due queued job of the two owned types, run its exact dispatcher, return false when none is due. `pump(): Promise<void>` is the worker's private single-flight method; catch every rejection into bounded worker status/retry handling. `stopped`, `cancelScheduled`, and `nextDelayMs` are closure-owned state. `stop()` sets `stopped` and calls the captured cancellation synchronously; `idle()` awaits the current single-flight promise. This does not retain the callback's domain object across `await`. Initial/open scan runs page by page, yielding with a zero-delay scheduled turn between batches. After a completed pass, schedule another bounded scan after 60 seconds. New ingestion is therefore assessed within the next pass without a fragile nontransactional notification. Local day, active-rule change and trigger expiry invalidate cache. Use founder timezone via `resolveLocalDayInterval`, not process timezone.

Job keys include Person/Prospect, evidence fingerprint, policy/rule and local date. Use the prior assessment's exact `expiresAt` timestamp as the same-day expiry generation, or `initial` when none exists, not a random/time-of-poll suffix. New assessment expiry is the earlier of the next founder-local midnight and the earliest future valid trigger expiry, computed from one `asOf` value. Never include an already expired trigger boundary. Up to three transient retries with 1s/5s/30s backoff. Cancel/stop does not call `jobs.cancel` on a running job illegally: finish the owned synchronous transaction or leave its durable state recoverable on restart. Interrupted jobs are retried from the same command only if current evidence still matches, otherwise superseded with a fresh command. No endless requeue of malformed evidence.

External research, when injected in tests or a future approved configured composition, happens outside the database lease with an AbortSignal and 15s deadline. Retake a fresh runtime lease and revalidate owner/fingerprint/epoch before applying any result. All claim validation still passes through Task 3. Local first-delivery configuration never sends notes or evidence off-device.

- [ ] **Step 4: Compose one worker after FoundationRuntime is ready and before normal UI completion, without awaiting the entire backlog.** Add `createDiscoveryWorker` to injectable startup dependencies. On startup failure/abort/shutdown, synchronously stop scheduling, abort outstanding research, await `idle`, then close runtime/database. Do not retain domain objects across an async boundary. Reuse the established outbound lifecycle cleanup pattern but keep service ownership separate.
- [ ] **Step 5: Run GREEN for startup rollback, no late writes, restart idempotency, day/DST/expiry changes, changed ingestion, paused/error progress and genuine projection repairs.** Assert no provisioning, sourcing credential read, networking or Phone dispatch from this worker. Preserve normal sourcing behavior.
- [ ] **Step 6: Review and commit:** `feat(discovery): process local assessment and priority refresh jobs`.

### Task 7: Discovery IPC/preload and truthful missing-score projection

**Files:**
- Create: `src/main/discovery/{discoveryProvider,registerDiscoveryIpc}.ts`, `src/preload/apis/discoveryApi.ts`
- Modify: `src/main/ipc/registerApplicationIpc.ts`, `src/preload/createCallieApi.ts`
- Reuse without a parallel API declaration: `src/preload/ipcClient.ts`, `src/shared/preload.d.ts`
- Modify: `src/main/domain/founderSalesDomain.ts`, `src/renderer/features/leadInspector/InspectorOverview.tsx`
- Create: `tests/main/registerDiscoveryIpc.test.ts`, `tests/main/discoveryProvider.test.ts`
- Extend: `tests/integration/preload.test.ts`, `tests/main/registerApplicationIpc.test.ts`, `tests/integration/leadDetailService.test.ts`

**Interfaces:** `createDiscoveryProvider(domain: Pick<FounderSalesDomain, 'getDiscovery' | 'getDiscoveryBrief' | 'beginDiscovery' | 'overrideDiscovery'>): DiscoveryApi`. `registerDiscoveryIpc({provider, isTrustedRendererUrl}): () => void`. `createDiscoveryApi(client: IpcClient): DiscoveryApi` uses existing client conventions. Channels are `discovery:get`, `discovery:get-brief`, `discovery:begin`, `discovery:override`. The global preload type derives from `createCallieApi`; no tenth positional startup argument is added.

- [ ] **Step 1: Boundary RED:** no arguments for get, strict request objects for other calls, untrusted renderer refused, unknown fields rejected, response ownership mismatch refused, exact UUID/fingerprint replay, cleanup after partial handler registration. Mirror existing registrar tests, not fake provider-only assertions.

```ts
expect(await api.begin(request)).toEqual(receipt);
provider.begin.mockResolvedValueOnce({ ...receipt, personId: 'other-person' });
await expect(api.begin(request)).rejects.toThrow();
await expect(invokeRegistered('discovery:begin', untrustedEvent, request)).rejects.toThrow();
```

Here `api` and `provider` use the actual preload client and registrar fixtures. Define `invokeRegistered` with `registeredIpcHandler(electron.handle, channel)` and `Promise.resolve`, matching `tests/main/registerTodayIpc.test.ts`. The registrar's async rejection, not a disconnected mock, proves refusal.

- [ ] **Step 2: Missing-projection RED:** actual `getLeadDetail`, list and pipeline outputs must be `priorityContext: null` without a projection. Existing schemas already allow null. The inspector must display **Not assessed** instead of Fit 0/Low and Timing 0/Cold.
- [ ] **Step 3: Implement thin validated delegates and same-runtime leases.** Register alongside existing feature registrars, with cleanup on partial registration. No SQL/policy in IPC or renderer. `begin` response must match requested Person/Cycle/assessment and mutation owners. Read snapshot must have unique Person IDs and no more than ten prepared cards.

```ts
// createDiscoveryApi: reuse the existing IpcClient.
get: () => client.requestNoInput('discovery:get', discoverySnapshotSchema),
getBrief: input => client.request('discovery:get-brief',
  discoveryBriefRequestSchema, discoveryBriefSchema, input),
// registerApplicationIpc provider composition:
begin: input => runtime.withDomain(domain => domain.beginDiscovery(input)),
```

Task 1 also exports `discoveryBriefRequestSchema` as the strict `{personId}` shape. `begin/override` preload methods validate their inputs/receipts and enforce request-response ownership after `client.request`. Keep the derived `CallieApi` namespace and all existing preload keys.
- [ ] **Step 4: Remove `FALLBACK_PRIORITY_CONTEXT` from display mapping.** Change `toPriorityContext(row): LeadPriorityContext | null`; guard explanatory strings and every nullable consumer. Preserve real zero-valued projections. Do not reinterpret a missing projection as authorizing enrichment. Keep the read-only triage report's frozen contract: its own bounded report serialization may retain explicitly documented numeric representation, but must not manufacture canonical assessment status or leak into display qualification.
- [ ] **Step 5: GREEN for public API, no getter writes, strict response validation, all null consumers and existing outbound receipt isolation.** Typecheck identifies legitimate fixture expectations; update only fixture outputs affected by the new null semantics, never add fake assessments to silence tests.
- [ ] **Step 6: Review and commit:** `feat(discovery): expose prepared leads and truthful assessment state`.

### Task 8: Today and inspector workflows without routine manual review

**Files:**
- Create: `src/renderer/features/discovery/{DiscoverySection,DiscoveryBrief}.tsx`, `src/renderer/features/discovery/useDiscovery.ts`
- Modify: `src/renderer/features/today/{TodayRoute.tsx,TodayPage.tsx,LogPastActivityDialog.tsx,today.css}`
- Modify: `src/renderer/features/leadInspector/{LeadInspectorProvider.tsx,useLeadInspector.ts,LeadInspector.tsx,LeadFullPage.tsx,InspectorOverview.tsx,InspectorConversation.tsx,leadInspector.css}`
- Modify normal injection: `src/renderer/app/{FounderApp.tsx,routeRegistry.tsx}`
- Inspect nullable display consumers, modify only actual zero-fallback/rendering assumptions: `src/renderer/features/leads/leadColumns.tsx`, `src/renderer/features/pipeline/{PipelineTable.tsx,PipelineStageColumn.tsx}`
- Create: `src/renderer/features/discovery/{DiscoverySection,DiscoveryBrief}.test.tsx`, `src/renderer/features/today/LogPastActivityDialog.test.tsx`
- Extend: `src/renderer/features/today/TodayRoute.test.tsx`, `src/renderer/features/leadInspector/LeadInspectorProvider.test.tsx`, `src/renderer/app/FounderApp.test.tsx`

**Interfaces:** `DiscoverySection({api: DiscoveryApi, onOpenPerson: (personId: string) => void})`. `DiscoveryBrief({brief: DiscoveryBrief, onOverride: (request: OverrideDiscoveryRequest) => Promise<MutationReceipt>})` uses a type import alias to avoid the component/type name collision. `useDiscovery(api)` owns loading, bounded refresh, disposal and command state. The public inspector provider accepts the discovery API through normal app composition, not `window` lookup in leaf components. `useDiscovery` returns `{snapshot: DiscoverySnapshot | null; error: string | null; busyPersonId: string | null; refresh(): Promise<void>; begin(brief: DiscoveryBrief): Promise<BeginDiscoveryReceipt>}`. Its private request map retains one `BeginDiscoveryRequest` per selected Person until resolved or explicitly abandoned. Only `Contact options` calls `begin`; evidence-view clicks merely open the inspector.

- [ ] **Step 1: RED user interactions:** Today shows commitments first, then **Prepared conversations**, **Research**, **Needs your judgment**. The 2,881-item manual backlog no longer dominates Today. Existing manual triage remains an optional Leads/review action. Empty processing says **Preparing your shortlist**, not **Queue done**.

```tsx
render(<DiscoverySection api={api} onOpenPerson={openPerson} />);
await screen.findByRole('heading', { name: 'Prepared conversations' });
fireEvent.click(screen.getByRole('button', { name: 'View evidence for Example Owner' }));
expect(api.begin).not.toHaveBeenCalled();
fireEvent.click(screen.getByRole('button', { name: 'Contact options for Example Owner' }));
await waitFor(() => expect(openPerson).toHaveBeenCalledWith('owner-person'));
expect(api.begin).toHaveBeenCalledTimes(1);
expect(outbound.beginOutbound).not.toHaveBeenCalled();
```

Use complete strict typed fixtures with stable UUIDs. The `outbound` spy observes the actual injected lead API, not a no-op function disconnected from the component tree.

- [ ] **Step 2: Implement the normal flow.** Card evidence and questions are read-only. **Contact options** allocates one UUID per attempt, calls `discovery.begin`, then refreshes and opens the current Person's existing full inspector. No routine Mark ready gate follows. Do not auto-trigger Find contact info after opening; the existing explicit one-lead action remains.

```tsx
<Button disabled={busyPersonId !== null} onClick={async () => {
  const receipt = await begin(brief);
  await refresh();
  onOpenPerson(receipt.personId);
}}>Contact options for {brief.personName}</Button>
```

Catch and display the fixed error in the component/hook without an unhandled promise. Derive all command owner IDs from the strict current brief, not a global selected-name variable.
- [ ] **Step 3: Handle lost replies and stale selection.** Keep the same command UUID for an explicit retry, never generate a new action behind a timeout. Refreshing a Person clears another Person's pending UI state. A stale assessment refusal triggers refresh and explains changed evidence; it does not silently qualify a different assessment. Unmount cancels timers and ignores late UI results.
- [ ] **Step 4: Render evidence and overrides accessibly.** Show dated facts/inferences/unknowns as text with source references, not rendered HTML. Unknown-owner and conflicted-identity records explain the missing fact. Research not configured is honest and nonblocking for deterministic assessment. Override dialog requires a reason and supports watch/exclude/reconsider without closing a sales cycle. Preserve founder manual controls behind an explicit secondary section, not the main prepared workflow.
- [ ] **Step 5: Add the missing explicit manual price-evidence input.** `LogPastActivityDialog` gains an unchecked **I stated the price** checkbox for actual past communication, disabled/reset for internal notes. The founder supplies the real date and summary. Only an explicit checked communication emits `outcome:'price_said'`; unchecked submission retains `null`. After logging and refreshing, the founder selects that Person/Cycle's actual activity ID in the existing inspector and separately confirms `confirm_offered` with current revision. If the newly logged past event is outside the bounded detail history, do not guess its ID or auto-confirm; preserve the successful log and show the normal evidence-selection path. An active Interviewed cycle and current action remain required. A generated trial suggestion, a note containing a currency amount, or opening the dialog cannot create price evidence, an offer, payment or Won.

```tsx
const [priceStated, setPriceStated] = useState(false);
// Inside the existing explicit past-activity submit payload:
const outcome = kind !== 'note' && priceStated ? 'price_said' : null;
// Reset on kind=note, close, or Person change. Render a real labelled checkbox.
```

Add RED tests for unchecked default, checked dated communication, internal-note refusal/reset, duplicate-click protection and actual Interviewed → owned price activity → explicit Offered confirmation. Preserve manual call-outcome and existing founder confirmation rules.

- [ ] **Step 6: GREEN cases:** keyboard focus/Enter/Space in jsdom, real selected Person binding, double-click single command, retry same UUID, timeout, stale fingerprint, invalid response, no network/outbound side effect, memory-only composers unchanged and the explicit conversation-to-offer path. Do not describe jsdom as native keyboard proof.
- [ ] **Step 7: Review and commit:** `feat(discovery): replace routine review with prepared conversation workflows`.

### Task 9: Move the macOS wordmark below window controls

**Files:**
- Modify: `src/renderer/app/{NavigationRail.tsx,shell.css}`
- Create: `src/renderer/app/NavigationRail.test.tsx`
- Extend: `tests/e2e/founderWorkflow.spec.ts`
- Read: `src/renderer/design/tokens.css`, `tests/main/createWindow.test.ts`

**Interfaces:** No new application API. Add `.nav-rail__native-controls` as the Darwin-only top drag row and keep the single `.nav-rail__brand` in the following `.nav-rail__header`. Non-macOS layout stays as before.

- [ ] **Step 1: Write structural RED for Darwin versus non-Darwin and a browser bounding-box assertion.**

```ts
const header = page.locator('.nav-rail__native-controls');
const brand = page.locator('.nav-rail__brand');
const h = await header.boundingBox();
const b = await brand.boundingBox();
expect(h).not.toBeNull(); expect(b).not.toBeNull();
expect(b!.y).toBeGreaterThanOrEqual(h!.y + h!.height);
```

The native packaged observation must also confirm traffic lights remain above the brand; DOM geometry alone cannot locate the OS buttons.

- [ ] **Step 2: Implement the small CSS/component change.** Keep a single wordmark. A platform-scoped empty native-control row precedes the brand row on Darwin; on other platforms it is hidden and the brand retains the old header geometry.

```tsx
<div className="nav-rail__native-controls" aria-hidden="true" />
<div className="nav-rail__header">
  <p className="nav-rail__brand" aria-hidden="true">Callie</p>
</div>
```

```css
.nav-rail__native-controls { display: none; }
body[data-platform="darwin"] .nav-rail__native-controls {
  display: block;
  flex: none;
  height: var(--chrome-header-height);
  -webkit-app-region: drag;
}
body[data-platform="darwin"] .nav-rail__header { padding-left: var(--space-4); }
```

Replace the old 78px avoidance rule, rather than adding another competing selector. Brand remains left aligned with rail content; header drag and interactive no-drag rules stay intact.
- [ ] **Step 3: Run component tests and existing window-chrome tests; add the actual geometry check to final packaged acceptance.** Confirm narrow window/sidebar navigation still fits and focus order is unchanged.
- [ ] **Step 4: Review and commit:** `fix(ui): place Callie below the macOS window controls`.

### Task 10: Assembled source and one-artifact acceptance

**Files:**
- Create: `tests/integration/discoveryWorkflow.test.ts`
- Create: `tests/e2e/discoveryWorkflow.spec.ts`
- Modify: `package.json` only to include the new packaged spec in the fixed E2E list
- Modify: `README.md` only for automatic triage, local processing and optional research configuration limits

**Interfaces:** Exercise actual startup → worker → encrypted store → registrar → preload → Today/inspector. Reuse `tests/integration/outboundWorkflow.test.ts`'s real composition pattern and `tests/support/{founderWorkspace,packagedTestEnvironment,packagedFixtureDatabase}.ts` for packaged fixtures. External provider/Phone/payment ports remain unavailable or strict failing spies.

- [ ] **Step 1: Add assembled RED before calling the feature complete.** Seed at least 35 diverse source-backed owners through intake. Observe an automatically produced shortlist without manual review, inspect citations, prepare one selected record, use existing explicit manual conversation logging and pilot transition requirements, and reopen to prove no duplicate preparation. Include an unknown-owner placeholder, actual conflicting ownership, expiry, override and a source update during assessment.

```ts
await screen.findByRole('heading', {name: 'Prepared conversations'});
expect(manualReviewInvocations).toBe(0);
expect((await api.discovery.get()).prepared.length).toBeGreaterThan(0);
fireEvent.click(screen.getAllByRole('button', {name: /^Contact options for /})[0]);
await waitFor(() => expect(preparationRows()).toHaveLength(1));
expect(phoneDispatch).not.toHaveBeenCalled();
expect(enrichmentUpload).not.toHaveBeenCalled();
```

The test mounts the real FounderApp with actual preload/registrar/domain composition and a controlled scheduler. `manualReviewInvocations` observes the original manual review facade, `preparationRows()` queries the actual encrypted `discovery_preparations` table, and the two failing external spies occupy the real injected ports. Do not substitute a mock shortlist for this acceptance test.
- [ ] **Step 2: Add failure controls.** Temporarily bypass freshness in the test-injected evidence provider and prove the stale test fails. Disconnect the worker from startup in a test-owned dependency and prove the normal-flow test fails. Restore exact source before the final gate. Do not mutate production files just for test controls.
- [ ] **Step 3: Run one complete source gate on the frozen precommit candidate.** Preserve the tested tree hash and logs. Commit exactly that tree in Step 4, verify byte equality, then run the exact-commit source/history secret gate. A commit alone does not require repeating unchanged source suites. Own-file failures are fixed with targeted RED/GREEN before another broad run; do not repeat the whole suite without explaining why.

```sh
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH";
cd /Users/davidcui824/Documents/Codex/2026-08-29/can/callie-founder-sales-system/.worktrees/release-task12-continuation
npm run verify
npm run verify:lambdas
npm run build:operational-tools
git diff --check
```

Because tracked lint excludes untracked new files, stage only the owned reviewed files or run explicit scoped ESLint on every new file before claiming coverage. Preserve historical15 audit graph and source-only upstream constraints. No Lambda deployment is part of `verify:lambdas`.

- [ ] **Step 4: Commit assembled tests/docs:** `test(discovery): verify the assembled automatic triage workflow`. Obtain independent whole-feature review of the frozen source, including current17/historical15 separation and the actual user path.
- [ ] **Step 5: Build and test one new local candidate only after coordinating the package slot.** The existing app is running on real data and its tested bundle must not be overwritten while live. Ask the user to finish/quit normally before replacing that `out/` artifact. Use the existing approved local ad-hoc signing opt-in, not a release identity or publishing command. Package binds the exact committed SHA and preserves the existing manifest/native/extracted-secret checks.
- [ ] **Step 6: Use isolated synthetic profiles for packaged tests.** Run the existing nine E2E files plus discovery workflow and wordmark geometry, one worker, one artifact. Cover nonzero schema16→17 migration with preserved backup, restart assessment resume, no phantom contact/activity/cadence for untouched leads, memory-only drafts, due-follow-up ordering and unchanged app quit/cleanup. Use existing native recovery acceptance helpers where relevant, not new permission demands or a repeated general security audit.
- [ ] **Step 7: Report exactly what passed and what remains unavailable.** Deliver the local build and a short walkthrough: shortlist → evidence → contact options → manual conversation → pilot next step. Automatic triage is not automatically booked meetings, live Phone proof or paid-customer proof. Before upgrading the user's actual workspace, preserve its current stopped encrypted copy and key material using the accepted backup procedure. Never test migrations on the only real copy.

## Commands and commit discipline

Each task's npm command uses this literal prefix, including targeted tests, typecheck and scoped ESLint:

```sh
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH";
cd /Users/davidcui824/Documents/Codex/2026-08-29/can/callie-founder-sales-system/.worktrees/release-task12-continuation
npm run typecheck
```

For scoped lint, derive filenames from the actual staged task after checking that the index contains only its enumerated paths. This executable form safely handles whitespace and includes new files:

```sh
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH";
cd /Users/davidcui824/Documents/Codex/2026-08-29/can/callie-founder-sales-system/.worktrees/release-task12-continuation
node --input-type=module <<'JS'
import { execFileSync } from 'node:child_process';
const files = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'])
  .toString().split('\0').filter(p => /\.(?:[cm]?[jt]s|[jt]sx)$/.test(p));
if (files.length) execFileSync(process.execPath,
  ['node_modules/eslint/bin/eslint.js', ...files, '--max-warnings', '0'], {stdio:'inherit'});
JS
```

Each commit stages only the task's enumerated paths plus documented necessary compatibility fixture edits. Stop for review between tasks, but keep routine file-compatibility choices with the coordinator rather than repeatedly asking the user. No push, install, schema reset, live launch or cloud action follows from source acceptance.

## Spec coverage / self-review checklist

- [x] Outcome, daily shortlist, unknowns and exploration: Tasks 1, 4, 8, 10.
- [x] Real evidence, citations, management/owner boundaries and separate axes: Tasks 1, 3, 7.
- [x] Canonical fact/trigger/projection path and honest automated authority: Tasks 3, 5, 6.
- [x] Versioning, overrides, expiry, retry, restart and cancellation: Tasks 2, 4, 5, 6.
- [x] No mass cadence, paid enrichment, communication or lifecycle fabrication: Tasks 5, 6, 8, 10.
- [x] Actual conversation-to-pilot progression with existing evidence rules: Tasks 4, 8, 10.
- [x] Optional configured research, no borrowed credentials and no closed-app claims: Tasks 1, 6, 8.
- [x] Not-assessed display throughout normal views: Tasks 7–8, verified again in Task 10.
- [x] Wordmark below controls without navigation/drag regression: Task 9, native observation in Task 10.
- [x] Current17 storage/backup/readiness and preserved historical15 tools: Task 2, Task 10.
- [x] Real user workspace untouched by source/fixture work: all tasks.

These checked entries record plan-to-spec coverage only. Implementation steps and runtime acceptance remain unchecked until executed. Root self-review corrected read/write dependency order, exact preload paths, existing rule/type names, nullable display consumers and the missing explicit price-stated workflow.
