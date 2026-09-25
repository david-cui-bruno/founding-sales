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
// interrupted, which is why the restore is in a `finally`, the process listens for the
// signals that would otherwise end it mid-edit, and the originals are held in memory
// rather than in a sibling file somebody could leave behind.
//
//   npm run test:release:mutation -- --list
//
// lists every mutation, with its area and kind, and checks that each one's kind is known
// and its text still appears exactly once, without running a suite.
//
// The mutations are in `scripts/mutations/<area>.mjs`, one file per area of the tree,
// chosen by the file each entry edits (lane g93: one list that every lane appended to
// made every pull request conflict with every other). Add an entry to the end of its
// area's file; `MUTATION_AREAS` in `scripts/releaseMutationRunner.mjs` says which file
// that is, and the check refuses an entry in the wrong one. They run in area file name
// order, then in each file's own order.
//
// Each mutation names:
//
//   * `name`        — what the mutation does, as a sentence; unique across the list;
//   * `file`        — what is edited;
//   * `find`/`replace` — the exact edit, which must match exactly once;
//   * `suite`       — the arguments to `npm` for the vitest run that must then FAIL:
//                     `['run', 'test:release']`, `['run', 'test:release', '--', '<file>']`
//                     or `['run', 'test', '--workspace', '<workspace>', '--', '<file>']`;
//   * `because`     — the trap this proves is closed, in one sentence;
//   * `kind`        — optional: `'wiring'` for an edit to the suite's own map — the
//                     scenario map, a script path, a workflow's text — and `'behaviour'`,
//                     the default, for everything else. The runner reports the two
//                     kinds of kill apart (lane g86, audit T08) and counts them together.
//
// A mutation whose `find` does not appear, or appears more than once, is itself a
// failure: it means the code moved and the mutation is no longer testing what it says.
// A mutation that leaves the suite GREEN is the finding this script exists for.
//
// A red exit status is not a failing test. Each distinct suite runs once unmutated first
// and must pass, and a mutated run counts as a kill only when vitest itself reports a
// failure; an npm usage error or a setup that never reached a test is a problem. The
// rules, and the two ways they were learned, are in `scripts/releaseMutationRunner.mjs`.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  MUTATION_KINDS,
  loadMutations,
  mutationArea,
  mutationKind,
  runMutationCheck,
  spawnSuite,
} from './releaseMutationRunner.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const readFile = file => readFileSync(`${ROOT}${file}`, 'utf8');

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--list')) {
  console.error('usage: node scripts/releaseMutationCheck.mjs [--list]');
  process.exit(2);
}

let loaded;
try {
  loaded = await loadMutations(`${ROOT}scripts/mutations`);
} catch (error) {
  // A malformed list is a problem like a stale entry, and the nightly's summary step
  // reads it the same way.
  console.error(`MUTATION_STALE the mutation list: ${error instanceof Error ? error.message : String(error)}`);
  console.error('\n0 mutation(s) killed, 1 problem(s).');
  process.exit(1);
}
const { mutations, areas } = loaded;

if (args[0] === '--list') {
  // Nothing is edited and no suite runs: the list, and whether each entry's text is
  // still where it says, which is step 1 of the check.
  // The loader has already refused an entry filed under the wrong area.
  let problems = 0;
  for (const mutation of mutations) {
    const kind = mutationKind(mutation);
    console.log(`${String(mutationArea(mutation.file))}\t${String(kind)}\t${mutation.file}\t${mutation.name}`);
    if (!MUTATION_KINDS.includes(kind)) {
      problems += 1;
      console.error(`MUTATION_STALE ${mutation.name}: its kind is ${JSON.stringify(mutation.kind)}`);
    }
    const occurrences = readFile(mutation.file).split(mutation.find).length - 1;
    if (occurrences !== 1) {
      problems += 1;
      console.error(
        `MUTATION_STALE ${mutation.name}: the text it edits appears ${String(occurrences)} times in ${mutation.file}`,
      );
    }
  }
  console.error(
    `\n${String(mutations.length)} mutation(s) in ${String(areas.length)} area file(s): ` +
      `${areas.map(({ area, count }) => `${area} ${String(count)}`).join(', ')}; ` +
      `${String(mutations.filter(mutation => mutationKind(mutation) === 'wiring').length)} wiring; ${String(problems)} stale.`,
  );
  process.exit(problems === 0 ? 0 : 1);
}

// A listener on each of these keeps Node from exiting mid-mutation with a file still
// broken; the check stops after restoring it instead. An interactive Ctrl-C reaches the
// suite's npm as well, which ends that run at once.
let stopRequested = false;
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    stopRequested = true;
  });
}

const { problems } = await runMutationCheck({
  mutations,
  runSuite: suite => spawnSuite(ROOT, suite),
  readFile,
  writeFile: (file, text) => writeFileSync(`${ROOT}${file}`, text),
  log: line => console.error(line),
  stopRequested: () => stopRequested,
});
process.exitCode = problems === 0 ? 0 : 1;
