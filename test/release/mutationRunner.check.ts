import { describe, expect, it } from 'vitest';
import { repositoryPath } from './support/coverage.ts';

/**
 * The mutation check's own verdicts (`scripts/releaseMutationRunner.mjs`, lane g54).
 *
 * `npm run test:release:mutation` breaks each trap and requires its suite to fail. Until
 * g54 "fail" meant "npm exited non-zero", and two things that are not a failing test
 * exit non-zero: npm refusing the invocation (`Unknown command`, ten entries since
 * 20 September 2026) and a suite whose setup never reached a test (every suite, in a
 * worktree whose embedded PostgreSQL was never hydrated). Both were counted as kills.
 *
 * ## The vacuous-pass trap, named
 *
 * The runner is the thing that decides whether every other trap is closed, so a runner
 * that counted anything red as a kill would make all of them vacuous at once and still
 * print "N mutation(s) killed, 0 problem(s)". This file feeds it the exact output of the
 * two cases that fooled it, and a fake suite that is red before any mutation, and requires
 * a problem rather than a kill each time. Two mutations in
 * `scripts/releaseMutationCheck.mjs` put the old behaviour back and require this file to
 * go red.
 *
 * Lane g80 (audit item T01) closes the case that was still counted: a mutated file that
 * does not parse fails every test file that loads it before any test runs, and vitest's
 * "Test Files  1 failed" read as red. The fixtures below are the shapes vitest 2.1.9
 * printed for probes run on 25 September 2026 — a `.ts` file esbuild could not
 * transform, a test file failing to load beside passing ones — plus a test that failed
 * because the script it ran did not parse, and the two things that must stay kills: an
 * assertion whose message happens to say "syntax error", and a `JSON.parse` that threw.
 * Two more mutations take each half of the rule away.
 */

interface SuiteRun {
  status: number | null;
  signal: string | null;
  error?: Error;
  stdout: string;
  stderr: string;
}

interface Verdict {
  verdict: 'green' | 'red' | 'broken';
  reason: string;
  brokenRun?: boolean;
}

interface JudgedRun extends Verdict {
  output: string;
  seconds: number;
  signal: string | null;
}

interface Mutation {
  name: string;
  file: string;
  find: string;
  replace: string;
  suite: string[];
  because: string;
}

interface Runner {
  VITEST_FLAGS: readonly string[];
  suiteInvocation(suite: readonly string[]): string[];
  readSuiteRun(run: SuiteRun): Verdict;
  runMutationCheck(options: {
    mutations: Mutation[];
    runSuite: (suite: string[]) => JudgedRun;
    readFile: (file: string) => string;
    writeFile: (file: string, text: string) => void;
    log: (line: string) => void;
    stopRequested?: () => boolean;
  }): Promise<{ killed: number; problems: number; brokenRuns: number; interrupted: boolean }>;
}

// A computed specifier: the module is plain ESM with no declarations, and this file
// states the shape it relies on instead.
const RUNNER_PATH = repositoryPath('scripts/releaseMutationRunner.mjs');
const runner = (await import(RUNNER_PATH)) as Runner;

// Captured from real runs on 24 September 2026 (npm 11.19.0, vitest 2.1.9).
const NPM_UNKNOWN_COMMAND: SuiteRun = {
  status: 1,
  signal: null,
  stdout: 'Unknown command: "test/fssCli.test.ts"\n\nTo see a list of supported npm commands, run:\n  npm help\n',
  stderr: '',
};

const SETUP_NEVER_REACHED_A_TEST: SuiteRun = {
  status: 1,
  signal: null,
  stdout:
    '\n> callie-founder-sales-system@1.0.0 test:release\n> vitest run --config test/release/vitest.config.ts\n\n' +
    ' RUN  v2.1.9 /repository\n\n\n Test Files  no tests\n      Tests  no tests\n   Start at  15:58:21\n' +
    '   Duration  198ms (transform 64ms, setup 0ms, collect 0ms, tests 0ms, environment 0ms, prepare 0ms)\n\n',
  stderr:
    '⎯⎯⎯⎯⎯⎯ Unhandled Error ⎯⎯⎯⎯⎯⎯⎯\nError: Postgres init script failed (code: null, signal: SIGABRT). ERROR OUTPUT: ' +
    'dyld[67382]: Library not loaded: @loader_path/../lib/libicudata.68.dylib\n',
};

