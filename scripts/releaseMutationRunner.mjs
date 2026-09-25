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
//
// ## A failing test file is not a failing test (lane g80, audit item T01)
//
// The rule above still counted one thing that is not a kill. A mutation whose edit does
// not parse — a `.ts` file esbuild cannot transform, an `.mjs` file vite cannot analyse,
// a script node or python or bash refuses to read — fails every test file that loads
// it *before any test runs*: vitest prints "Failed Suites 1", "Test Files  1 failed",
// "Tests  no tests", and exits 1. That summary names a failed test file, so it was read
// as red, and the mutation was counted as killed without one assertion having executed.
// The audit reproduced exactly that. It proves the edit was malformed, not that the
// suite tests the trap. So a red verdict now needs a failed *test* — vitest's "Tests"
// line must name one — and output that shows a syntax or transform failure is BROKEN
// whatever else it says: a test that failed because the file under test would not
// load has failed for the wrong reason. Such a run is its own kind of broken
// (`brokenRuns` below, and `broken run:` in the problem line), and like every broken
// run it is a problem, so the nightly fails on it.

// ## Wiring is not behaviour (lane g86, audit item T08)
//
// Some mutations break the release suite's own map rather than the product: a scenario
// number in `test/release/support/scenarioMap.ts`, a script path, a step of a GitHub
// workflow. They are worth running — a map that silently loses a scenario is a scenario
// nobody runs — but a kill there proves the index is checked, not that a process
// refuses what it should. So an entry may say `kind: 'wiring'`; one that says nothing is
// `'behaviour'`. The counts and the closing line are unchanged; one line before it says
// how many of the kills were each kind, so a total never reads as more behavioural
// confidence than it holds. Any other `kind` is a malformed entry, reported like a
// stale one.

import { spawnSync } from 'node:child_process';

/** The two kinds of mutation, and the one an entry without a `kind` is. */
export const MUTATION_KINDS = Object.freeze(['behaviour', 'wiring']);
export const DEFAULT_MUTATION_KIND = 'behaviour';

/** An entry's kind: its own, or the default. Unknown values come back as they are. */
export function mutationKind(mutation) {
  return mutation.kind ?? DEFAULT_MUTATION_KIND;
}

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

/**
 * What a syntax or transform failure looks like in a suite's output, one pattern per
 * tool that can refuse to read a mutated file:
 *
 *   * vite and esbuild, which load every test file and what it imports: "Transform
 *     failed with 1 error", "Failed to parse source for import analysis", "Parse
 *     failure";
 *   * node and python, when a test runs a script that will not parse: a `SyntaxError:`
 *     (or python's `IndentationError:`/`TabError:`) line. Not one about JSON:
 *     `JSON.parse` throws a SyntaxError too, and a test that parsed a command's output
 *     and got something else has failed for a real reason;
 *   * bash, whose parser says `<file>: line N: syntax error …`.
 *
 * Every pattern is anchored where the tool prints it: at the start of a line, or
 * straight after the error name vitest puts in front of a failure message. That is
 * what keeps a failure *report* from reading as a failure to parse. vitest prints the
 * source around a failed assertion (`  243|     expect(…).toContain('Transform
 * failed …')`) and the values it compared, and a test about these very messages — this
 * runner's own — would otherwise turn every kill into a broken run.
 *
 * Returns the first matching line, or null.
 */
const SYNTAX_FAILURES = Object.freeze([
  /^[ \t]*(?:[A-Za-z]*Error: )?Transform failed with \d+ errors?/mu,
  /^[ \t]*(?:[A-Za-z]*Error: )?Failed to parse source for import analysis/mu,
  /^[ \t]*(?:[A-Za-z]*Error: )?Parse failure: /mu,
  /^[ \t]*(?:SyntaxError|IndentationError|TabError): (?!.*\bJSON\b).*$/mu,
  /^(?:[ \t]*[A-Za-z]*Error: )?[^\s|+-]\S*(?:: -c)?: line \d+: syntax error\b/mu,
]);

