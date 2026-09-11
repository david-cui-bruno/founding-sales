# First-use workflow repair specification

Date: 2026-09-10. Findings: F08, F09 and F10 in [the adversarial audit](../../engineering/2026-09-10-adversarial-product-audit.md). Binding coordination: [whole-product repair program](../2026-09-10-product-repair-program.md). Execution recipe: [implementation plan](../plans/2026-09-10-first-use-workflow-repair.md).

**Status: documentation proposal, implementation HOLD.** The assignment authorizes only this spec and its plan. The coordinator owns implementation/runtime GO, finding disposition and commits. This document is not evidence that a workflow works, that a test failed or passed, or that any account, contact, source, grant or provider is approved.

## 1. Outcome and scope

Complete a useful local first-use preparation journey:

1. Review/create or select exactly one local company using the existing intake.
2. Explicitly research that selected company through the existing bounded researcher, or show the exact missing-capability hold.
3. Inspect admitted source URL, fetch time, hash and plain-text excerpt, claims, unknowns and conflicts.
4. Import a user-supplied named person through the existing global import review, or select an existing saved person. Review the relationship against exact company-source quotations before admitting one real account/person link.
5. Select that person's actual saved contact route in the existing contact workspace and create/save/reopen an unsent local email draft. Generic company routes remain company routes.
6. Reach distinct real phone, worker and call-capacity settings. Preserve every independent send, handoff and owner-authority gate.
7. Make campaign, requested-follow-up, LinkedIn and reply surfaces truthful about which first-use actions actually exist.

This is an architectural join repair, not a new research/contact/campaign/security subsystem. The chosen minimum reuses actual intake, source admission, import, contact workspace, email draft, phone confirmation, worker pairing and capacity CAS services. It uses the audit's explicit **read-only capability preview/history alternative** for incomplete campaign/reply/worker-draft starts. That alternative must receive coordinator disposition before F10 is called closed. A small campaign cannot currently be authored/enrolled through this UI, and this plan does not pretend otherwise.

### Global constraints

- No production edits, execution, tests or commits under documentation-only GO.
- Coordinator owns implementation/runtime GO, acceptance scheduling and commits. One implementation worker at a time.
- Use disposable fictional workspaces for future acceptance. No installed app, real profile, keys, real-data research, grants, deployment, send, call or calendar write is authorized.
- No offline product mode, new security framework, new provider, new queue, scheduler or generic execution endpoint.
- Preserve identity, aliases, history, suppression, consent, account/contact versions, CAS, fingerprints, OriginalCallRef, command receipts and exact authority/approval gates.
- Never infer a person's direct route from a company office phone, team mailbox or company LinkedIn publication. Role/title is not decision-making authority.
- No queue-wide prepare/runNext shortcut for selected-company research. No automatic research, import, pairing, configuration, sync, bootstrap, generation, approval or execution on route mount/refresh.
- Preserve common presentation and modal ownership. Preserve the global contact/import owners and existing durable draft/unknown-command sessions.
- Future npm/npx invocations require `export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"`. Preserve existing ABI137. Never rebuild native dependencies to hide a failure.

## 2. Source checkpoint and evidence

Primary design read: `/Users/davidcui824/.jcode/scratch/fss-product-repair-20260910/first-use-design.md`, SHA-256 `694610a356b74cc359e8ffaef496f417dfef75e6bab558832175f8583cd222d4`.

Selected source-only checkpoint hashes, captured during planning, not an atomic clean-tree or exact-head certification:

