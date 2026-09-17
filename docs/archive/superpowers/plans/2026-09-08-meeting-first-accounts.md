# B: PM Accounts and Automatic Preparation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn an approved residential-PM audience into source-backed accounts, useful contact routes and a daily call queue without per-record founder research chores.

**Architecture:** Add account/evidence storage beside existing identities, not fake company-person rows. Persist actual research through new receipts and bounded jobs, share pure ranking between local and worker consumers, and add honest company-route authorization. Keep legacy IDs, relationships and catalogs untouched.

**Tech Stack:** Existing TypeScript/Zod/Kysely/encrypted SQLite, Node fetch, credit-backed OpenAI Responses search/extraction adapter, Vitest. External requests remain authorization-gated; offline tests use captured fictional HTTP.

**Spec:** `docs/superpowers/specs/2026-09-08-meeting-first-fss-design.md`, §§1,3–5,8–10. Read the [coordination plan](2026-09-08-meeting-first-fss.md).

## Global Constraints

- “The acquisition unit becomes a **PM account**, not a parcel or owner name.”
- “Ownership is not management.” “Unknown stays unknown.”
- “It does not ask David to click ‘Find contact info’ for every person.”
- The approximately $20 incremental non-AI target is not a paid-enrichment allowance by itself. No directory/LinkedIn scraping, inferred consent or unapproved paid lookup.
- Shared Node 24, fixtures, scope/activation, migration and commit constraints apply. This plan owns migration 0020 only. Source registration uses independent account contracts, never relaxed old cloud-source schemas.

## File structure

`src/main/domain/accounts/` owns account storage, evidence admission and route authorization. `src/main/research/` owns discovery/fetch/extraction/jobs. `src/shared/accounts/` owns pure ranking and allocation. New validated contracts are `accountContract.ts` and `accountOutboundContract.ts`. The domain facade receives narrow delegation methods only.

### Task B1: Add account identity, evidence and route persistence

**Files:**
- Create: `src/shared/contracts/accountContract.ts`
- Create: `src/main/db/migrations/0020PmAccounts.ts`
- Create: `src/main/domain/accounts/accountRepository.ts`
- Create: `src/main/domain/accounts/accountEvidence.ts`
- Create: `tests/fixtures/pmAccounts.ts`
- Create: `tests/main/accountRepository.test.ts`
- Create: `tests/main/accountEvidence.test.ts`
- Modify: `src/main/db/migrate.ts`
- Modify: `src/main/db/domainSchema.ts`
- Modify: `src/main/db/schema.ts`
- Modify: `src/main/domain/startup/storageReadiness.ts`
- Modify: `src/main/domain/domainRuntime.ts`
- Modify: `tests/main/domainStartupAudit.test.ts`
- Modify: `tests/main/migrations.test.ts`

**Interfaces:** `AccountRepository` consumes the existing scoped database, clock and ID generator. Produces the following strict DTOs and methods. Every write takes a command UUID and compares the account version.

```ts
export type Account = {id:string; name:string; domain:string|null; version:number};
export type AccountRoute = {
  id:string; accountId:string; personId:string|null;
  channel:'phone'|'email'|'linkedin'; value:string;
  purpose:'business'|'tenant_emergency'|'unknown';
  evidenceIds:string[]; verification:'published'|'confirmed'|'unverified'; version:number;
};
export type AccountClaim = {
  kind:'fact'|'hypothesis'|'prospect_stated_problem'; evidenceIds:string[];
} & (
  {key:'portfolio'; value:{count:number; measure:'units'|'buildings'|'properties'; scope:'managed'|'owned'}}
  | {key:'residential_scope'|'operating_footprint'|'maintenance_workflow'|'technology'|'role'|'pain'; value:string}
);
export type AccountEvidenceBatch = {
  commandId:string; accountId:string; expectedVersion:number;
  sources:{id:string; url:string; fetchedAt:string; sha256:string; excerpt:string; permitted:boolean}[];
  claims:AccountClaim[]; routes:Omit<AccountRoute,'version'>[];
};
export type AccountEvidenceSnapshot = {
  account:Account; claims:AccountClaim[]; routes:AccountRoute[];
  portfolio:{count:number; measure:'units'|'buildings'|'properties'; scope:'managed'|'owned'; evidenceIds:string[]}[];
  unknowns:string[]; conflicts:string[]; fingerprint:string;
};
```