const NO_TEST_FILES: SuiteRun = {
  status: 1,
  signal: null,
  stdout: '\n RUN  v2.1.9 /repository\n\ninclude: test/**/*.test.ts\n\nNo test files found, exiting with code 1\n',
  stderr: '',
};

// As GitHub Actions prints it: CI is set, so vitest colours the summary.
const A_TEST_FAILED: SuiteRun = {
  status: 1,
  signal: null,
  stdout:
    '\n RUN  v2.1.9 /repository\n\n' +
    '\u001b[2m Test Files \u001b[22m \u001b[1m\u001b[31m1 failed\u001b[39m\u001b[22m\u001b[2m | \u001b[22m' +
    '\u001b[1m\u001b[32m1 passed\u001b[39m\u001b[22m\u001b[90m (2)\u001b[39m\n' +
    '\u001b[2m      Tests \u001b[22m \u001b[1m\u001b[31m1 failed\u001b[39m\u001b[22m\u001b[2m | \u001b[22m' +
    '\u001b[1m\u001b[32m2 passed\u001b[39m\u001b[22m\u001b[90m (7)\u001b[39m\n',
  stderr: ' FAIL  test/a.test.ts > fails\nAssertionError: expected 2 to be 1\n',
};

// Probe of 25 September 2026: a test importing a `.ts` file with `(;` in it.
const TRANSFORM_FAILED: SuiteRun = {
  status: 1,
  signal: null,
  stdout:
    '\n RUN  v2.1.9 /repository\n\n \u276f imports.test.ts (0 test)\n\n' +
    '\u23af\u23af\u23af\u23af\u23af\u23af Failed Suites 1 \u23af\u23af\u23af\u23af\u23af\u23af\u23af\n\n' +
    ' FAIL  imports.test.ts [ imports.test.ts ]\n' +
    'Error: Transform failed with 1 error:\n/repository/broken.ts:1:26: ERROR: Unexpected ";"\n' +
    '  Plugin: vite:esbuild\n  File: /repository/broken.ts:1:26\n\n' +
    ' Test Files  1 failed (1)\n      Tests  no tests\n   Start at  13:51:24\n',
  stderr: '',
};

// The same probe with a passing file beside it: a file failed, no test did.
const LOAD_FAILED_BESIDE_PASSES: SuiteRun = {
  status: 1,
  signal: null,
  stdout:
    '\n RUN  v2.1.9 /repository\n\n \u2713 one.test.ts (3 tests) 1ms\n \u276f two.test.ts (0 test)\n\n' +
    '\u23af\u23af\u23af\u23af\u23af\u23af Failed Suites 1 \u23af\u23af\u23af\u23af\u23af\u23af\u23af\n\n' +
    ' FAIL  two.test.ts [ two.test.ts ]\nReferenceError: guard is not defined\n \u276f two.test.ts:3:1\n\n' +
    ' Test Files  1 failed | 1 passed (2)\n      Tests  3 passed (3)\n',
  stderr: '',
};

// A test that ran a script and failed because node would not parse it.
const SCRIPT_DID_NOT_PARSE: SuiteRun = {
  status: 1,
  signal: null,
  stdout:
    '\n RUN  v2.1.9 /repository\n\n' +
    ' FAIL  test/release/smoke.check.ts > the smoke passes\n' +
    'AssertionError: file:///repository/scripts/productionSmoke.mjs:229\n' +
    "    record('sending', enabled ===, detail);\n                                 ^\n\n" +
    "SyntaxError: Unexpected token ','\n    at compileSourceTextModule (node:internal/modules/esm/utils:344:16)\n" +
    ': expected 1 to be +0 // Object.is equality\n\n' +
    ' Test Files  1 failed (1)\n      Tests  1 failed | 4 passed (5)\n',
  stderr: '',
};

