# FSS cleanup and first-company acceptance map

Date: 2026-09-09. Approval: David's bounded audit followthrough at 21:51:19 UTC.

This records source implementation and maintained checks. **It is not an installation, live activation, or a claim that every registered release test has passed.** The final single-artifact release run must identify its clean source commit and candidate identity separately.

## What changed, and why

| Audit concern | Implemented response | Maintained evidence |
| --- | --- | --- |
| Verification could inspect one bundle and launch another | One resolved candidate path, clean-HEAD marker, executable/ASAR identity binding before each packaged launch. Conflicting release overrides fail before work. | `scripts/verifyRelease.mjs`, `scripts/releaseArtifact.mjs`, `test/releaseArtifact.test.mjs`, `test/verifyRelease.test.mjs`, `tests/main/packagedTestEnvironment.test.ts` |
| Missing release lanes and stale current docs | The serial release runner owns browser, Swift, Node helper, real synthetic backup-host and dynamically discovered Lambda lanes. Current backup documentation and assertions use schema24. | `package.json`, `README.md`, `cloud/README.md`, `test/releaseDocumentation.test.mjs`, `test/preReleaseElectronHost.test.mjs` |
| Actual CSV import bypassed the tested parser | One indexed parser is used by preview/remap/commit. Blocking parse errors survive remapping. Source record numbers, dialects, quoting, BOM and leading blank records are retained. Duplicate/prototype-like headers cannot silently corrupt mappings. | `src/main/imports/csvParser.ts`, `tests/main/csvParser.test.ts`, `tests/integration/importService.test.ts` |
| Retired UI and unsafe obsolete capture tools | Removed five retired render-only islands, unused triage props, exclusive CSS and two uncalled capture scripts. Assertions were retained on active consumers. | [Retired-view record](2026-09-09-retired-views.md), active Today/discovery/contact-preparation component tests |
| Loading appearance depended on asynchronous workflow data | App owns existing theme/density preferences before its health branch. A presentation marker is independent of workflow authority. Pending/error/unknown surfaces retain A without inventing readiness. | `src/renderer/App.tsx`, `src/renderer/features/today/NativeDeskRoute.tsx`, `tests/browser/startupPresentation.spec.ts` |
| No public local company entry | Accounts now explicitly reviews name/optional full domain, creates only when the current local catalog is clear, or opens an existing candidate without mutation. | The complete path and tests below |

No storage migration, source-history rewrite, suppression removal, new dependency, automatic research, or broad rollback was required. Historical recovery/migration tools, the three useful disconnected account/campaign/reply adapters, ManualQuickAdd, and platform scaffolding were not declared dead merely because they are not on the current first-use path.

## Local company workflow: entry to persistence

| Layer | Concrete path | Responsibility |
| --- | --- | --- |
| UI entry | Accounts → **Add company** → name and optional hostname → **Review company** | Manual local identity hints only. Invalid input is rejected before an API call. Editing invalidates the previous review. |
| Explicit decision | **Create company** or candidate **Open existing company** | Review is not creation. Existing candidates cannot be bypassed with a create-anyway action. |
| Renderer | `src/renderer/features/today/LocalCompanyIntake.tsx` and existing `NativeDeskRoute` / `LocalAccountLibrary` | One frozen command and input for unresolved creation. Explicit status/retry preserve that exact identity. Late results are fenced from changed API/scope/form lifetimes. |
| Contract | `src/shared/contracts/localCompanyIntakeContract.ts` | Strict request/response bindings, unique consistent candidates, at most50 results, explicit incompleteness, SQLite-compatible UTF8 ID order. |
| Preload / IPC | `src/preload/apis/localWorkspaceApi.ts` → `src/main/workspace/registerLocalWorkspaceIpc.ts` | Named review/create/status methods, trusted sender, exact arity and correlated response. No arbitrary database errors reach UI. |
| Domain | `src/main/workspace/localWorkspaceProvider.ts` → thin `FounderSalesDomain` methods → `src/main/domain/accounts/localCompanyIntake.ts` | Existing `withDomain` readiness boundary, not a database-only bypass. |
| Store | `src/main/domain/accounts/accountRepository.ts` | Recheck the entire local catalog within the existing IMMEDIATE transaction. Same trimmed ASCII-case-folded name OR same nonnull full domain holds creation. Existing normal create replay/fingerprint/history remains compatible. |
| Reopen | Existing local snapshot reader and actual stored account ID | Saving and subsequent evidence refresh are separate outcomes. A failed refresh does not turn a recorded save into a failed create. |

Opening an existing candidate adds **no** mutation receipt or account version. `pm_account_commands` retains one ordinary mutation receipt per version, including compatibility with selected account export. A manual account begins with empty claims, routes and portfolio. The workflow does not fabricate a person, role, direct email/phone, source attestation, PM fit, buying authority or research result.

### Recovery limits

- A lost or malformed creation response is **unknown**, not failure. While that controller remains mounted, the request stays frozen and status/retry use the same UUID and canonical input.
- `not_recorded` is a point-in-time observation. It neither automatically retries nor permits a conflicting new command.
- A saved response records the original version1 receipt. Later account mutations do not change that command's historical result.
- True route-unmount persistence of an unsent form or unresolved controller is not promised. Late responses cannot update a different controller. Saved accounts persist and reopen after app process restart.
- Candidate matching is a conservative local guard, not identity proof. It does not merge shared-domain organizations, reserve distributed names or repair historical duplicates automatically.

## Requirement-to-check map

