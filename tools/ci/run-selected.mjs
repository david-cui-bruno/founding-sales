import { readFileSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const selection = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const allowed = new Set(['contracts', 'domain', 'api', 'worker', 'desktop', 'ops', 'ask-evaluation']);
if (!Array.isArray(selection.suites) || !selection.suites.includes('ops') || selection.suites.some(suite => !allowed.has(suite))) throw new Error('Invalid required gate selection');
function run(args, label) {
  const start = performance.now();
  const result = spawnSync('npm', args, { stdio: 'inherit' });
  const seconds = ((performance.now() - start) / 1000).toFixed(2);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `- ${label}: ${seconds}s, exit ${result.status ?? 'unknown'}\n`);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log('Required gate:', JSON.stringify(selection));
// Shared static analysis always runs; test execution is selected, never hidden by paths filters.
run(['run', 'typecheck:greenfield'], 'typecheck');
run(['run', 'lint'], 'lint');
for (const suite of selection.suites) {
  const args = suite === 'ops' || suite === 'ask-evaluation'
    ? ['run', `test:${suite}`]
    : ['run', 'test', '--workspace', `${['api', 'worker', 'desktop'].includes(suite) ? 'apps' : 'packages'}/${suite}`];
  run(args, suite);
}
