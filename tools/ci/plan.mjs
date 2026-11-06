// The required gate's plan: what tools/ci/select.mjs chose, validated, and how it is spread over machines.
// Shared by run-selected.mjs (plan, one job's suites) and aggregate.mjs (the required check).
const allSuites = ['contracts', 'telemetry', 'domain', 'social-publisher', 'api', 'worker', 'web', 'ops'];
// One machine per entry, longest first. The three small packages share one machine because
// their combined run (seconds) is shorter than another machine's setup; each suite still runs once.
const machines = {
  domain: ['domain'],
  api: ['api'],
  ops: ['ops'],
  web: ['web'],
  worker: ['worker'],
  packages: ['contracts', 'telemetry', 'social-publisher'],
};

/** The validated plan, or a thrown refusal. Broad plans include all suites; ops is mandatory and no suite may repeat. */
export function parsePlan(text) {
  let plan;
  try { plan = JSON.parse(text); } catch { throw new Error('Invalid required gate selection: not JSON'); }
  const valid = plan !== null && typeof plan === 'object' && !Array.isArray(plan)
    && typeof plan.broad === 'boolean' && typeof plan.upgrade === 'boolean'
    && Array.isArray(plan.suites) && plan.suites.includes('ops')
    && plan.suites.every(suite => allSuites.includes(suite)) && new Set(plan.suites).size === plan.suites.length
    && (!plan.broad || plan.suites.length === allSuites.length);
  if (!valid) throw new Error('Invalid required gate selection');
  return { broad: plan.broad, suites: allSuites.filter(suite => plan.suites.includes(suite)), upgrade: plan.upgrade };
}

/** The machines the plan needs, in start order; each lists only its selected suites. */
export function machinesFor(plan) {
  return Object.entries(machines)
    .map(([machine, suites]) => ({ machine, suites: suites.filter(suite => plan.suites.includes(suite)) }))
    .filter(({ suites }) => suites.length > 0);
}

/** The npm arguments that run one suite. */
export function suiteCommand(suite) {
  if (suite === 'ops') return ['run', 'test:ops'];
  return ['run', 'test', '--workspace', `${['api', 'worker', 'web'].includes(suite) ? 'apps' : 'packages'}/${suite}`];
}