| File | SHA-256 |
| --- | --- |
| `docs/superpowers/2026-09-10-product-repair-program.md` | `97e300046f2fa4d87db52baf7f43811e9e94c4a2c228eb7eddd78af9a9f6da5d` |
| `docs/superpowers/plans/2026-09-10-list-reliability-repair.md` | `d1156fe70f7bb905868edbd11fbbb4777e0089214dbc09ba9783b28825120051` |
| `docs/superpowers/plans/2026-09-10-shared-presentation-repair.md` | `e966abca2e9e83cb238e301d4e8585f4d3e7378b5997834402753a2579f6142d` |
| `src/main/domain/accounts/accountRepository.ts` | `3359356079c16f1e66cd9583ec89f81e6f1e31048783bcbea8cef41faaf20738` |
| `src/main/startApplication.ts` | `c64971131f6ec5c7e5f50027f2c2ef23a20e13454c9e2a3daa3882a3131766e9` |
| `src/renderer/app/FounderApp.tsx` | `0752e118e29f2a9d653ff3cfb2535666dcca5c1f82c703699206b6ab70a4faab` |
| `src/renderer/app/routeRegistry.tsx` | `b4e354215f93451ee53bd9e0648b32f8880a06a6c469559707ca0d7d1f3444d0` |
| `src/shared/contracts/outreachContract.ts` | `ca700e2b5f0a8fb97e02baff5505b7cb7c8834b0cccdd3aba1d7a6bbd49ef34f` |
| `src/renderer/features/today/NativeDeskRoute.tsx` | `04f0baa785a26bf29ba846d9fb4c60a31b754ed4f45cc91d995fce786d84c932` |

The checkout is shared and dirty. Re-read/re-hash handed-off files before implementation. Current `FounderApp.tsx` already contains a lifecycle-cleaned `callie:open-import` listener, unlike the original audit snapshot. Preserve it, do not claim F12 remains unrepaired or duplicate the listener. It still keys route content by route/refresh, so account continuation cannot live only inside Accounts.

### Existing interfaces verified in source

| Area | Actual owner/interface | Consequence |
| --- | --- | --- |
| Local bridge | `src/main/workspace/localWorkspaceProvider.ts`, `registerLocalWorkspaceIpc.ts`, `src/preload/apis/localWorkspaceApi.ts`, `src/shared/contracts/localWorkspaceContract.ts` | Extend the real provider/validated registrar/preload path, not a domain-only test adapter. Registrar is under `workspace`, not `ipc`. |
| Composition | `src/main/ipc/registerApplicationIpc.ts:306`, `src/main/startApplication.ts:232-292` | Supply a getter for the current startup research capability. Never capture disposed capability across lock/reconfiguration. |
| Research | `CompanyPagePort.research(snapshot, limits, signal)` and `createCompanyResearchWorker(...).runNext(signal)` | Keep the worker. Scope its local store's claim before any queue mutation. Startup `prepare` discovers/creates many companies, startup `runNext` claims globally. |
| Accounts | `AccountRepository.admitEvidence`, `admitLinks`, `snapshot`, `listLinks`, `enqueue`, `claimNext`, `settle` | Existing atomic receipt/CAS/source-admission machinery is authoritative. `snapshot` omits sources and links. |
| Import | `imports.preview/remap/commit/status`; receipt includes `importedPersonIds` | Reuse global review/duplicate handling. No auto-link by import result/name/company and no forced-person import API. |
| Contacts | `leads.list({query,stages,priorities,sort,cursor,limit})`, `leadDetail.get({personId})`, `RouteContext.openLead(personId)` | Keep exact IDs and real continuation cursor. F06 owner changes cursor behavior, not this public request shape. |
| Local email | `outreach.openDraft`, `saveDraft`, `generateDraft`, `sendDraft`; `emailDraftSession.ts` | Opening a new configured-model draft can generate immediately. Unconfigured-model drafts are manually editable. Neither is a send. |
| Authority | `assertLocalEmailAuthority` in `src/main/delegation/executionRouter.ts:47-61` | Every account association requires matching paired local authority. A new link can correctly hold legacy Send. Never remove a link or bootstrap to evade it. |
| Phone | `phoneSetup.status/confirm({expectedFingerprint})/clear` | Already registered and public, missing Settings consumer. Confirmation is handoff readiness, not consent or connected-call evidence. |
| Worker | `delegation.status/pair/configure/sync` in `src/preload/createCallieApi.ts` | Status cannot prove remote mailbox/calendar grants. Sync can retry queued commands and is not refresh. |
| Capacity | `WorkspaceSettingsRepository.readMeetingFirstAccountCallSettings/updateMeetingFirstAccountCallSettingsCas` | Writer requires its matching `DomainUnitOfWork.immediate` scope. Null is unconfigured, zero is intentional. |
| Campaigns/replies | `CampaignReview.tsx`, `DailyAnswers.tsx`, `NativeDeskRoute.tsx` | Hash-only audience cannot support approval. Saved replies are held, not actionable approval work. |