Methods: `create({commandId,name,domain}):Account`, `admitEvidence(batch):{accountId,version,duplicate:boolean}`, `snapshot(accountId,asOf):AccountEvidenceSnapshot`, `listCandidates():Account[]`. Add explicit organization/person-role/property links with evidence, relationship and validity dates. Authority remains separately unconfirmed/confirmed, not inferred from titles.

- [ ] **RED:** create a temporary schema-19 database with existing organization/person rows, then migrate. New account-only creation must not fabricate people or alter the old rows. `createPmFixture()` in the new fixture module returns `{db,repo,close}` using existing temp encrypted DB/runtime helpers, not an in-memory repository.

```ts
const f = await createPmFixture();
try {
  const before = f.db.raw.prepare('SELECT * FROM persons ORDER BY id').all();
  const account = f.repo.create({commandId:crypto.randomUUID(), name:'Example PM', domain:'example.invalid'});
  expect(f.db.raw.prepare('SELECT * FROM persons ORDER BY id').all()).toEqual(before);
  expect(account.domain).toBe('example.invalid');
} finally { await f.close(); }
```

- [ ] **Run RED:**

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx vitest run tests/main/accountRepository.test.ts tests/main/accountEvidence.test.ts
```

- [ ] **Implement:** create `pm_accounts`, evidence-bearing account-organization/person-role/property links, account routes, source receipts, claims, command receipts and bounded research-job state. Include `pm_account_outbound_intents` and append-only `pm_account_outbound_results` for B4's exact route/target/version, command fingerprint, attempt identity and truthful outcome records in this migration. Foreign keys bind every claim/route to account-owned evidence; store command fingerprint/result atomically. Domain/name equality suggests a possible match, never silently merges franchises, brands and legal owners. Admit a supported count only with explicit measure/scope; preserve contradictions and null/unknown projections.

```sql
CREATE UNIQUE INDEX pm_account_command_once ON pm_account_commands(command_id);
CREATE UNIQUE INDEX pm_account_source_receipt_once ON pm_account_sources(account_id, source_key);
```

Use existing migrations/Kysely conventions, strict input parsing, maximum excerpt/URL/value lengths, integer/nonnegative counts and transaction rollback. A `permitted:true` field alone is not trusted input from the model; only the B2 source-policy adapter may attest it. Cross-account evidence references fail. Update schema version/ledger/generated hash together. Retain exact historical fixtures and never modify old catalog payloads.

- [ ] **GREEN:** test command replay/conflict, stale versions, conflicting unit counts, title-versus-authority, business versus emergency routes, cross-account evidence and schema-19 historical equality. Run startup/migration suites plus typecheck/lint.
- [ ] **Commit:** stage B1 paths only, message `feat: add evidence-backed PM account storage`.

### Task B2: Discover companies and persist real bounded research

**Files:**
- Create: `src/main/research/companyDiscoveryProvider.ts`
- Create: `src/main/research/companyPageProvider.ts`
- Create: `src/main/research/companySourcePolicy.ts`
- Create: `src/main/research/companyResearchWorker.ts`
- Create: `src/main/research/companyResearchTypes.ts`
- Create: `tests/main/companyResearchWorker.test.ts`
- Create: `tests/main/companyPageProvider.test.ts`
- Create: `tests/integration/companyResearchRestart.test.ts`
- Modify: `src/main/startApplication.ts` with coordinator-owned wiring
- Modify: `src/main/domain/accounts/accountRepository.ts` to implement the research-job store contract

**Interfaces:**

```ts
export type ResearchLimits = {maxCompanies:number; maxPages:number; maxBytes:number; maxCostMicros:number};
export type AudienceQuery = {residential:boolean; regions:string[]; terms:string[]};
export interface CompanyDiscoveryPort {
  discover(query:AudienceQuery, limits:ResearchLimits, signal:AbortSignal):Promise<{name:string; domain:string; sourceUrl:string}[]>;
}
export interface CompanyPagePort {
  research(snapshot:AccountEvidenceSnapshot, limits:ResearchLimits, signal:AbortSignal):Promise<AccountEvidenceBatch>;
}
export type ResearchJob = {id:string; accountId:string; limits:ResearchLimits; attempt:number; claimToken:string};
export type AccountEvidenceReceipt = {accountId:string; version:number; duplicate:boolean};
export interface AccountResearchStore {
  create(input:{commandId:string; name:string; domain:string|null}):Account|Promise<Account>;
  snapshot(accountId:string, asOf:string):AccountEvidenceSnapshot|Promise<AccountEvidenceSnapshot>;
  admitEvidence(batch:AccountEvidenceBatch):AccountEvidenceReceipt|Promise<AccountEvidenceReceipt>;
  enqueue(input:{commandId:string; accountId:string; limits:ResearchLimits}):void|Promise<void>;
  claimNext(asOf:string):ResearchJob|null|Promise<ResearchJob|null>;
  settle(input:{jobId:string; claimToken:string; status:'completed'|'parked'; receiptCommandId:string|null; costMicros:number|null}):void|Promise<void>;
}
// Worker owns durable claim/reservation/attempt/receipt transitions.
export interface CompanyResearchWorker { runNext(signal:AbortSignal):Promise<'completed'|'parked'|'idle'>; }
```

- [ ] **RED:** fictional HTTP discovery returns an appropriate company URL, a solicitation-prohibited directory, a LinkedIn profile and a private-network redirect. Only the permitted company can enter page research. Crash after receipt commit and restart must not charge or persist twice.

```ts
expect(companySourcePolicy('https://www.narpm.org/find/property-managers/')).toBe('blocked');
expect(companySourcePolicy('http://127.0.0.1/private')).toBe('blocked');
expect(companySourcePolicy('https://www.linkedin.com/in/example')).toBe('manual_only');
```

Export `companySourcePolicy(url):'candidate'|'manual_only'|'blocked'`. `candidate` still needs permitted-source checks, not automatic permission.

- [ ] **Run RED:**

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx vitest run tests/main/companyResearchWorker.test.ts tests/main/companyPageProvider.test.ts tests/integration/companyResearchRestart.test.ts
```

