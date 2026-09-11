/**
 * SOURCE-ONLY acceptance inventory. This file intentionally registers NO Playwright
 * tests, launches NO Electron app, and claims NO packaged/UI acceptance.
 *
 * D3 has not approved the actual account-entry presentation. The real preparation
 * API currently lives at startApplication().companyResearch.prepare(commandId,
 * signal). There is no approved account-entry renderer/IPC workflow to drive.
 * Do not replace that missing entry with page.evaluate, a fake test hook, or a
 * skipped/disabled scenario. Implement the real user path after D3 approval, then
 * replace this inventory with a genuine packaged-app test owned by the coordinator.
 */
export const accountPreparationAcceptanceGap = Object.freeze({
  status: 'blocked_on_D3_real_account_entry',
  executableUiTests: 0,
  assembledSourceEvidence: 'tests/integration/accountPreparationWorkflow.test.ts',
  historicalSourceEvidence: 'tests/integration/accountMigrationPreservation.test.ts',
  requiredUserPath: [
    'Approve residential/regional PM audience and bounded durable research budget through real UI',
    'Discover via configured adapter and fetch official company pages through fictional external HTTP',
    'Restart after durable receipt, then show source-backed account in actual Today queue',
    'Open actual account detail and inspect published route, unknowns, and separate policy readiness',
    'Verify missing clearance refuses action without creating a Person or sending/calling',
    'Verify legacy callbacks, drafts, unknown sends and opt-outs remain visible and unchanged',
    'Preserve theme, density, selection and unsaved edits through the approved entry/navigation',
  ],
  separateGates: ['D3 presentation approval', 'coordinator package/native acceptance',
    'authorized real public-company cohort quality/cost review', 'D5 real-workspace migration'],
} as const);