## 3. Selected-company research contract

All types below are **proposed additions**, not existing APIs. Add strict schemas and types to `localWorkspaceContract.ts`, reusing account IDs, instants, sources, links and the existing `dailyAccountSchema` snapshot shape.

```ts
export type SelectedCompany = { accountId: string };
export type SelectedResearch = { commandId: string; accountId: string };
export type LocalCompanyDetail = {
  scope: 'local_database'; generatedAt: string;
  snapshot: AccountEvidenceSnapshot; sources: AccountSource[]; links: AccountLink[];
};
export type LocalCompanyResearchStatus = {
  commandId: string; accountId: string;
  state: 'not_recorded' | 'queued' | 'running' | 'completed' | 'parked' | 'held';
  receipt: AccountEvidenceReceipt | null; reason: string | null;
};
// LocalWorkspaceApi additions:
getCompany(input: SelectedCompany): Promise<LocalCompanyDetail>;
researchCompany(input: SelectedResearch): Promise<LocalCompanyResearchStatus>;
getCompanyResearchStatus(input: SelectedResearch): Promise<LocalCompanyResearchStatus>;
```

- `commandId` is a UUID. A response is bound to the exact input account/command at both registrar and preload boundaries. Account routes and source/link references must belong to that account. All selected detail arrays are complete, not silently capped lists.
- Main-only repository additions: `readLocalCompanyDetail(accountId: string, asOf: string): LocalCompanyDetail`, `readSelectedResearch(input: SelectedResearch): LocalCompanyResearchStatus`, `claimSelected(asOf: string, input: SelectedResearch): ResearchJob | null`.
- Detail reads snapshot, admitted source records and active links inside one read transaction. Display admitted excerpts as text, never `innerHTML`. Read failure is unavailable, not empty.
- Repository job `command_id` is the user's research command. Job `id` is a separate generated UUID used as the evidence receipt command. Status must follow the job's actual receipt identity and validate account binding. It must not search `pm_account_commands` using the UI command as though these IDs were equal.
- `completed` requires a committed matching evidence receipt, even if settlement was interrupted. `running` without receipt remains uncertain. `parked` retains uncertain spend and never means no external effect. `held` represents unavailable execution capability before a new enqueue. SQL status is read-only and does not settle, claim or retry.
- Selected claiming scopes **all three** paths by exact `command_id` plus `account_id`: committed-receipt recovery, expired-running parking, and queued selection. Global spend remains global. Existing attempt/fingerprint limits remain unchanged. Do not claim an unrelated job and reject it afterward.
- Existing jobs reuse saved `limits_json`. A changed configuration must not silently alter an existing command's fingerprint. A reused command for a different account is a conflict, not an empty status. A new UUID is permitted only for a deliberate new attempt after the old outcome is known.
- Main composition adds `SelectedCompanyResearchPort = { researchCompany(input: SelectedResearch): Promise<LocalCompanyResearchStatus> }`. Extend startup capability with that method and `createLocalWorkspaceProvider(runtime, research?: { current(): SelectedCompanyResearchPort | null })`. Getter is supplied via application IPC registration. Status reads SQL even without the execution capability.
- Reuse startup lifetime cancellation, single-flight guard, runtime leases, fetched-receipt policy and approved limits. Adapt the local `AccountResearchStore.claimNext(asOf)` to call `claimSelected(asOf, input)`, then call the unchanged worker. No cloud-store signature widening.
- Fetch outside SQL write transactions. Keep per-callback database leases, source attestation and final account-version CAS. Missing domain/configuration/allowlist/budget is a hold, never a hidden configuration mutation.
- Existing HTTPS/domain and `www` allowlist, public-address pinning, redirects, byte/page/time limits and manual-only/blocked source policies remain untouched. The page extractor emits `personId: null`, `verification: 'published'` company routes and withholds emergency/tenant targets.

