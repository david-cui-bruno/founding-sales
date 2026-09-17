# FSS Guarded Local Company Intake Plan

> **For agentic workers:** use subagent-driven-development and test-driven-development. Implement this bounded public workflow on the existing account repository, not a replacement backend.

**Approval:** approved audit roadmap, David 2026-09-09T21:51:19Z. Source design: `~/.jcode/scratch/fss-approved-cleanup-20260909/company-slice-design.md`. Parent chooses its no-new-schema alternative.

**Goal:** From Accounts, explicitly review company name/optional domain, create one local account only when the current local catalog has no candidate, or open an existing candidate without mutation. Survive lost creation responses, repeat commands and restart. Preserve truthful unknowns and existing history/suppression. Exercise the actual packaged first-use path.

**Non-goals:** No automatic merging, global uniqueness claim, distributed identity index, new schema, new research/cohort expansion, automatic calls/messages/campaigns, worker activation, real profile access, installation, grants, uploads, purchases, deployment or push. Cross-cohort SQL/Dynamo identity reconciliation and evidence-backed shared-domain disambiguation remain explicitly deferred. This workflow does not make old research creators globally duplicate-proof.

## Architecture and frozen interfaces

- Add `src/shared/contracts/localCompanyIntakeContract.ts`, strict schemas/types. Reuse `accountSchema`/`accountCreateSchema`; no new account/source identity representation. Exports: `localCompanyInputSchema`, `localCompanyCreateRequestSchema` (same canonical create shape), `localCompanyReviewSchema`, `localCompanyCreateResultSchema`, `localCompanyCreateStatusSchema`, corresponding `LocalCompanyInput/LocalCompanyCreateRequest/LocalCompanyReview/LocalCompanyCreateResult/LocalCompanyCreateStatus` types, and pure `localCompanyCandidateSignals(input, account)`. `AccountCreate` below is notation for the inferred existing create shape, not an existing exported type.
- `CompanyInput = Pick<Account,'name'|'domain'>`. Existing canonical trim/lowercase-hostname rules apply. UI may normalize entered hostname before explicit confirmation, not infer registrable domain or make a network lookup.
- `CompanyCandidate = {account:Account,signals:('same_name'|'same_domain')[]}`. Unique IDs/signals, nonempty signals consistent with compared input. Name comparison uses trim plus ASCII-only case-fold; no punctuation/suffix/non-ASCII/fuzzy collapse. Full domain matches only if nonnull.
- `CompanyReview = {scope:'local_database',input:CompanyInput,candidates:CompanyCandidate[],complete:boolean}`. At most50 candidates, stable ID order, fetch51 to detect truncation. Malformed/unavailable reads fail, not empty success.
- Add required `LocalWorkspaceApi.reviewCompany(input):Promise<CompanyReview>`.
- Add `createCompany(input:AccountCreate):Promise<{status:'saved',commandId,account,replayed:boolean}|{status:'needs_review',commandId,review:CompanyReview}|{status:'command_conflict',commandId}>`.
- Add `getCompanyCreateStatus(input:AccountCreate):Promise<{status:'saved',commandId,account}|{status:'not_recorded',commandId}|{status:'command_conflict',commandId}>`.
- Channels exactly `local-workspace:review-company`, `local-workspace:create-company`, `local-workspace:company-create-status`. Fixed safe errors through existing IPC boundary. Do not expose arbitrary SQLite errors.
- Path: renderer → existing localWorkspace preload root → strict sender-validated IPC → provider `runtime.withDomain` → thin facade method → dedicated helper → AccountRepository. Do not bypass domain readiness with `withDatabase` for the new methods.

## Global constraints

- Existing checkout, no reset/worktree/amend/broad staging. Every node/npm/npx command begins `export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH";`.
- Parser owner must finish/commit before adding facade methods. Startup owner must freeze/commit before modifying NativeDeskRoute. Release owner must finish/commit before editing package.json/support inventory.
- Keep current migration files/catalog and command receipts unchanged. `selectedAccountSnapshot` requires exactly one mutation receipt per account version: reuse/open-existing records NOTHING in pm_account_commands and bumps no version.
- No invented persons, routes, role, source URL/hash/attestation, research result, PM fit, portfolio, buying authority, owner lease or suppression clearing. Name/domain are manually entered identity hints, not verified business facts.
- Workers freeze paths/hashes before review and commit only after coordinator authorization. Native/full/build/Swift/Electron acceptance serialized by coordinator. Small encrypted tests need explicit lease, no rebuild.

## Task 1: Strict local contract and atomic guarded repository path

**Own:** new shared contract; `src/shared/contracts/localWorkspaceContract.ts`; new `src/main/domain/accounts/localCompanyIntake.ts`; scoped `accountRepository.ts` operations; scoped thin `founderSalesDomain.ts` methods; `src/main/workspace/localWorkspaceProvider.ts`, `registerLocalWorkspaceIpc.ts`; `src/preload/apis/localWorkspaceApi.ts`; directly affected shared/main/preload tests and explicit test mocks only. No renderer/browser/E2E files.

