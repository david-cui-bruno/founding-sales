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
  'shared two-workspace fixtures',
]);