### Explicit selected-research recovery

Review correction checkpoint: prechange spec SHA-256 `db1d760ac036700cd489391348a025e3bba9d82cb1cc5c6e9a230e45ed873fe8`; prechange plan SHA-256 `ba530985cec55cde6d465cb203923c55c0b0124f085b542c914782d61c2ba02a`. This correction addresses only Deer's missing same-request recovery finding. Other dispositions/file ownership remain outside this narrow correction.

Provide two distinct controls for the retained frozen research request:

- **Check status** calls only `getCompanyResearchStatus(originalFrozenRequest)`. It can read on an explicit check or a read-only refresh, but never claims, settles, enqueues or fetches. It must not clear a genuinely pending execution merely because it returns `not_recorded`, `queued` or `running`.
- **Resume research** is an explicit execution action, labeled “May fetch permitted sources or reconcile this existing attempt.” It calls `researchCompany(originalFrozenRequest)` with the same command/account, never a new UUID or modified payload. Offer it for known queued/running/held work or an unknown outcome after the prior renderer invocation has settled or been invalidated by the existing runtime lifetime. An unknown followed by `not_recorded` retains that original request and can be explicitly replayed eventually. `not_recorded` alone is not proof that the original request never started.
- A genuine in-flight invocation stays protected: Resume is disabled while the retained operation is pending. Main independently uses its existing single-flight/lifetime guard, including across UI remounts or a lost response. A busy result preserves the same request for later checking, not a parallel acquisition. Resume enters the existing exact selected claiming path, preserving global spend, saved limits, claim fencing and committed-receipt recovery. Existing unexpired running work is not fetched again; expired ambiguous work parks rather than reacquires. Committed evidence can reconcile without HTTP.
- Never invoke Resume from mount, polling, capability restoration or a status result. Never automatically retry parked ambiguous spend or replace its command. Parked work stays parked with its reservation retained; any separately offered new attempt requires explicit new-intent review under the existing budget/attempt policy and is not Resume.

Required planned REDs: start with a persisted selected queued command, make capability/budget unavailable, restore permitted capability, show that checks/refresh do no work, then explicitly Resume and complete that same command without touching an older unrelated job. Separately lose a response, observe unknown then `not_recorded`, explicitly replay the retained request when no invocation is genuinely pending, and prove one selected job/receipt and unchanged UUID. Include a late original invocation racing that replay, a double Resume, unexpired running work and parked ambiguous spend: no concurrent fetch, no unrelated claim, no automatic work or released reservation. These are future checks, not observed results.

## 4. Real person and contact-route admission

**Chosen minimum:** named-person/contact-method admission is the existing import pipeline. Relationship admission is a new narrow reviewed account link. These are two real persisted operations, not a decorative contact card or a fabricated `AccountRoute`.

```ts
export type ReviewedPersonLink = Extract<AccountLink, { kind: 'person_role' }> & {
  authority: 'unconfirmed'; authorityEvidenceIds: []; validTo: null;
};
export type LinkCompanyPersonRequest = {
  commandId: string; accountId: string; expectedVersion: number;
  link: ReviewedPersonLink;
  sourceQuotes: { sourceId: string; quote: string }[];
};
// LocalWorkspaceApi addition:
linkCompanyPerson(input: LinkCompanyPersonRequest): Promise<AccountEvidenceReceipt>;
// Main-only AccountRepository addition, same input/return:
admitReviewedPersonLink(input: LinkCompanyPersonRequest): AccountEvidenceReceipt;
```