// And the same, for a shell script bash would not parse.
const SHELL_DID_NOT_PARSE: SuiteRun = {
  status: 1,
  signal: null,
  stdout:
    ' FAIL  test/release/scenario22.check.ts > deploys\n' +
    "AssertionError: /repository/infra/scripts/release-deploy.sh: line 412: syntax error near unexpected token `fi'\n" +
    ': expected 2 to be +0\n\n Test Files  1 failed (1)\n      Tests  1 failed | 30 passed (31)\n',
  stderr: '',
};

// Still kills: an assertion that mentions a syntax error, and a JSON.parse that threw.
const ASSERTION_ABOUT_A_SYNTAX_ERROR: SuiteRun = {
  status: 1,
  signal: null,
  stdout:
    ' FAIL  assert.test.ts > fails with syntax text in the message\n' +
    "AssertionError: expected 'bash: syntax error near unexpected to\u2026' to be 'ok' // Object.is equality\n\n" +
    'Expected: "ok"\nReceived: "bash: syntax error near unexpected token"\n\n' +
    ' Test Files  1 failed (1)\n      Tests  1 failed | 1 passed (2)\n',
  stderr: '',
};

// A kill whose report quotes these very messages: vitest prints the source around the
// failed assertion, and this file's assertions name them. Found by applying one of
// g80's own mutations: the first rule read the code frame as a transform failure.
const REPORT_QUOTES_A_TRANSFORM_FAILURE: SuiteRun = {
  status: 1,
  signal: null,
  stdout:
    ' FAIL  test/release/mutationRunner.check.ts > never reads a mutated file that did not parse\n' +
    "AssertionError: expected 'broken run: no test executed and failed' to contain 'syntax or transform failure'\n" +
    ' \u276f test/release/mutationRunner.check.ts:243:32\n' +
    "    242|     expect(transform.reason).toContain('syntax or transform failure');\n" +
    "    243|     expect(transform.reason).toContain('Transform failed with 1 error');\n" +
    '       |                                ^\n' +
    "    244|     // a bash fixture says 'deploy.sh: line 3: syntax error' and a node one 'SyntaxError: x'\n\n" +
    '- Expected\n+ Received\n\n- SyntaxError: Unexpected token\n+ Transform failed with 1 error\n\n' +
    ' Test Files  1 failed (1)\n      Tests  1 failed | 5 passed (6)\n',
  stderr: '',
};

const JSON_DID_NOT_PARSE: SuiteRun = {
  status: 1,
  signal: null,
  stdout:
    ' FAIL  test/release/scenario42.check.ts > parses the record\n' +
    'SyntaxError: Unexpected token \'P\', "PLAN aws e"... is not valid JSON\n' +
    ' \u276f test/release/scenario42.check.ts:80:12\n\n' +
    ' Test Files  1 failed (1)\n      Tests  1 failed | 12 passed (13)\n',
  stderr: '',
};

const ALL_PASSED: SuiteRun = {
  status: 0,
  signal: null,
  stdout: '\n RUN  v2.1.9 /repository\n\n Test Files  53 passed (53)\n      Tests  407 passed (407)\n',
  stderr: '',
};