- [ ] **Implement concrete adapters:** use the existing OpenAI HTTP/credential boundary for a Responses search request returning candidate company domains and citations, with search/tool costs reserved separately from model-token estimates. Confirm the configured model/tool capability before enabling it. Search snippets are candidate discovery, not admitted facts. Fetch bounded permitted company/service/team/careers pages with redirect/DNS/private-network protections and cancellation; do not fetch LinkedIn behind the user's session. Extract strict account claims with exact supporting excerpts/source IDs and label hypotheses separately. Never convert an advertised emergency line into a prospecting route or a 24/7 claim into stated pain.

```ts
const snapshot = await repo.snapshot(job.accountId, clock.now());
const batch = await pages.research(snapshot, job.limits, signal);
if (signal.aborted) return 'parked';
await repo.admitEvidence({...batch, accountId:job.accountId, expectedVersion:snapshot.account.version});
```

`job` is a durable B1 research-job row claimed by the worker; `pages` implements `CompanyPagePort`, `repo` implements `AccountResearchStore` and `clock` is the existing injected string-valued Clock adapter. B1's local repository supplies the synchronous binding; C1 supplies the asynchronous DynamoDB binding. This task adds the explicit enqueue/claim/settle methods to the local repository, backed by B1's job tables. Claims reserve the configured request budget and carry a unique fencing token; settlement compares that token and references the idempotent evidence command receipt. Unknown cost remains unknown, not zero. A crash after evidence commit resumes settlement from its receipt without another provider request. Limit retries per substantive input to three. No real provider call in constructors, tests or unconfigured startup. One bounded operational issue replaces per-person review cards. Persist additional external knowledge through B1, not the old discard-only discovery completion method. The same provider logic must be worker-buildable without importing Electron or SQLite, and research-only account events never grant execution authority or enroll an account.

- [ ] **GREEN:** actual adapter JSON parsing/HTTP fixtures, unsupported model/tool, no key, timeouts, stale account revision, malicious text instructions, source conflicts, duplicate receipt, budget exhaustion and restart tests. Negative control: replace discovery with an empty result and assert the assembled account-preparation test fails on absent researched accounts.
- [ ] **Commit:** stage B2 paths only, message `feat: prepare PM accounts from bounded company research`.

### Task B3: Rank PM evidence and retain daily new calls alongside warm work

**Files:**
- Create: `src/shared/accounts/accountRanking.ts`
- Create: `tests/main/accountRanking.test.ts`
- Create: `tests/main/dailyAccountCalls.test.ts`
- Modify: `src/main/domain/today/todayOrdering.ts`
- Modify: `src/main/domain/today/todayService.ts`
- Modify: `src/main/domain/workspace/workspaceSettingsRepository.ts`
- Modify: `src/shared/contracts/todayContract.ts`
- Modify: `tests/main/playbookDueActions.test.ts`
- Modify: `tests/integration/todayOrderingSqlParity.test.ts`