The request is immutable through pending/unknown outcome. Strict schema admits one person-role link only, unconfirmed authority and no authority evidence. Unique source IDs must equal the link evidence set, with at least one nonempty exact quotation per referenced source. Bound quotes to the admitted excerpt limit of 12,000 characters and source count to the account evidence maximum of 100. Validate time, nonfuture `validFrom`, current account version, saved nondeleted/nonsuppressed person and exact source ownership inside the same account mutation transaction. Reuse private insertion mechanics rather than nesting `admitLinks()` or nesting an import transaction. Receipt replay precedes rejection of a later account version, and the command fingerprint includes quotations and every reviewed field.

The main service verifies provenance and stored identity references, **not natural-language identity truth**. The UI explicitly shows source URL/quote, exact saved person's name/ID and actual email/phone ownership/validation evidence. The user confirms the quoted relationship. Same name/company is insufficient. If the source identifies only an office/team, keep “Contact not established.” Role confirmation does not confer decision authority.

A person-specific email supplied by the user is reviewed and saved through `imports.preview/remap/commit`, then selected through `leadDetail.get`. Do not prefill import from company phone/team-email routes. Current import defaults of `validationState: 'valid'` and `reachability: 'direct'` do not prove ownership. Show the separate `ownershipState`, source evidence and validation state, without upgrading to `verified_person`. Linking does not rewrite person contact methods, aliases, organizations, consent, or PM account routes. The actual contact-method ID used by Email is resolved by the existing contact workspace, not inferred from a company route.

This route admission is real storage through the importer, but is not independent identity or route verification. If the coordinator requires a **new person-bound PM AccountRoute or independently verified direct ownership**, stop before F08 disposition and scope that separately. This minimum must not report that stronger result. Existing documentary phone policy import remains a separate, pairing/native-review-gated flow, not route permission manufactured from a quotation.

### Navigation and unresolved commands

Reuse `RouteContext.openImport()` and the sole `FounderWorkspace` ImportDialog. After import, return to the same account and select the saved person explicitly, no auto-link. Accounts passes `onOpenLead` for saved reviewed links only.

The F11 continuity owner must supply a workspace-scoped owner above keyed routes. It retains selected account, source/link review input and exact pending research/link requests across route changes/import refresh. Workspace replacement/lock must prevent cross-workspace reuse and clear rendered private material according to existing lifecycle rules, while unresolved SQL command identities remain recoverable on the same workspace. Research unknown outcomes use read-only status checks plus explicitly chosen same-request Resume through the existing execution guards, as specified above. Status checks alone never resume work. Link unknown outcomes use explicit same-request replay, not a matching row treated as the original command receipt. No unreviewed replacement UUID on remount.

## 5. First local draft and truthful Send hold

Use `LocalAccountDetail → onOpenLead(personId) → LeadInspectorProvider → InspectorOverview Email → OutboundComposer → emailDraftSession.open() → outreach.openDraft()`.

Before Email is clicked, disclose: “Opening Email may use configured AI to prepare a draft. It does not send.” Do not claim that opening is provider-free when `emailService.ts:64` automatically generates a new draft with a ready model. Fictional acceptance keeps model/Gmail unconfigured and proves manual persistence only.

**Narrow revision to the scratch design:** public `EmailDraft` has no `contactSnapshot`. An ownership read keyed only by person/contact cannot let the renderer prove that it matches the saved draft snapshot. Prefer an exact saved-draft-bound read rather than adding raw contact snapshots to every draft:

```ts
export type LocalEmailAuthorityRead = {
  draftId: string; expectedRevision: number;
  personId: string; contactMethodId: string;
  state: 'allowed' | 'held';
  reason: 'email_authority_unavailable' | 'email_contact_changed' | null;
  checkedAt: string;
};
// OutreachApi addition:
inspectLocalAuthority(input: DraftRevisionRequest): Promise<LocalEmailAuthorityRead>;
```

