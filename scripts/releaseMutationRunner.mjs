// The runner behind `npm run test:release:mutation` (scripts/releaseMutationCheck.mjs).
//
// This module does nothing when it is imported. It holds the part of the mutation check
// that decides what a suite run *means*, so that `test/release/mutationRunner.check.ts`
// can prove those decisions without running a single mutation, and so that the list of
// mutations and the machinery that judges them are not one file edited by every lane.
//
// ## Why the verdict reads the output as well as the exit status
//
// Until lane g54 (24 September 2026) a mutation counted as killed whenever `npm` exited
// non-zero. Ten entries named their suite as `['--workspace', 'apps/worker', '--', …]`
// with no `run test` in front, so npm answered `Unknown command: "test/fssCli.test.ts"`
// and exited 1 before any test ran. Every one of those ten was "killed", from the
// check's first commit on 20 September 2026, without a test ever being asked.
// Separately, a worktree installed with `npm ci --ignore-scripts` and no
// `npm rebuild @embedded-postgres/darwin-arm64` cannot start the local PostgreSQL, so
// every suite fails in its globalSetup: the whole check reported "67 mutation(s) killed,
// 0 problem(s)" in 33 seconds having tested nothing.
//
// Both are the same mistake: a red exit status is not a failing test. So:
//
//   * every distinct suite runs once on the pristine tree first and must be GREEN — a
//     suite that is red before anything is broken cannot be red *because* something was
//     broken, and its mutations are reported, not run;
//   * a run is RED only when it exits non-zero *and* vitest's own summary reports a
//     failed test file, a failed test or an error;
//   * anything else — an npm usage error, a setup failure before any test ran, a run
//     stopped by a signal, output too large to read — is BROKEN, which is a problem and
//     never a kill.

import { spawnSync } from 'node:child_process';

/**
 * Appended to every suite invocation, the pristine run and the mutated runs alike, so
 * the run that proves a suite green is the same command as the run that must go red.
 *
 * `--bail=1` stops a run at its first failing test: a mutation is killed by one failure,
 * and the rest of the suite adds time and no information. It changes nothing for the
 * pristine run, which has no failure to stop at. The saving is small (about 7% across a
 * sample of whole-release-suite mutations on 24 September 2026, because the files
 * already running finish), but it is free. `--reporter=dot` because the output is
 * captured and only shown when something is wrong; the summary this module reads is
 * printed by every vitest reporter.
 */
export const VITEST_FLAGS = Object.freeze(['--reporter=dot', '--bail=1']);

/** The `npm` arguments for one suite: the mutation's `suite` with the vitest flags after `--`. */
export function suiteInvocation(suite) {
  return suite.includes('--') ? [...suite, ...VITEST_FLAGS] : [...suite, '--', ...VITEST_FLAGS];
}

/** A suite as a person would type it, for messages. */
export function describeSuite(suite) {
  return `npm ${suite.join(' ')}`;
}

// Colour codes: GitHub Actions sets CI, and vitest colours its summary when it sees it.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/gu;

/** Room for any suite's output. Node's default of 1 MiB fails the run when exceeded. */
const OUTPUT_LIMIT_BYTES = 256 * 1024 * 1024;

/** The last lines of a run's output, for a problem report. */
export function outputTail(output, lines = 30) {
  return output.replace(ANSI, '').trimEnd().split('\n').slice(-lines);
}

/**
 * What one suite run says.
 *
 * `run` is `spawnSync`'s result, or the same shape: `status`, `signal`, `error`,
 * `stdout`, `stderr`. The answer is `{ verdict: 'green' | 'red' | 'broken', reason }`.
 *
 *   green  — exit 0, vitest's summary names at least one test file that passed and
 *            nothing that failed;
 *   red    — exit non-zero, and vitest's summary names a failed test file, a failed
 *            test or an error;
 *   broken — everything else, with the reason. Never a kill.
 */