describe('the mutation runner reads a suite run by what vitest reported, not only by its exit status', () => {
  it('passes the vitest flags after the one `--`, adding it when the suite has none', () => {
    expect(runner.suiteInvocation(['run', 'test:release'])).toEqual(['run', 'test:release', '--', ...runner.VITEST_FLAGS]);
    expect(runner.suiteInvocation(['run', 'test', '--workspace', 'apps/worker', '--', 'test/fssCli.test.ts'])).toEqual([
      'run',
      'test',
      '--workspace',
      'apps/worker',
      '--',
      'test/fssCli.test.ts',
      ...runner.VITEST_FLAGS,
    ]);
    expect(runner.VITEST_FLAGS).toContain('--bail=1');
  });

  it('never reads an npm usage error as a failing test', () => {
    const verdict = runner.readSuiteRun(NPM_UNKNOWN_COMMAND);
    expect(verdict.verdict).toBe('broken');
    expect(verdict.reason).toContain('Unknown command');
  });

  it('never reads a setup that reached no test as a failing test', () => {
    expect(runner.readSuiteRun(SETUP_NEVER_REACHED_A_TEST).verdict).toBe('broken');
    expect(runner.readSuiteRun(NO_TEST_FILES).verdict).toBe('broken');
  });

  it('never reads a run stopped by a signal, or cut off, as a failing test', () => {
    expect(runner.readSuiteRun({ ...A_TEST_FAILED, status: null, signal: 'SIGTERM' }).verdict).toBe('broken');
    expect(runner.readSuiteRun({ ...A_TEST_FAILED, error: new Error('spawnSync npm ENOBUFS') }).verdict).toBe('broken');
  });

  it('reads a failed test as red, colours and all', () => {
    expect(runner.readSuiteRun(A_TEST_FAILED).verdict).toBe('red');
  });

  it('never reads a mutated file that did not parse as a failing test, even when a test failed on it', () => {
    // The audit's shape exactly: "Test Files 1 failed", "Tests no tests", a transform error.
    const transform = runner.readSuiteRun(TRANSFORM_FAILED);
    expect(transform).toMatchObject({ verdict: 'broken', brokenRun: true });
    expect(transform.reason).toContain('syntax or transform failure');
    expect(transform.reason).toContain('Transform failed with 1 error');
    // A test ran the script and failed, but only because the script would not load.
    for (const run of [SCRIPT_DID_NOT_PARSE, SHELL_DID_NOT_PARSE]) {
      const verdict = runner.readSuiteRun(run);
      expect(verdict, verdict.reason).toMatchObject({ verdict: 'broken', brokenRun: true });
      expect(verdict.reason).toContain('syntax or transform failure');
    }
  });

  it('never reads a test file that failed to load, beside tests that passed, as a failing test', () => {
    const verdict = runner.readSuiteRun(LOAD_FAILED_BESIDE_PASSES);
    expect(verdict).toMatchObject({ verdict: 'broken', brokenRun: true });
    expect(verdict.reason).toContain('no test executed and failed');
    // The setup that never reached a test is the same bucket.
    expect(runner.readSuiteRun(SETUP_NEVER_REACHED_A_TEST)).toMatchObject({ verdict: 'broken', brokenRun: true });
  });

  it('still reads an assertion that mentions a syntax error, a JSON.parse that threw, or a report quoting either, as a kill', () => {
    expect(runner.readSuiteRun(ASSERTION_ABOUT_A_SYNTAX_ERROR).verdict).toBe('red');
    expect(runner.readSuiteRun(JSON_DID_NOT_PARSE).verdict).toBe('red');
    // Nor does a failure report that quotes the messages, in its code frame or its diff.
    expect(runner.readSuiteRun(REPORT_QUOTES_A_TRANSFORM_FAILURE).verdict).toBe('red');
  });

  it('reads a clean pass as green, and refuses a pass that printed failures or ran nothing', () => {
    expect(runner.readSuiteRun(ALL_PASSED).verdict).toBe('green');
    // The G5b shape: failures printed, exit 0.
    expect(runner.readSuiteRun({ ...A_TEST_FAILED, status: 0 }).verdict).toBe('broken');
    expect(runner.readSuiteRun({ ...SETUP_NEVER_REACHED_A_TEST, status: 0 }).verdict).toBe('broken');
  });
});