`emailService` loads the saved draft at the exact revision in a read transaction, loads its current contact row, compares the real stored contact snapshot/person/email, and calls the existing `assertLocalEmailAuthority` with the same configured `expectedWorkspaceId` as Send. Identity mismatch returns held or a safely rejected read. An `allowed` result means only that this ownership fence passed at `checkedAt`. Missing, failed, stale-revision or held read keeps Send disabled. Refresh after focus/settings changes and after saved draft revision changes, with response-generation guards. Keep existing caller `sendBlockedReason` and combine it with this internal hold, never replace it. Saving/manual drafting remains available.

Do not call email initialization/recovery mutation merely to perform this read. Retain service epoch/lock/disposal guards. Readiness cannot authorize future Send: final `authorizeEmail`, suppression, qualification, cycle, sender identity, exact contact snapshot and authority checks remain authoritative in the existing reservation path. Provider acceptance is not delivery or a conversation. Preserve serialized saves and unknown-send recovery in `emailDraftSession`.

## 6. Truthful settings and capacity

Add Settings destinations with distinct IDs: existing `connections` = desktop email/AI, new `phone` = Phone handoff, `worker` = Worker connection, `call-capacity` = Call capacity. Keep `callie:open-connections` behavior for existing callers. Extend the existing session-storage/event navigation convention through a narrow `openSettingsSection(section)` helper, not a new router.

Phone section consumes existing `PhoneSetupApi` only. Mount/refresh reads status. Explicit Confirm submits the currently displayed `expectedFingerprint`, with synchronous pending fence. Clear calls the existing clear API. A stale candidate is not confirmed. Show unconfigured/unavailable/needs-confirmation/configured without claiming recording consent, call permission or connected status. No test call or AppleSpike setup shortcut.

Worker section consumes `Pick<CalliePreloadApi['delegation'], 'status' | 'pair'>` for the minimum. Mount/refresh reads status only. Show endpoint, workspace and local configuration revision/state, alongside “Remote owner and mailbox/calendar grants are not established by this local read.” Pair submits the exact user-supplied `{endpoint, expectedWorkspaceId, code}`. Clear code after submission, do not store it in continuation/session storage/logs. Successful pairing does not configure, activate, sync, bootstrap, approve or grant anything. No raw JSON owner-configuration form. Explicit configuration/queued-command reconciliation are deferred, rather than mislabeled as ordinary refresh. If subsequently added, Sync must say it may resubmit queued commands.

```ts
export type MeetingFirstAccountCallSettings = Readonly<{
  newCallSlots: number | null; totalCallCapacity: number | null;
  revision: number; updatedAt: string;
}>;
export type UpdateCallSettingsRequest = {
  expectedRevision: number;
  newCallSlots: number | null; totalCallCapacity: number | null;
};
// LocalWorkspaceApi additions:
getCallSettings(): Promise<MeetingFirstAccountCallSettings>;
updateCallSettings(input: UpdateCallSettingsRequest): Promise<MeetingFirstAccountCallSettings>;
```

Use one shared exported settings type, replacing the main repository's duplicate type declaration with an import if necessary. Strict safe nonnegative integer/null schemas, integer revision, main-owned timestamp. Domain facade calls the existing settings repository in its own matching synchronous `DomainUnitOfWork.immediate`. No daily snapshot revision substituted for settings CAS revision.

Null means “Not configured”, zero `newCallSlots` means “No new discretionary calls”, zero total capacity means no capacity, not unknown. Only explicit Save writes. Rejection keeps inputs. Stale write displays current values separately and requires review before a new Save. Lost response triggers readback and displays uncertainty, not an automatically incremented CAS retry or an assertion that matching values prove this command succeeded. After confirmed Save, invalidate the local Daily read through the handed-off refresh owner. Due obligations remain even if above capacity, with a workload conflict.

## 7. F10: truthful starts, not seeded success

