// One required-gate unit per invocation (the workflow runs each on its own machine):
//   plan <selection.json>   validate select.mjs output; publish the plan and the machine matrix
//   static                  typecheck and lint, once for the whole run
//   suite                   the selected suites of one machine; reads CI_PLAN (the plan) and CI_MACHINE
import { appendFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { machinesFor, parsePlan, suiteCommand } from './plan.mjs';

function run(args, label) {
  const start = performance.now();
  const result = spawnSync('npm', args, { stdio: 'inherit' });
  const seconds = ((performance.now() - start) / 1000).toFixed(2);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `- ${label}: ${seconds}s, exit ${result.status ?? 'unknown'}\n`);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function publish(values) {
  // Single-line JSON only: a value cannot start another output.
  const lines = Object.entries(values).map(([name, value]) => `${name}=${JSON.stringify(value)}\n`).join('');
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines);
  else process.stdout.write(lines);
}

const [command, argument, ...extra] = process.argv.slice(2);
if (extra.length > 0) throw new Error('Usage: run-selected.mjs plan <selection.json> | static | suite');
if (command === 'plan' && argument) {
  const plan = parsePlan(readFileSync(argument, 'utf8'));
  console.log('Required gate:', JSON.stringify(plan));
  publish({ plan, matrix: { include: machinesFor(plan).map(({ machine }) => ({ machine })) } });
} else if (command === 'static' && argument === undefined) {
  // Shared static analysis always runs; test execution is selected, never hidden by paths filters.
  run(['run', 'typecheck:greenfield'], 'typecheck');
  run(['run', 'lint'], 'lint');
} else if (command === 'suite' && argument === undefined) {
  const plan = parsePlan(process.env.CI_PLAN ?? '');
  const entry = machinesFor(plan).find(({ machine }) => machine === process.env.CI_MACHINE);
  if (!entry) throw new Error(`Machine ${JSON.stringify(process.env.CI_MACHINE ?? null)} is not in the required gate plan`);
  console.log('Required gate machine:', JSON.stringify(entry));
  for (const suite of entry.suites) run(suiteCommand(suite), suite);
} else throw new Error('Usage: run-selected.mjs plan <selection.json> | static | suite');
