/**
 * Every part the fixture must contain, held here rather than in `fixture.ts`.
 *
 * The parent process compares the names the loader reported with this list and fails on
 * any missing one, so an older or shorter loader in a base checkout cannot quietly
 * reduce what the upgrade test covers (GPT-6 review, P1-6). It lives in a module of its
 * own because `fixture.ts` imports the domain and the worker, and the parent must not
 * (P1-4): a list of strings is the only part of the loader the parent is entitled to.
 *
 * `fixture.ts` imports this list, re-exports it and asserts its own parts against it, so
 * the two cannot drift. The order is the order `loadFixture` runs them in.
 */
export const REQUIRED_FIXTURE_PARTS: readonly string[] = Object.freeze([
  'workspace',
  'salesperson',
  'configuration',
  'firms',
  'routes',
  'opportunities',
  'template',
  'sequence',
  'enrollments',
  'mailbox',
  'outbound',
  'legacy footer (pre-0015, no postal address)',
  'legacy footer (pre-0020, with postal address)',
  'prepared fence',
  // Owed reconciliation *now*: `beginReconciling` leaves `reconcile_last_attempt_at`
  // null, so the reconcile workflow must return this fence's id. Without it the
  // workflow enumerated an empty set and reported success (GPT-6 review, P1-3).
  'reconciling fence',
  'dial',
  'inbound mail',
  'classification',
  'legacy today card (today.1)',
  'today',
  'jobs',
  'funnel facts',
  'release record',
  'operations',
  'schedule shift',
  'administrative pause',
  // One handle suppression, so a workflow can read `effective_suppressions` and demand
  // this row back. A view has no rows of its own for the hashes to catch, so a
  // replacement returning nothing was invisible to every other step (GPT-6, P0-4).
  'handle suppression',
  'shared two-workspace fixtures',
]);