describe('the mutation runner only counts a kill from a suite that was green before the mutation', () => {
  const TARGET = 'src/target.ts';
  const PRISTINE = 'export const guard = true;\n';

  function judged(run: SuiteRun): JudgedRun {
    return { ...runner.readSuiteRun(run), output: `${run.stdout}\n${run.stderr}`, seconds: 0, signal: run.signal };
  }

  function mutation(name: string, suite: string[]): Mutation {
    return { name, file: TARGET, find: 'guard = true', replace: 'guard = false', suite, because: 'a fixture' };
  }

  async function check(mutations: Mutation[], answer: (suite: string[], mutated: boolean) => SuiteRun) {
    let text = PRISTINE;
    const writes: string[] = [];
    const runs: { suite: string; mutated: boolean }[] = [];
    const lines: string[] = [];
    const result = await runner.runMutationCheck({
      mutations,
      runSuite: suite => {
        const mutated = text !== PRISTINE;
        runs.push({ suite: suite.join(' '), mutated });
        return judged(answer(suite, mutated));
      },
      readFile: file => {
        expect(file).toBe(TARGET);
        return text;
      },
      writeFile: (_file, next) => {
        writes.push(next);
        text = next;
      },
      log: line => lines.push(line),
    });
    return { result, text, writes, runs, lines };
  }

  it('reports a suite that is red unmutated as a problem, and runs none of its mutations', async () => {
    // Red before and after: the old runner counted this as a kill.
    const outcome = await check([mutation('broken suite', ['run', 'test:red'])], () => A_TEST_FAILED);
    expect(outcome.result).toMatchObject({ killed: 0 });
    expect(outcome.result.problems).toBeGreaterThan(0);
    expect(outcome.lines.join('\n')).toContain('suite fails before mutation: npm run test:red');
    expect(outcome.runs).toEqual([{ suite: 'run test:red', mutated: false }]);
    expect(outcome.writes).toEqual([]);
  });

  it('reports a mutated run that is an npm usage error as a problem, not a kill', async () => {
    const outcome = await check([mutation('usage error', ['run', 'test:green'])], (_suite, mutated) =>
      mutated ? NPM_UNKNOWN_COMMAND : ALL_PASSED,
    );
    expect(outcome.result).toEqual({ killed: 0, problems: 1, brokenRuns: 0, interrupted: false });
    expect(outcome.text).toBe(PRISTINE);
  });

  it('reports a mutated run whose file did not parse as a broken run, and a problem, never a kill', async () => {
    const outcome = await check([mutation('malformed edit', ['run', 'test:green'])], (_suite, mutated) =>
      mutated ? TRANSFORM_FAILED : ALL_PASSED,
    );
    expect(outcome.result).toEqual({ killed: 0, problems: 1, brokenRuns: 1, interrupted: false });
    const text = outcome.lines.join('\n');
    expect(text).toContain('MUTATION_UNDECIDED malformed edit: broken run: a syntax or transform failure');
    expect(text).toContain('never executed a failing test');
    expect(text).toContain('1 broken run(s)');
    expect(outcome.lines.at(-1)).toBe('\n0 mutation(s) killed, 1 problem(s).');
    expect(outcome.text).toBe(PRISTINE);
  });

  it('counts a real kill, runs each distinct suite once unmutated, and restores the file', async () => {
    const outcome = await check(
      [mutation('first', ['run', 'test:green']), mutation('second', ['run', 'test:green'])],
      (_suite, mutated) => (mutated ? A_TEST_FAILED : ALL_PASSED),
    );
    expect(outcome.result).toEqual({ killed: 2, problems: 0, brokenRuns: 0, interrupted: false });
    expect(outcome.runs).toEqual([
      { suite: 'run test:green', mutated: false },
      { suite: 'run test:green', mutated: true },
      { suite: 'run test:green', mutated: true },
    ]);
    expect(outcome.text).toBe(PRISTINE);
    expect(outcome.lines.at(-1)).toBe('\n2 mutation(s) killed, 0 problem(s).');
  });

  it('reports a survivor and a stale edit as problems', async () => {
    const survivor = await check([mutation('survivor', ['run', 'test:green'])], () => ALL_PASSED);
    expect(survivor.result).toEqual({ killed: 0, problems: 1, brokenRuns: 0, interrupted: false });
    expect(survivor.lines.join('\n')).toContain('MUTATION_SURVIVED survivor');

    const stale = await check([{ ...mutation('stale', ['run', 'test:green']), find: 'not in the file' }], () => ALL_PASSED);
    expect(stale.result).toEqual({ killed: 0, problems: 1, brokenRuns: 0, interrupted: false });
    expect(stale.runs).toEqual([]);
  });
});