**Interfaces:** `rankAccount(snapshot,asOf):AccountRank` returns `{accountId,fit:'supported'|'uncertain'|'not_target',contactable:boolean,reasons:{text,evidenceIds}[],unknowns:string[],fingerprint}`. `planDailyAccountCalls({due,ranked,newCallSlots,completedAccountIds,totalCallCapacity}):DailyAccountCallPlan` returns `{accountIds:string[],workloadConflict:boolean}`. Inputs `due` and `ranked` are ordered account ID arrays already filtered for authorization. `newCallSlots` is a configured nonnegative integer, not a silently adopted forty-call quota. `totalCallCapacity:number|null` is a separately configured nonnegative capacity, with null meaning no total limit was configured.

- [ ] **RED:** warm work plus one eligible cold account retains both; duplicates and already-completed new calls do not consume another slot. Advertised 24/7 service has no prospect-stated-problem evidence.

```ts
expect(planDailyAccountCalls({due:['warm'],ranked:['cold','warm'],newCallSlots:1,completedAccountIds:[],totalCallCapacity:null}))
  .toEqual({accountIds:['warm','cold'],workloadConflict:false});
```

- [ ] **Run RED:**

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx vitest run tests/main/accountRanking.test.ts tests/main/dailyAccountCalls.test.ts tests/main/playbookDueActions.test.ts
```

- [ ] **Implement:** rank supported residential/regional fit and appropriate route first, supported operating relevance next, geographic proximity only as a bonus. Return evidence reasons and unknowns, not a fake intent probability or owner-unit threshold. The meeting-first mode consumes this shared rank; old local/cloud owner-scoring versions remain historical/legacy, not used to score PM accounts. C1's worker imports the same pure module and verifies parity. Allocation keeps due promises before new work without global warm suppression:

```ts
const uniqueDue = [...new Set(due)];
const newIds = [...new Set(ranked)].filter(id => !uniqueDue.includes(id) && !completedAccountIds.includes(id));
const accountIds = [...uniqueDue,...newIds.slice(0,newCallSlots)];
return {accountIds,workloadConflict:totalCallCapacity !== null && accountIds.length > totalCallCapacity};
```

Report workload conflict when the separately configured total capacity is below due obligations plus new-call allocation. Keep both visible rather than discarding either to satisfy a cap. Count only B4's explicit user-reported actual call attempts, not card views, handoffs or old metadata inferred as receipts. Preserve legacy suppression tests under legacy mode and add SQL/JS parity for meeting-first mode.

- [ ] **GREEN:** main/SQL parity, unknown/stale evidence, local/worker shared-module parity, callbacks, urgent-capacity conflict and zero/unset setup cases. Before activation collect allocation/cap choices once with the campaign setup, not daily.
- [ ] **Commit:** stage B3 paths only, message `feat: prioritize PM accounts while preserving daily new calls`.

### Task B4: Authorize genuine company routes without fake people

**Files:**
- Create: `src/shared/contracts/accountOutboundContract.ts`
- Create: `src/main/domain/accounts/accountOutreach.ts`
- Create: `src/main/communications/accountOutboundService.ts`
- Create: `tests/main/accountOutreach.test.ts`
- Create: `tests/integration/accountOutboundWorkflow.test.ts`
- Modify: `src/main/domain/createDomainServices.ts`
- Modify: `src/main/domain/founderSalesDomain.ts` only narrow delegates

**Interfaces:** `AccountOutboundRequest={commandId,accountId,routeId,expectedRouteVersion,expectedEvidenceFingerprint,channel:'call'|'email'}`. `authorizeAccountRoute(input):AccountRouteAuthorization` returns `{kind:'allowed',canonicalTarget,contextRevision}` or `{kind:'blocked',reason}`. `createAccountOutboundService` consumes scoped account/domain transactions, A2's phone port, A1's `checkSubject({kind:'account',id},signal)`, and later C6's execution router. It exposes `begin(request)` and `reportCallOutcome({commandId,attemptId,outcome,notes})` with idempotent receipts. Company-only account IDs must never be passed to A1's legacy person wrapper.

- [ ] **RED:** a public business switchboard can be a company route with `personId:null`; a tenant emergency number cannot. An opted-out linked person/normalized handle and an account-wide opt-out block it. Publishing an email is not a permitted-send basis.

```ts
expect(authorizeAccountRoute({...request, route:emergencyRoute}).kind).toBe('blocked');
expect(authorizeAccountRoute({...request, route:businessRoute, suppression:blockedHandle}).kind).toBe('blocked');
```

Define `request`, `emergencyRoute`, `businessRoute`, and `blockedHandle` in the new fixture from B1's real records; test calls through the production authorizer, not a test-only policy copy.

- [ ] **Run RED:**

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx vitest run tests/main/accountOutreach.test.ts tests/integration/accountOutboundWorkflow.test.ts
```

