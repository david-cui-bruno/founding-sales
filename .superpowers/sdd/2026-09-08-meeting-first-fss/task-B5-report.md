# B5 acceptance report

Status: DONE_WITH_CONCERNS for source acceptance. Owned tests only. No production/helper/admission edits. Actual UI, live cohort and real-workspace gates remain pending.

## Scope and exact source contracts

- `tests/integration/accountMigrationPreservation.test.ts`: genuine encrypted schema19 created by `createMigrationRunner(productionMigrations.filter(schemaVersion <= 19))`. Independent historical19 catalog SHA `a6108cfce2bc4242d0872e81cc2afc88634f6309c55605bd3fc995804fde9073`, using the canonical normalization read from `tests/support/packagedFixtureDatabase.ts`. Not relabeled current schema.
- `tests/integration/accountPreparationWorkflow.test.ts`: actual `createCompanyPreparation(...).prepare`, `createCompanyDiscoveryProvider` + `requestCompanyDiscovery`, `createCompanyPageProvider`, `SqlDiscoveryReservationStore`, `AccountRepository`, `createCompanyResearchWorker`, `createDomainServices().today`, persisted workspace call settings, real SQL B4 policy and `createAccountOutboundService`/`createInboundReadiness`.
- `tests/e2e/accountPreparation.spec.ts`: source-only acceptance inventory, zero executable tests. No skipped test or fake UI hook.
- This report is the fourth owned path. All existing migration/helper/admission files remain camel-owned.

## Preservation assertions

Named stable projections compare exact values across actual registered migrations 20, 21, 22 and physical encrypted database reopen. They cover persons, organization identity/aliases, prospects, original source events and intake receipts, contact evidence, cycle/action identity and callback due fields, original activities, all original built-in v1 cadence definitions/steps/components, drafts, unknown send intents/results, opt-out tombstones/handles/closure receipts/membership, historical backup/restore receipts and identity repair events. The old catalog's exact SQL is compared separately from rows. New PM account/source/route and delegated authority/mail/draft tables remain empty, new call settings remain unset, migrations do not enroll or send. FK and integrity checks run before/after migration, with a no-op repeat migration after reopen.

Fixture iteration initially encountered genuine retained opt-out/lifecycle/receipt constraints. Corrected only the owned fictional fixture: separate opted-out identity without open work, tombstone-before-projection ordering, and exact closure handle snapshot. These setup failures are not claimed as production regression RED.

## Assembled RED and owner handoff

All commands use `export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH";`.

- 01:11 UTC: `npx vitest run tests/integration/accountPreparationWorkflow.test.ts`: 1 failed. Real HTTP discovery, approved SQL budget, page receipt, crash at settlement, close/reopen, receipt recovery and no-repeat HTTP reached assertion. Expected published business phone from actual fetched page, got `[]`.
- Source inspection confirmed B2 page provider unconditionally returned `routes: []` and did not extract `operating_footprint`, which B3 supported fit requires. Reported narrowly to root and monkey. Root assigned the production repair to monkey. B5 did not patch production or fabricate route/footprint success.
- Exact fictional page: `<p>We manage 240 residential units.</p><p>We are a regional property management company.</p><p>Business switchboard: +14015550100</p>`.
- The trusted phone-validation/DNC/jurisdiction policy source is separate from this fetched source and admits no route. `expectedWorkspaceId` is explicit for the positive path. Missing/foreign workspace identities refuse. No Person is created for the researched account.

## Source-age and ranking limits

The actual `AccountEvidenceSnapshot` has no source timestamps or source array, although SQL retains `fetched_at`. Tests explicitly observe that representation, preserve technology/role/pain unknowns, and compare the same real snapshot through the local shared rank function and delegated-worker public `rankAccount` export. The same snapshot ranks identically at a later date. This does not verify a stale-source freshness policy and does not invent a cutoff. Export parity is not a deployed Dynamo/worker integration claim.

## Exact UI and real acceptance gaps

The real preparation API is exposed by the startup composition, not an approved account-entry renderer/IPC workflow. D3 presentation review is still required. The source-only E2E inventory does not launch Electron or assert UI acceptance. Still unproved: actual audience/budget UI entry, account Today/detail navigation, source/unknown/policy presentation, legacy data visibility, and theme/density/selection/unsaved-edit behavior through that new entry.

Pending separate gates: coordinator root/package/native checks, D3 real UI approval and packaged workflow, bounded authorized real public-company cohort review of source quality/routes/errors/cost/credits/edit burden, and D5 authorized real-workspace migration. No live network/provider/model request, credentials, profile, OS app, native build, package, cohort, actual call/send/invitation, provisioning or purchase was used.

## Final verification (01:15 UTC)

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx vitest run tests/integration/accountMigrationPreservation.test.ts tests/integration/companyResearchRestart.test.ts tests/integration/migrationBackup.test.ts tests/integration/restoreDrill.test.ts tests/integration/accountPreparationWorkflow.test.ts
```

Result: **5 files, 56 tests passed**, exit 0. This includes the brief's four-file preservation/restart/backup/restore suite plus the approved assembled integration. Historical restore fixtures 17–22 pass and actual unregistered23 is rejected by existing camel-owned tests.

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx eslint tests/integration/accountMigrationPreservation.test.ts tests/integration/accountPreparationWorkflow.test.ts tests/e2e/accountPreparation.spec.ts
```

Result: exit 0. No E2E execution or package build was performed.

`npx tsc --noEmit` was attempted with the same Node24 export. It remains blocked by foreign diagnostics only:
- `tests/main/calendarProvider.test.ts(9,163)`: TS7018, `etag` implicit any.
- `tests/main/delegationRepository.test.ts(385,46/66/135)`: TS7018, `rfcMessageId`, `references`, `cc` implicit any.
- `tests/main/meetingProjection.test.ts(52,37)`: TS2367, `meeting.outcome` not in the current union.
- `tests/main/meetingProjection.test.ts(53,54/84)`: TS2698 and TS2339, spread/payload on `never`.
All were reported to root. No owned diagnostics or foreign edits.

### RED → GREEN accounting

The genuine assembled regression RED preceded monkey's production extraction repair. After that repair, B5 advanced through actual footprint/rank/Today to a fixture FK mismatch: policy receipt `evidenceIds` must reference existing exact route-version evidence. Corrected the fixture, not production, after B4 owner confirmed `evidenceRef` may separately identify the trusted clearance source. The final test preserves actual fetched route ID/version/target unchanged. Positive policy, missing/foreign workspace refusal, published-only refusal, real readiness and synthetic external handoff all pass. Synthetic handoff alone leaves Today work outstanding, and only the explicit fictional actual-outcome report consumes it. No call was actually made.

Preservation is coverage of existing behavior, not a claimed missing-production-feature TDD cycle. Initial fixture errors are listed above rather than misrepresented as regression RED. Full exact rows/catalog comparisons passed after fixture correction. No production implementation was written by B5.

Commits and exact path inspection are recorded below after scoped commit.