export function syntaxFailure(output) {
  for (const pattern of SYNTAX_FAILURES) {
    const match = pattern.exec(output);
    if (match) {
      const start = output.lastIndexOf('\n', match.index) + 1;
      const end = output.indexOf('\n', match.index);
      return output.slice(start, end < 0 ? undefined : end).trim();
    }
  }
  return null;
}

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
 *   red    — exit non-zero, at least one test executed, vitest's "Tests" line names a
 *            failed test (or its summary an error thrown while tests ran), and nothing
 *            in the output is a syntax or transform failure;
 *   broken — everything else, with the reason. Never a kill. A run that never executed
 *            a failing test — a syntax or transform failure, a test file that failed to
 *            load, "Tests  no tests" — also carries `brokenRun: true`, the T01 bucket.
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
  // T01: a kill is a test that ran and failed, and nothing that could not be read.
  const summary = `Test Files ${files.trim()}; Tests ${tests.trim() || '<none>'}`;
  const syntax = syntaxFailure(output);
  if (syntax !== null) {
    return {
      verdict: 'broken',
      brokenRun: true,
      reason: `broken run: a syntax or transform failure, not a failing test (${syntax}; ${summary})`,
    };
  }
  const testFailed = /\b\d+ failed\b/u.test(tests);
  const testsRan = /\b\d+ (?:passed|failed)\b/u.test(tests);
  if (!testFailed && !(errors && testsRan)) {
    return { verdict: 'broken', brokenRun: true, reason: `broken run: no test executed and failed (${summary})` };
  }
  if (failed && ranFiles) return { verdict: 'red', reason: summary };
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
 *   mutations  — `{ name, file, find, replace, suite, because, kind? }[]`, `file` relative to the
 *                root, `kind` `'behaviour'` (the default) or `'wiring'`;
 *   runSuite   — `suite => { verdict, reason, output, seconds, signal }`, `spawnSuite` in use;
 *   readFile / writeFile — relative path in, text in or out;
 *   log        — one line at a time;
 *   stopRequested — true once the process has been asked to stop.
 *
 * Returns `{ killed, killedByKind, problems, brokenRuns, interrupted }`. `brokenRuns`
 * counts the mutated runs that never executed a failing test (T01); each is also a
 * problem. `killedByKind` splits `killed` into `behaviour` and `wiring` (T08) and always
 * sums to it. The last line logged is always `N mutation(s) killed, M problem(s).`; CI
 * and the coordinator's records read it.
 */
export async function runMutationCheck({ mutations, runSuite, readFile, writeFile, log, stopRequested = () => false }) {
  let killed = 0;
  const killedByKind = { behaviour: 0, wiring: 0 };
  let problems = 0;
  let brokenRuns = 0;
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
    if (!MUTATION_KINDS.includes(mutationKind(mutation))) {
      problem(
        `MUTATION_STALE ${mutation.name}: its kind is ${JSON.stringify(mutation.kind)}, and a mutation is ${MUTATION_KINDS.map(kind => `'${kind}'`).join(' or ')}`,
      );
      continue;
    }
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
      killedByKind[mutationKind(mutation)] += 1;
      log(`killed (${seconds(run)}): ${mutationKind(mutation) === 'wiring' ? '[wiring] ' : ''}${mutation.name}`);
    } else if (run.verdict === 'green') {
      problem(
        `MUTATION_SURVIVED ${mutation.name}`,
        mutation.because,
        `The suite stayed green with ${mutation.file} broken, so it is not testing this.`,
      );
    } else {
      // The nightly's summary step lists problem lines by their first word, so a broken
      // run keeps MUTATION_UNDECIDED and says which kind it is after the name.
      if (run.brokenRun === true) brokenRuns += 1;
      problem(
        `MUTATION_UNDECIDED ${mutation.name}: ${run.reason}`,
        run.brokenRun === true
          ? `The suite (${describeSuite(mutation.suite)}) never executed a failing test: the mutated file did not load, or no test ran. A mutation must leave the file valid and fail a test.`
          : `The suite (${describeSuite(mutation.suite)}) did not fail a test, so this is not a kill.`,
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
  if (brokenRuns > 0) {
    log(`\n${String(brokenRuns)} broken run(s): a mutated suite that never executed a failing test is never a kill.`);
  }
  log(
    `\nOf the kills, ${String(killedByKind.behaviour)} broke product or release behaviour and ` +
      `${String(killedByKind.wiring)} only the suite's wiring (the scenario map, script paths, workflow text).`,
  );
  log(`\n${String(killed)} mutation(s) killed, ${String(problems)} problem(s).`);
  return { killed, killedByKind, problems, brokenRuns, interrupted };
}