- Campaigns: “Saved campaign versions / capability preview.” Preserve exact frozen cohort, caps, enrollment history and version-bound LinkedIn samples. Remove inert Approve button. Keep exact missing audience-definition/hash-mapping explanation. No campaign create/edit/enroll, owner activation or fabricated audience text.
- Replies: classify as “Saved reply history”, outside actionable approval count/title. Retain thread/draft and stale-context explanation. No raw `approve-reply` shortcut.
- Local email: reachable first unsent draft via the actual contact workspace, distinct from worker follow-up.
- Requested worker email: explain the real saved eligible owner call, exact OriginalCallRef, recipient request and authenticated mailbox proof prerequisites. Existing get/edit/approve continuation stays intact. Manual preparation avoids generation, not network/owner proof.
- LinkedIn: explain approved campaign/current enrollment step, exact route and provider prerequisites. Existing saved draft continuation stays intact. Open/copy is not send.

Actual worker first-draft starts are a separate coordinator-gated extension, not executable tasks hidden in this minimum. Requested preparation needs a main-owned candidate read derived from saved command/handoff/applied-outcome/campaign evidence and fresh proof at preparation. Never type an OriginalCallRef from UI fields. LinkedIn can use existing enrollment/current step and `linkedin.prepare({enrollmentId, stepId, expectedVersion: enrollment.version})`, not campaign version or draft revision. Real campaign authoring and reply editing require exact audience/permission-bound public contracts before UI execution. A seeded draft proves continuation only.

## 8. Ownership and collision gates

| Gate | Owner and files | Required handoff |
| --- | --- | --- |
| H-M | Current shared-presentation/modal owner: `PresentationRoot`, overlay helpers, `ImportDialog`, `LeadInspectorProvider`, `InspectorOverview` consumers, `NativeDeskRoute`/`TodayRoute` and tests | Accepted exact files/hashes and topmost Escape/focus/pending-close contract. First-use adds inline sections, no independent modal layer or root/CSS refactor. |
| H-L | Upcoming list-reliability owner: `founderSalesDomain.ts`, Leads cursor/list semantics, `FounderApp.tsx`, `routeRegistry.tsx`, strict shared fixtures | Wait for F05/F06/F07 handoff. Selector consumes unchanged request shape, returned cursor and stale-cursor behavior. Do not implement competing paging or modify bulk selection. |
| H-C | Continuity owner for F11/F14/F16: account intake state, selected account, unknown-command lifetime, `NativeDeskRoute.tsx`, `FounderApp.tsx` | Coordinator names exact owner/module/API and accepted hashes before UI tasks. Extend that owner, not another route-local session. Separate reply-history partition from the owner's count/availability repair. |
| H-A | Coordinator: `tests/fixtures/applicationPresentationBrowser.tsx`, `nativeDeskBrowser.tsx`, `nativeDeskCompositionBrowser.tsx`, `package.json`, release metadata | Strict API additions affect fixture consumers. Coordinator integrates typed fixture changes and acceptance wiring. No optional no-op defaults or edits to frozen baselines to force GREEN. |

No ownership lease is granted by listing a path here. Current program and list plan were read. List plan's H1/H2/H3 and strict-fixture escrow remain binding. Preserve current native Import listener and unsupported Inbox action removal. No independent continuity plan was located in the inspected current plan list, so H-C is a real unresolved handoff, not assumed delivered code.

## 9. Planned public acceptance and claim boundaries

Every row is **planned, unexecuted**. Public means actual `FounderApp/renderRoute`, production preload/validated IPC, main/domain and encrypted fictional database where feasible. Component mocks establish only their narrower UI behavior.