- [ ] **Implement:** check current route/evidence versions, business purpose, explicit verification/compliance and local-time policy, person/handle/account suppression, owner generation and enabled-adapter freshness. Reuse existing phone authorization rules through a normalized route-policy input, not by downgrading DNC/validation. Store account-scoped intent/result records with the same no-retry unknown semantics as legacy outbound. Exact target/version remains frozen.

```ts
const result = authorizer.authorizeAccountRoute(request);
if (result.kind === 'blocked') return repository.recordRefusal(request, result.reason);
const intent = repository.reserve(request, result.contextRevision);
return dispatcher.dispatchReserved(intent, result.canonicalTarget);
```

The three methods are owned by this task: `recordRefusal` and `reserve` are account-transaction methods; `dispatchReserved` invokes the phone port immediately after committed authorization, observes the outcome and appends a receipt. No await between final preparation and external invocation. Email routes go through C4/C6 for delegated accounts, with explicit requested-follow-up/approval evidence. Before C is connected, email execution stays unavailable, while drafting and manual call tests work. A reported call outcome is separate evidence from Apple handoff and drives B3's completed-attempt accounting.

- [ ] **GREEN:** real SQL account-only call workflow, stale route, opt-out race, unknown dispatch/restart, cancellation/no-call count and no invented Person row. Preserve existing person/outbound/email suites.
- [ ] **Commit:** stage B4 paths only, message `feat: authorize account business routes without fabricated people`.

### Task B5: Prove automatic preparation and historical preservation

**Files:**
- Create: `tests/integration/accountMigrationPreservation.test.ts`
- Create: `tests/e2e/accountPreparation.spec.ts`
- Modify: `tests/fixtures/recovery.ts`
- Modify: `tests/support/migrationBackupScenario.ts`
- Modify: `tests/integration/migrationBackup.test.ts`
- Modify: `tests/integration/restoreDrill.test.ts`
- Modify: `src/main/db/plaintextDatabaseUpgrade.ts` only its registered known-version admission
- Modify: `src/main/backup/preReleaseBackupRuntime.ts` only its current-schema receipt admission

**Interfaces:** Consumes B1–B4 production services and HTTP-boundary fixtures. Produces acceptance metadata and explicit legacy-row comparisons, not a relabeled current database.

- [ ] Build a genuine schema-19 fixture with identities, source receipts, historical catalogs, callbacks, drafts, unknown sends and opt-outs. Snapshot named historical columns in stable order, upgrade through actual registered migrations and compare exact values plus foreign-key integrity. Version-aware new fields are checked separately rather than omitted from all preservation assertions.
- [ ] RED/GREEN the assembled fictional flow: approved audience → real discovery adapter fixture HTTP → company pages → durable B1 evidence → B3 queue → B4 route readiness. Restart between research receipt and projection. No direct success stub may create the final contact.

```ts
expect(after.historicalRows).toEqual(before.historicalRows);
expect(after.unknownSendStates).toEqual(before.unknownSendStates);
expect(after.enrollments).toEqual([]); // Migration alone never launches a campaign.
```

- [ ] Run:

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx vitest run tests/integration/accountMigrationPreservation.test.ts tests/integration/companyResearchRestart.test.ts tests/integration/migrationBackup.test.ts tests/integration/restoreDrill.test.ts
```

- [ ] Update every schema gate/admission actually used by startup, plaintext upgrade, pre-release backup and E2E helpers. Generate exact hashes, preserve older accepted historical restore fixtures, reject future versions. Do not rewrite unrelated runtime logic to satisfy a fixture. The coordinator verifies listed paths against the current checkout before edits.
- [ ] After separate authorization, run a small actual public-company cohort through the configured adapters, inspect source-backed extraction/route quality, and report missing routes, error/cost/credit use and edit burden. This is not permission to call or email the cohort. Fake HTTP proves integration shape, not real prospect quality. Real-workspace migration remains D5's separately approved operation.
- [ ] Commit only B5 test/admission/doc changes, message `test: prove PM preparation and legacy-data preservation`.