| Acceptance requirement | Concrete check |
| --- | --- |
| Actual encrypted create, repeat command, changed-payload conflict, status and normal history/export compatibility | `tests/main/localCompanyIntake.test.ts` with real repository/domain fixtures |
| Current candidate recheck, malformed/unavailable reads, duplicate candidates and no writes on hold | Same maintained encrypted suite, including preexisting rows and separate connection scheduling |
| SQLite order, non-ASCII historical IDs and 51-row truncation boundary | `tests/shared/localCompanyIntakeContract.test.ts` and encrypted repository regressions |
| Failure after account INSERT rolls back both account and receipt; exact retry succeeds | Temporary fault-trigger tests in `tests/main/localCompanyIntake.test.ts`, for guarded and ordinary create |
| Trusted sender, wrong response/command/input, unavailable domain and safe IPC error behavior | `tests/main/localCompanyIntakeIpc.test.ts`, `tests/main/localWorkspaceIpc.test.ts` |
| No automatic actions, synchronous duplicate-submit fence, changed input/API/scope, unknown/status/retry, saved-but-read-failed and late responses | `src/renderer/features/today/LocalCompanyIntake.test.tsx` and existing NativeDesk lifecycle tests |
| Actual component form geometry, invalid-input alerts with zero API dispatch, explicit create/reuse, both themes and 1050/1440 widths | Final company case in `tests/browser/nativeDesk.spec.ts`. Its synthetic adapter is deliberately not persistence evidence. |
| Fresh signed-app default-legacy UI → preload → IPC → encrypted store, unchanged mode/receipt, then optional disposable transition, reopen and app process restart with stable ID | Registered case in `tests/e2e/accountPreparation.spec.ts`, owned by `test:e2e` and `verify:release` |
| No-domain creation, same-domain/different-name hold, explicit reuse, no fabricated facts/routes, unpaired worker state and retained commitments | The same packaged test uses only supported UI writes and public read APIs in a disposable profile. It does not seed the company with SQL or a debug hook. |
| Health pending/error, daily pending/error/unknown, actual legacy and ready A, preference fallback and preserved viewport bounds | Actual-App `tests/browser/startupPresentation.spec.ts`, plus existing composition/session/browser regressions |

The previously zero-test `accountPreparation.spec.ts` now registers local-intake acceptance, **and retains all seven original automated-research user-path requirements as an explicitly unmet separate contract**. A manual company test must not be presented as automatic sourcing or live research acceptance.

## Validation observed before the final release run

- CSV parser: 43 focused cases, including actual encrypted import/remap/commit regressions, accepted source review.
- Retired-view change: active component checks and exact surviving CSS declarations reviewed. No intentional visible production change.
- Release binding: default/candidate fixture checks, all four launch kinds, and real two-candidate ASAR mismatch rejection before fake spawn. This does not substitute for the full real release command.
- Startup: 216 focused component tests and all47 then-current browser cases passed after the real pending-height regression was corrected. The pending-only border-box repair did not change ready geometry.
- Company backend: 50 focused cases passed after the Unicode comparator regression. Reviewer independently ran the original46 cases and source-reviewed the four added cases and final frozen hashes.
- Company renderer: 104 focused component cases independently rerun and accepted. Parent's complete48-case browser suite passed, including the new invalid/review/create/reuse case and four company theme/width checks.

Counts above identify bounded evidence, not a substitute for first-use or exact packaged acceptance. The standard serial gate below must still pass on the final clean commit. If it fails, retain the failure and repair it before claiming release readiness.

## Exact release procedure

Use Node24 and the existing stable Apple Development identity. Set `CALLIE_RELEASE_OUT_DIR` to a **fresh scratch candidate** for the clean commit. Unset an inherited `CALLIE_E2E_OUT_DIR` or set it to that same resolved directory. Run `npm run verify:release` without parallel native/build jobs.

The runner performs types, tracked-file lint, root tests, NativeDesk/startup browser tests, Swift, Node helper tests, the real synthetic two-process backup host, all discovered Lambdas, one normal package build, signature/fuse/package checks, source/history/extracted-package scans, and packaged workflows. Embedded release marker and executable/ASAR identity must agree throughout, with the same clean HEAD at the end.

Preserve the installed application and canonical old output. Final evidence must state the commit, candidate ASAR/marker identity, full stage results, intentional skips and protected installed/canonical/native hashes. Do not install the candidate as a side effect of verification.

## Deliberately unfinished next work

1. **Global company identity and automated research:** old SQL/Dynamo research creators are not globally duplicate-proof. Bootstrap/history/shared-domain ambiguity require a separate durable reconciliation design before expanding research cohorts. The local guard does not solve this.
2. **Real first-company research and contact/route admission:** use existing evidence/research services and verified public source bindings. Office phone or generic inbox must not silently become a person's direct route.
3. **Worker owner setup and execution entry points:** public setup UX, company-only call confirmation, first requested/LinkedIn preparation, reviewable campaign material and ordinary replies remain separate vertical slices. Existing disabled/held states remain honest.
4. **Startup timing:** the A loading flash is repaired in source. No reduction of the observed roughly7-second installed warm startup is claimed. Stage timings are still needed before removing any remaining integrity work.
5. **Deferred cleanup choices:** ManualQuickAdd product disposition, unsupported platform makers, target-version disposable recovery coverage and the documented pre-release schema24 exposure question remain explicit decisions, not quiet deletions.

No live profile/key access, normal restart of the installed app, repeat workflow transition, new grant, provider call, message, purchase, deployment, push or installation is part of this change.