| ID | Observable requirement | Planned acceptance | Limit |
| --- | --- | --- | --- |
| A1 | Exact selected research | Create two fictional companies, queue older unrelated job, select second in Accounts and research. Only selected job fetches/settles, status/refresh/reopen never fetch. | Deterministic HTTP/DNS adapters are synthetic source acquisition, not real-site permission. |
| A2 | Inspectable admitted evidence | Real bounded parser issues fetched receipt, repository admits, UI shows URL/hash/time/excerpt/unknowns. Private address, denied source, emergency route and stale CAS remain refused/parked. | Does not verify truth/completeness of website or identity. |
| A3 | Real person/route and reviewed link | Start with no person/draft. Global import admits explicitly named fictional person plus separate person-specific email. Return to same account, page/select exact ID, review quote, admit one link, open real contact workspace and select actual saved email method. | Import direct/valid defaults do not prove personal ownership. Company-only source negative case creates no inferred person/route. |
| A4 | First useful unsent draft | With model/Gmail unconfigured, Email creates draft, manual Save survives close/route/import refresh/reopen with same recipient/text. Linked account has explicit Send hold, unrelated unassociated contact flow remains intact. | No provider, owner/grant, send/call activity or conversation success. |
| A5 | Stable pending intent | Interrupt response after research/link commit, navigate/import refresh, retain original command. Research Check status only reads; explicit Resume replays the frozen request through selected claiming after queued capability restoration or unknown/not_recorded recovery. Genuine in-flight and parked ambiguous work cannot start parallel/retried acquisition. Link uses exact replay. Wrong workspace/account/UUID payload conflict cannot retarget. | UI/in-process transport interruption must be labeled as such, not OS-crash proof. |
| A6 | Real setup destinations | Navigate real hold links to phone/worker/capacity, verify controls and exact read-only mount. Fake phone candidate stale confirm fails. Pair response causes no follow-on mutating call. | Native candidate/signature and real pairing/grants remain external gates. |
| A7 | Capacity CAS | Real public read null, save zero then positive, stale concurrent save refuses and retains edits. Due obligations above total remain with conflict. | Capacity grants no call permission. |
| A8 | F10 honesty | Empty campaigns/requested/LinkedIn do not imply usable builder/approval. Saved reply appears as history, saved drafts remain continuable, local first draft is reachable. | Campaign authoring, reply editing and worker first-use preparation are not delivered. |

For each negative case assert relevant authority, consent, contact, history and receipt tables unchanged except the explicit intended receipt/research state. Unknown external spend must remain retained. Parent separately owns exact-head signed-app route matrix, native-modal behavior and release integration. Do not replace Accounts or Settings with Today in a test fixture and claim acceptance.

## 10. Decisions requiring coordinator disposition

1. **F08 strength:** accept source-reviewed relationship plus real importer-admitted contact-method preparation as this minimum, or require independently verified ownership/person-bound PM route admission. Recommendation: ship the honest minimum as a bounded checkpoint, keep stronger verification open. Never label it independently verified.
2. **F10 scope:** approve the audit's read-only preview/history alternative for small campaign/reply/worker first-use gaps, or commission the separately gated authoring/candidate/editor extension. This document does not authorize that extension.
3. **Authority-read shape:** approve the draft/revision-bound read in section 5, which corrects the scratch design's unavailable public contact-snapshot comparison. No authority writer or weakening is proposed.
4. **Continuity/file ownership:** coordinator names the H-C owner/API and releases H-M/H-L/H-A exact files before implementation. If continuity lands a different module, amend the plan's adapter task before edits rather than creating a competing store.
5. **Execution capability:** real research configuration, phone candidate and worker endpoint/grants remain unavailable/unproven in this planning session. Local fictional acceptance can use labeled deterministic external adapters only, never production allow-all policies or fabricated grants.

## 11. Validation performed

Read the supplied detailed design, binding program, list-reliability and shared-presentation plans, exact audit findings and current production contracts/composition/repository/UI paths. Cross-checked queue command versus receipt identities, transaction scopes, import defaults, local-send association fence, first-open generation and existing native Import listener. Recorded selected file hashes. Documentation review is the only feedback loop exercised. No npm/npx, tests, browser/native operation, build/package/app/profile/key/provider operation, production edit, commit or subagent was performed. Documentation completion cannot close implementation acceptance.