- [ ] Add genuine REDs through real encrypted AccountRepository/helper for no-domain/domain creation, canonical input, original receipt replay, changed payload conflict, review candidates and zero writes on collision/query/readiness failure.
- [ ] Query ALL current local pm_accounts, including preexisting/synchronized rows. Candidate if same name OR same full nonnull domain. Include existing duplicates. Candidate checks are advisory review, not identity proof or reservation.
- [ ] Guarded create opens exactly one existing-style IMMEDIATE transaction. First validate the exact prior create receipt/fingerprint. Same command replays original creation Account; different payload/receipt kind returns typed command conflict. Do not catch arbitrary DB failure as a conflict.
- [ ] If no receipt, recompute candidate set inside that transaction. Any candidate or incomplete result returns needs_review with no mutation. No create-anyway flag. If clear, use one shared private creation primitive to allocate one ID and ordinary version1 create receipt.
- [ ] Preserve the existing public `AccountRepository.create` contract/fingerprint/wrapper. Do not nest public create inside another transaction. Extract private in-transaction operation only as needed; do not change other creators silently.
- [ ] Status is read-only complete-input/fingerprint lookup. It allocates no ID and returns original creation receipt, not a fabricated current snapshot. not_recorded is an observation, not proof an in-flight command can never finish.
- [ ] Use existing domain readiness facade/provider boundary for all new methods. Preserve existing read/transition methods. Validate strict responses/echoed command/input, sender origin and safe error behavior. Unknown/malformed results must not be treated as saved or no matches.
- [ ] Real encrypted tests prove two separate local commands racing for a match yield one creation + one review hold; ordinary command retry is exact; selecting/reviewing adds no history/claims/jobs and leaves suppression unchanged. Verify created and reused accounts still pass exportSelectedAccountRecord with real normal history.
- [ ] Update typed mocks only for required interface completeness. Do not widen an interface to optional just to avoid fixtures. Run focused tests/type/lint, freeze source, independent review, own-path commit.

## Task 2: Accounts entry and recoverable explicit local form

**Own after Task1/styling freezes:** new `src/renderer/features/today/LocalCompanyIntake.tsx` and focused tests; scoped `NativeDeskRoute.tsx`, `LocalAccountLibrary.tsx` wiring and existing-token styles; directly affected fixture API implementations. No edits to existing outbound/session APIs.

- [ ] Add visible Accounts entry “Add company”, name and optional domain fields, and distinct “Review company” and “Create company” actions. Review is explicit and separate from Create. Explain local/manual status once, retain useful candidate context.
- [ ] Review results must match the current canonical input. Changing identity invalidates reviewed candidates. Candidate rows show real name/domain/signals. “Open existing company” selects the actual ID and uses existing local read, with no mutation, merge, new receipt, account version or automatic research.
- [ ] Explicit Create generates one UUID and freezes its complete canonical input. Disable duplicate submits/identity edits while outcome unresolved. Recheck catalog on main inside the atomic guard, never rely on UI review as permission.
- [ ] Unknown response or transport loss shows save outcome unknown and retains the same command/input. Check status/retry use that identity, not new UUID. not_recorded does not auto-retry or unlock a conflicting new command; explicit retry remains exact. Typed conflict gives actionable hold, not success.
- [ ] needs_review is non-mutating and opens current candidates. A later review can reflect changed catalog. Only a new explicit edited submission after resolution creates a new command.
- [ ] On saved response, refresh existing local snapshot and open saved ID. A later read failure must not relabel the already-saved result as failed or issue another create. Reopen current evidence by stable stored identity.
- [ ] Route/API/unmount/late response safeguards prevent applying a result to a changed form/workspace. Preserve unrelated draft/editor DOM/caret and local/worker holds. No automatic transition/pairing/outreach. Unsent form text persistence is not promised.
- [ ] Genuine legacy behavior and local availability during worker failure remain unchanged. Scope entry to supported local Accounts view, not a synthetic person quick-add.
- [ ] Focused no-native React tests cover first use, input changes, candidates, lost response/status/retry, late response, duplicate submit, create/read partial failure and action inventory. Freeze/review/commit only owned paths.

## Task 3: Actual first-use acceptance and maintained documentation

**Parent owns:** make `tests/e2e/accountPreparation.spec.ts` a real packaged local-intake case while retaining the original automated-research inventory as an explicitly unmet, separate acceptance contract. Include the file in package.json test:e2e after release owner commit. Add actual public provider/renderer integration as needed, not fixture-only saved-account injection. Update current acceptance docs with UI→IPC→store→first-use evidence and deferred gates.

- [ ] Launch fresh separately built signed candidate with isolated temp profile and existing safe packaged harness. Use real Accounts UI intake, no database seeding to create the tested company. Read/name/domain/unknowns → close/reopen → app restart → same stored account ID.
- [ ] No duplicate company on fresh same-name/domain command; explicit Open existing reuses it, leaves history/version/claims/routes/jobs/authority unchanged. Include same-domain different-name ambiguity, existing duplicate fixture and no bypass.
- [ ] Exercise no-domain and hostname cases, malformed input, user edits before review/create, exact replay and status after simulated lost transport through real service integration. Packaged test need not add a debug injection surface to force a lost IPC.
- [ ] Assert new manual entry has no fabricated facts/person/routes/source evidence and no worker/grants/outreach side effects. Preserve actual selected account export compatibility on disposable data.
- [ ] Run whole source and exact single-artifact release runner including new browser and packaged cases. Record exact SHA, candidate identity, preserved canonical/installed app hashes, findings/fixes and final evidence.
- [ ] Document remaining global/distributed identity problem and research/execution gates explicitly. Do not call that problem fixed merely because local intake is safe.

## Completion

Done means a locally tested, committed and packaged public intake/read/reopen workflow, with reviewed conservative collision handling. It does not mean production installation, automatic research, global company deduplication or live worker readiness.