export function readSuiteRun(run) {
  const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`.replace(ANSI, '');
  if (run.error) {
    return { verdict: 'broken', reason: `npm could not be run to the end: ${String(run.error.message ?? run.error)}` };
  }
  if (run.signal) return { verdict: 'broken', reason: `npm was stopped by ${String(run.signal)}` };

  // vitest's closing summary: " Test Files  1 failed | 52 passed (53)", then
  // "      Tests  1 failed | 406 passed (407)", then "     Errors  1 error" if any.
  const files = /^ *Test Files +(.+)$/mu.exec(output)?.[1];
  if (files === undefined) {
    // npm refuses an invocation before vitest starts, so its usage errors never carry
    // a summary; naming them is only for the message.
    if (/^(?:npm error )?Unknown command: /mu.test(output)) {
      return { verdict: 'broken', reason: 'npm answered "Unknown command": the suite is not a test run' };
    }
    if (/^npm error Missing script: /mu.test(output)) {
      return { verdict: 'broken', reason: 'npm answered "Missing script": the suite is not a test run' };
    }
    return {
      verdict: 'broken',
      reason: `exited ${String(run.status)} with no vitest summary, so no test reported anything`,
    };
  }
  const tests = /^ *Tests +(.+)$/mu.exec(output)?.[1] ?? '';
  const errors = /^ *Errors +\d+ errors?\b/mu.test(output);
  const failed = /\b\d+ failed\b/u.test(files) || /\b\d+ failed\b/u.test(tests) || errors;
  const ranFiles = /\b\d+ (?:passed|failed)\b/u.test(files);

  if (run.status === 0) {
    if (failed) {
      // The G5b shape (docs/decisions/g5b-gate-exit-status.md): an exit hook replaced
      // vitest's exit code with 0. A kill cannot be read from a process that does this.
      return { verdict: 'broken', reason: 'vitest reported a failure and the run exited 0' };
    }
    if (!ranFiles) return { verdict: 'broken', reason: `exited 0 having run no test file (Test Files ${files.trim()})` };
    return { verdict: 'green', reason: `Test Files ${files.trim()}` };
  }
  if (failed && ranFiles) return { verdict: 'red', reason: `Test Files ${files.trim()}` };
  return {
    verdict: 'broken',
    reason: `exited ${String(run.status)} and vitest reported no failing test (Test Files ${files.trim()})`,
  };
}

/** Run one suite from `root` and read it. */
export function spawnSuite(root, suite) {
  const started = process.hrtime.bigint();
  const run = spawnSync('npm', suiteInvocation(suite), {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: OUTPUT_LIMIT_BYTES,
  });
  const seconds = Number(process.hrtime.bigint() - started) / 1e9;
  return {
    ...readSuiteRun(run),
    signal: run.signal ?? null,
    output: `${run.stdout ?? ''}\n${run.stderr ?? ''}`,
    seconds,
  };
}

const INTERRUPTS = new Set(['SIGINT', 'SIGTERM', 'SIGHUP']);

/**
 * Prove each mutation is killed by its suite.
 *
 *   mutations  — `{ name, file, find, replace, suite, because }[]`, `file` relative to the root;
 *   runSuite   — `suite => { verdict, reason, output, seconds, signal }`, `spawnSuite` in use;
 *   readFile / writeFile — relative path in, text in or out;
 *   log        — one line at a time;
 *   stopRequested — true once the process has been asked to stop.
 *
 * Returns `{ killed, problems, interrupted }`. The last line logged is always
 * `N mutation(s) killed, M problem(s).`; CI and the coordinator's records read it.
 */
export async function runMutationCheck({ mutations, runSuite, readFile, writeFile, log, stopRequested = () => false }) {
  let killed = 0;
  let problems = 0;
  let interrupted = false;
  const timing = { unmutated: 0, mutated: 0, seconds: 0 };
  const problem = (line, ...detail) => {
    problems += 1;
    log(line);
    for (const text of detail) log(`  ${text}`);
  };
  const seconds = run => `${run.seconds.toFixed(1)} s`;
  // Signal listeners only run when the loop yields, so it yields after every suite.
  const yieldToSignals = () => new Promise(resolve => setImmediate(resolve));
  const noteInterrupt = run => {
    if (INTERRUPTS.has(run.signal) || stopRequested()) interrupted = true;
  };

  // 1. Every mutation's text, before anything runs or is written.
  const ready = [];
  for (const mutation of mutations) {
    const occurrences = readFile(mutation.file).split(mutation.find).length - 1;
    if (occurrences !== 1) {
      problem(
        `MUTATION_STALE ${mutation.name}: the text it edits appears ${String(occurrences)} times in ${mutation.file}`,
      );
      continue;
    }
    ready.push(mutation);
  }

  // 2. Every distinct suite once, on the pristine tree. Only a green suite can kill.
  const pristine = new Map();
  for (const mutation of ready) {
    const key = JSON.stringify(mutation.suite);
    if (pristine.has(key) || interrupted) continue;
    const run = runSuite(mutation.suite);
    pristine.set(key, run);
    timing.unmutated += 1;
    timing.seconds += run.seconds;
    if (run.verdict === 'green') {
      log(`green before mutation (${seconds(run)}): ${describeSuite(mutation.suite)}`);
    } else {
      problem(
        `SUITE_RED_BEFORE_MUTATION suite fails before mutation: ${describeSuite(mutation.suite)}`,
        `${run.reason}. Nothing it says after a mutation can be read as a kill, so its mutations are not run.`,
        ...outputTail(run.output),
      );
    }
    await yieldToSignals();
    noteInterrupt(run);
  }

  // 3. Each mutation, one at a time: they edit files in place.
  for (const mutation of ready) {
    if (interrupted) break;
    const before = pristine.get(JSON.stringify(mutation.suite));
    if (before?.verdict !== 'green') {
      problem(`MUTATION_NOT_RUN ${mutation.name}: its suite fails before mutation (${describeSuite(mutation.suite)})`);
      continue;
    }
    const original = readFile(mutation.file);
    let run;
    try {
      writeFile(mutation.file, original.replace(mutation.find, () => mutation.replace));
      run = runSuite(mutation.suite);
      timing.mutated += 1;
      timing.seconds += run.seconds;
    } finally {
      // Always: a mutation left in the tree is a broken repository.
      writeFile(mutation.file, original);
    }
    if (run.verdict === 'red') {
      killed += 1;
      log(`killed (${seconds(run)}): ${mutation.name}`);
    } else if (run.verdict === 'green') {
      problem(
        `MUTATION_SURVIVED ${mutation.name}`,
        mutation.because,
        `The suite stayed green with ${mutation.file} broken, so it is not testing this.`,
      );
    } else {
      problem(
        `MUTATION_UNDECIDED ${mutation.name}: ${run.reason}`,
        `The suite (${describeSuite(mutation.suite)}) did not fail a test, so this is not a kill.`,
        ...outputTail(run.output),
      );
    }
    await yieldToSignals();
    noteInterrupt(run);
  }

  if (interrupted) {
    problem('INTERRUPTED the check was stopped before every mutation ran; every file it edited has been restored');
  }
  log(
    `\n${String(timing.unmutated + timing.mutated)} suite run(s) in ${timing.seconds.toFixed(0)} s: ` +
      `${String(timing.unmutated)} unmutated, ${String(timing.mutated)} mutated.`,
  );
  log(`\n${String(killed)} mutation(s) killed, ${String(problems)} problem(s).`);
  return { killed, problems, interrupted };
}
