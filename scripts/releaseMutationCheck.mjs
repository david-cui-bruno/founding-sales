#!/usr/bin/env node
// Prove the release suite's vacuous-pass traps are actually closed.
//
//   npm run test:release:mutation
//
// G12's brief: "every test names and closes its vacuous-pass trap, and a mutation check
// (a script that removes the setup and expects the test to fail) proves at least the
// traps you added."
//
// A test that cannot fail is worse than no test, because it is counted. The way to find
// out is to break the thing it claims to be testing and watch. This script does that,
// one mutation at a time, always restoring the file afterwards — including when a run is
// interrupted, which is why the restore is in a `finally` and the originals are held in
// memory rather than in a sibling file somebody could leave behind.
//
// Each mutation names:
//
//   * `file`        — what is edited;
//   * `find`/`replace` — the exact edit, which must match exactly once;
//   * `suite`       — the vitest invocation that must then FAIL;
//   * `because`     — the trap this proves is closed, in one sentence.
//
// A mutation whose `find` does not appear, or appears more than once, is itself a
// failure: it means the code moved and the mutation is no longer testing what it says.
// A mutation that leaves the suite GREEN is the finding this script exists for.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** @type {{name: string, file: string, find: string, replace: string, suite: string[], because: string}[]} */
const MUTATIONS = [
  {
    name: 'the outbound world stops attesting to a release gate',
    file: 'packages/domain/test/outbound/support/outboundWorld.ts',
    find: "VALUES ($1, 'sending_enabled', 1, $2::jsonb, 'fixture: the rehearsal gate this world stands for', $3)",
    replace: "VALUES ($1, 'business_time_zone', 1, '{\"timeZone\":\"UTC\"}'::jsonb, 'fixture: not the attestation', $3)",
    suite: ['--workspace', 'packages/domain', '--', 'test/outbound/'],
    because:
      'The fixture seeds 16.2 admin attestation so that cap, window and suppression scenarios refuse for their own reasons. Without it every send must hold, so a suite that still passed would not be reading the attestation at all.',
  },
  {
    name: 'the send gate stops requiring the deployment flag',
    file: 'packages/domain/outbound/gate.ts',
    find: 'if (!effectiveSendingEnabled(deps.deploymentSendingEnabled ?? false, attestation.value)) {',
    replace: 'if (false) {',
    suite: ['--workspace', 'packages/domain', '--', 'test/outbound/attestation.test.ts'],
    because:
      'Appendix G 42 is four conditions ANDed, and the attestation test is the only place the dispatch path is asked about two of them. Removing the check must fail it.',
  },
  {
    name: 'the production bootstrap accepts an absent dependency switch',
    file: 'apps/worker/src/bootstrap/deployment.ts',
    find: "if (environmentName === 'production') {\n      throw new DeploymentConfigError(\n        'DEPENDENCIES_UNSET',",
    replace: "if (false) {\n      throw new DeploymentConfigError(\n        'DEPENDENCIES_UNSET',",
    suite: ['--workspace', 'apps/worker', '--', 'test/deployment.test.ts'],
    because:
      'The coordinator note asks for a release-gate test that the production path never reaches a no-op by accident. If a production deployment can start with no switch set, that test must go red.',
  },
  {
    name: 'the production API accepts a journal that keeps nothing',
    file: 'apps/api/src/bootstrap/deployment.ts',
    find: "const suppressionJournal = dependencies === 'live' ? requireDurableJournal(resolved) : resolved.journal;",
    replace: 'const suppressionJournal = resolved.journal;',
    suite: ['--workspace', 'apps/api', '--', 'test/deployment.test.ts'],
    because:
      '10.2 makes the journal write a precondition of acknowledging a suppression. A live API that silently used the local no-op would accept opt-outs with nothing to replay after a restore.',
  },
  {
    name: 'the scenario map loses a scenario',
    file: 'test/release/support/scenarioMap.ts',
    find: '  {\n    number: 42,',
    replace: '  /* removed by the mutation check */ {\n    number: 43,',
    suite: ['run', 'test:release'],
    because:
      'The map is the index from Appendix G to its proof. A scenario that fell off it silently would be a scenario nobody runs, so the map must assert its own completeness against the literal range 1 to 42.',
  },
  {
    name: 'a rehearsal-only scenario loses its script',
    file: 'test/release/support/scenarioMap.ts',
    find: "    script: 'infra/scripts/rehearsal-restore-drill.sh',",
    replace: '',
    suite: ['run', 'test:release'],
    because:
      'A rehearsal-only scenario with no script is a scenario the workflow never runs, which would leave Appendix G 11 unproved while the suite stayed green.',
  },
  {
    name: 'the restore drill stops requiring a baseline to reconstruct',
    file: 'infra/scripts/rehearsal-restore-drill.sh',
    find: '  if [ "$count" -lt 1 ]; then',
    replace: '  if false; then',
    suite: ['run', 'test:release'],
    because:
      '"A restore drill against an empty database proves nothing." The drill has to fail its own setup rather than report a pass, and the scenario 11 check asserts the refusal is there.',
  },
];

function run(script) {
  return execFileSync('npm', script, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
}

let failures = 0;
let proven = 0;

for (const mutation of MUTATIONS) {
  const path = `${ROOT}${mutation.file}`;
  const original = readFileSync(path, 'utf8');
  const occurrences = original.split(mutation.find).length - 1;
  if (occurrences !== 1) {
    console.error(
      `MUTATION_STALE ${mutation.name}: the text it edits appears ${String(occurrences)} times in ${mutation.file}`,
    );
    failures += 1;
    continue;
  }

  try {
    writeFileSync(path, original.replace(mutation.find, mutation.replace));
    let stayedGreen = false;
    try {
      run(mutation.suite);
      stayedGreen = true;
    } catch {
      stayedGreen = false;
    }
    if (stayedGreen) {
      console.error(`MUTATION_SURVIVED ${mutation.name}`);
      console.error(`  ${mutation.because}`);
      console.error(`  The suite stayed green with ${mutation.file} broken, so it is not testing this.`);
      failures += 1;
    } else {
      proven += 1;
      console.error(`killed: ${mutation.name}`);
    }
  } finally {
    // Always, including on an interrupt: a mutation left in the tree is a broken
    // repository, and a half-finished run must not be one of the ways that happens.
    writeFileSync(path, original);
  }
}

console.error(`\n${String(proven)} mutation(s) killed, ${String(failures)} problem(s).`);
process.exitCode = failures === 0 ? 0 : 1;
