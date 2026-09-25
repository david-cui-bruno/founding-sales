import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { readRepositoryFile, repositoryPath } from './support/coverage.ts';

/**
 * Where the release mutation check runs (lane g62, David's decision of 25 September 2026).
 *
 * `npm run test:release:mutation` breaks every trap the release suite names and requires
 * the suite to go red. It ran as a step of the pull-request gate
 * (`.github/workflows/greenfield.yml`) and was most of it: about sixteen minutes of every
 * pull request and every push at 102 mutations (main, run 36089059879, "129 suite run(s)
 * in 940 s"). It now runs once a day on main, and on demand, in
 * `.github/workflows/greenfield-nightly.yml`. The pull-request job keeps typecheck, lint,
 * the workspace tests and the release suite, and the check still runs locally exactly as
 * before.
 *
 * This file holds that shape: absent from the pull-request job and from the gate script
 * it runs, present in the nightly with its schedule, and loud there when it fails.
 *
 * ## The vacuous-pass traps, named
 *
 * Three.
 *
 * "The pull-request workflow does not mention the mutation check" is true of a reader
 * that found nothing, and of a check that came back through `gate:greenfield` in
 * `package.json` rather than through the workflow. Closed by requiring the reader to find
 * the pull-request job's steps (the gate step among them, run as it is today) and by
 * reading the gate script too. A mutation appended to `scripts/releaseMutationCheck.mjs`
 * puts the check back on the pull-request gate step and requires this file to go red.
 *
 * A nightly that runs the check and cannot fail is quieter than no nightly: the check no
 * longer blocks anything, so a red run is only worth what it tells somebody. The step's
 * status must be the check's (no `continue-on-error`, `pipefail` around the `tee`), and
 * the summary step must turn a summary line with problems into a failure. A second
 * mutation makes the check step `continue-on-error` and requires this file to go red.
 *
 * And a summary step whose pattern matches nothing writes "printed no summary line" on
 * every run, which reads as a broken job rather than as the finding. The patterns are
 * the workflow's own, and they are run here against what `releaseMutationRunner.mjs`
 * really logs: the summary pattern must match its last line, and the problem pattern
 * must match exactly as many lines as the runner counts problems, one of each kind.
 */

const PULL_REQUEST_WORKFLOW = '.github/workflows/greenfield.yml';
const NIGHTLY_WORKFLOW = '.github/workflows/greenfield-nightly.yml';

interface Step {
  readonly name: string;
  readonly condition: string | null;
  readonly text: string;
  /** The `run:` script with its indentation removed, or null for a `uses:` step. */
  readonly script: string | null;
}

interface Job {
  readonly text: string;
  readonly steps: readonly Step[];
  /** One key of the job (`services`, `env`, `timeout-minutes`, …), verbatim. */
  key(name: string): string;
}

/** Lines until the first one indented `indent` spaces or less; blank lines belong to the block. */
function blockAfter(lines: readonly string[], start: number, indent: number): string[] {
  const block = [lines[start] ?? ''];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && line.length - line.trimStart().length <= indent) break;
    block.push(line);
  }
  while (block.length > 1 && (block.at(-1) ?? '').trim() === '') block.pop();
  return block;
}

function stepFrom(lines: readonly string[]): Step {
  const text = lines.join('\n');
  const named = /^ {6}- name: (.+)$/mu.exec(text)?.[1];
  const uses = /^ {6}- uses: (\S+)$/mu.exec(text)?.[1];
  const name = named ?? (uses === undefined ? undefined : `uses ${uses}`);
  if (name === undefined) throw new Error(`a workflow step has neither a name nor a uses:\n${text}`);
  const runAt = lines.findIndex(line => /^ {8}run: /u.test(line));
  let script: string | null = null;
  if (runAt >= 0) {
    const inline = (lines[runAt] ?? '').replace(/^ {8}run: /u, '');
    script =
      inline === '|'
        ? blockAfter(lines, runAt, 8)
            .slice(1)
            .map(line => line.slice(10))
            .join('\n')
        : inline;
  }
  return { name: name.trim(), condition: /^ {8}if: (.+)$/mu.exec(text)?.[1] ?? null, text, script };
}

/** One job of a workflow, read without a YAML library (see `support/releaseWorkflow.ts` for why). */
function readJob(path: string, job: string): Job {
  const lines = readRepositoryFile(path).split('\n');
  const at = lines.indexOf(`  ${job}:`);
  if (at < 0) throw new Error(`${path} declares no \`${job}\` job`);
  const jobLines = blockAfter(lines, at, 2);
  const key = (name: string): string => {
    // A key with a block under it (`steps:`) or with its value on the line (`timeout-minutes: 60`).
    const keyAt = jobLines.findIndex(line => line === `    ${name}:` || line.startsWith(`    ${name}: `));
    if (keyAt < 0) throw new Error(`the \`${job}\` job of ${path} declares no \`${name}\``);
    return blockAfter(jobLines, keyAt, 4).join('\n');
  };
  const stepLines = key('steps').split('\n').slice(1);
  const steps: Step[] = [];
  let current: string[] | null = null;
  for (const line of stepLines) {
    if (line.startsWith('      - ')) {
      if (current !== null) steps.push(stepFrom(current));
      current = [line];
    } else if (current !== null) {
      current.push(line);
    }
  }
  if (current !== null) steps.push(stepFrom(current));
  return { text: jobLines.join('\n'), steps, key };
}

/** The workflow's `on:` block. */
function triggers(path: string): string {
  const lines = readRepositoryFile(path).split('\n');
  const at = lines.indexOf('on:');
  if (at < 0) throw new Error(`${path} declares no \`on:\``);
  return blockAfter(lines, at, 0).join('\n');
}

/** Lines that are not YAML comments: a comment may explain the check, only code may run it. */
function uncommented(text: string): string {
  return text
    .split('\n')
    .filter(line => !line.trimStart().startsWith('#'))
    .join('\n');
}

/** A step-level `env:` value, unquoted. */
function stepEnv(step: Step, name: string): string {
  const value = new RegExp(`^ {10}${name}: '(.+)'$`, 'mu').exec(step.text)?.[1];
  if (value === undefined) throw new Error(`step "${step.name}" sets no ${name}`);
  return value;
}

const RUNS_THE_CHECK = /test:release:mutation|releaseMutationCheck/u;

describe('the pull-request gate no longer runs the release mutation check', () => {
  const job = readJob(PULL_REQUEST_WORKFLOW, 'greenfield');

  it('is still the gate for every pull request and every push to main', () => {
    const on = triggers(PULL_REQUEST_WORKFLOW);
    expect(on).toContain('\n  pull_request:');
    expect(on).toContain('\n  push:\n    branches: [main]');
  });

  it('reads the job it is judging: the install and the gate step, run as they are', () => {
    // The floor. A reader that found no steps would find no mutation check in them.
    expect(job.steps.length).toBeGreaterThanOrEqual(6);
    const names = job.steps.map(step => step.name);
    expect(names).toContain('Install');
    const gate = job.steps.find(step => step.name === 'Greenfield gate');
    expect(gate?.script).toBe('npm run gate:greenfield');
  });

  it('runs no step of the mutation check, in the job or anywhere in the workflow', () => {
    for (const step of job.steps) {
      expect(step.script ?? '', `step "${step.name}" runs the mutation check`).not.toMatch(RUNS_THE_CHECK);
    }
    expect(uncommented(readRepositoryFile(PULL_REQUEST_WORKFLOW))).not.toMatch(RUNS_THE_CHECK);
  });

  it('runs a gate script that does not reach the mutation check either, and the check still runs locally', () => {
    const scripts = (JSON.parse(readRepositoryFile('package.json')) as { scripts: Record<string, string> }).scripts;
    expect(scripts['gate:greenfield']).toBe(
      'npm run typecheck:greenfield && npm run lint:greenfield && npm run test:greenfield && npm run test:release',
    );
    for (const part of ['typecheck:greenfield', 'lint:greenfield', 'test:greenfield', 'test:release']) {
      expect(scripts[part] ?? '', part).not.toMatch(RUNS_THE_CHECK);
    }
    // Locally, exactly as before lane g62.
    expect(scripts['test:release:mutation']).toBe('node scripts/releaseMutationCheck.mjs');
  });
});

describe('the release mutation check runs once a day on main, and on demand', () => {
  const job = readJob(NIGHTLY_WORKFLOW, 'mutation');
  const check = job.steps.find(step => step.script !== null && RUNS_THE_CHECK.test(step.script));
  const summary = job.steps.find(step => step.name === 'Mutation check summary');

  it('is scheduled at 09:00 UTC daily and can be dispatched, and runs on nothing else', () => {
    const on = triggers(NIGHTLY_WORKFLOW);
    expect(on).toContain("\n  schedule:\n");
    expect(uncommented(on).match(/- cron: /gu)).toHaveLength(1);
    // minute 0, hour 9, every day of every month, every weekday. Scheduled runs use
    // the default branch's latest commit, which is main.
    expect(on).toContain("\n    - cron: '0 9 * * *'\n");
    expect(on).toContain('\n  workflow_dispatch:');
    // Not a second pull-request gate by the back door.
    expect(on).not.toMatch(/^ {2}(pull_request|pull_request_target|push):/mu);
  });

  it('runs the check itself, as the only thing that decides the step, within an hour', () => {
    expect(check?.script).toBe(
      'set -euo pipefail\nnpm run test:release:mutation 2>&1 | tee "$RUNNER_TEMP/release-mutation-check.log"',
    );
    // A step with its own condition could be skipped; one that may fail quietly is not
    // a check. pipefail is what keeps the tee from answering for it.
    expect(check?.condition).toBeNull();
    expect(uncommented(readRepositoryFile(NIGHTLY_WORKFLOW))).not.toContain('continue-on-error');
    expect(job.key('timeout-minutes')).toBe('    timeout-minutes: 60');
    expect(job.key('runs-on')).toBe('    runs-on: ubuntu-24.04');
  });

  it('writes the summary line to the job summary, whatever happened, and fails on any problem', () => {
    expect(summary?.condition).toBe('always()');
    const script = summary?.script ?? '';
    expect(script).toContain('>> "$GITHUB_STEP_SUMMARY"');
    expect(script).toContain('log="$RUNNER_TEMP/release-mutation-check.log"');
    // A summary with problems, or no summary at all, is a failure and an annotation.
    expect(script).toContain("*' 0 problem(s).') ;;");
    expect(script).toContain('echo "::error title=Nightly release mutation check failed::${summary}"');
    expect(script).toContain('exit 1');
    // And it comes after the check, so it has something to read.
    expect(job.steps.indexOf(summary as Step)).toBeGreaterThan(job.steps.indexOf(check as Step));
  });

  it('runs on the same PostgreSQL, Node and install as the pull-request job, copied rather than restated', () => {
    const pullRequest = readJob(PULL_REQUEST_WORKFLOW, 'greenfield');
    expect(job.key('services')).toBe(pullRequest.key('services'));
    expect(job.key('services')).toContain('image: postgres:16');
    expect(job.key('env')).toBe(pullRequest.key('env'));
    expect(job.key('env')).toContain('FSS_TEST_POSTGRES_URL: postgresql://postgres:greenfield-ci@127.0.0.1:5432/postgres');
    // Checkout, setup-node 24.20.0, the Node assertion, the PostgreSQL 16 assertion and
    // the install: the first five steps of each job, line for line.
    const setup = (steps: readonly Step[]) => steps.slice(0, 5).map(step => step.text);
    expect(setup(job.steps)).toEqual(setup(pullRequest.steps));
    expect(job.steps[4]?.name).toBe('Install');
    expect(job.steps[1]?.text).toContain("node-version: '24.20.0'");
  });

  it('has run scripts bash can parse', () => {
    const scripts = job.steps.flatMap(step => (step.script === null ? [] : [step.script]));
    expect(scripts.length).toBeGreaterThanOrEqual(5);
    for (const script of scripts) {
      const parsed = spawnSync('bash', ['-n'], { input: script.replace(/\$\{\{[^}]+\}\}/gu, 'fixture'), encoding: 'utf8' });
      expect(parsed.status, `${parsed.stderr}\n${script}`).toBe(0);
    }
  });
});

interface JudgedRun {
  verdict: 'green' | 'red' | 'broken';
  reason: string;
  brokenRun?: boolean;
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
  runMutationCheck(options: {
    mutations: Mutation[];
    runSuite: (suite: string[]) => JudgedRun;
    readFile: (file: string) => string;
    writeFile: (file: string, text: string) => void;
    log: (line: string) => void;
    stopRequested?: () => boolean;
  }): Promise<{
    killed: number;
    killedByKind: { behaviour: number; wiring: number };
    problems: number;
    brokenRuns: number;
    interrupted: boolean;
  }>;
}

// A computed specifier, as in mutationRunner.check.ts: plain ESM with no declarations.
const RUNNER_PATH = repositoryPath('scripts/releaseMutationRunner.mjs');
const runner = (await import(RUNNER_PATH)) as Runner;

describe("the nightly's summary step reads what the runner really prints", () => {
  const summary = readJob(NIGHTLY_WORKFLOW, 'mutation').steps.find(step => step.name === 'Mutation check summary');
  if (summary === undefined) throw new Error(`${NIGHTLY_WORKFLOW} has no "Mutation check summary" step`);
  const SUMMARY = new RegExp(stepEnv(summary, 'SUMMARY_PATTERN'), 'u');
  const PROBLEM = new RegExp(stepEnv(summary, 'PROBLEM_PATTERN'), 'u');

  const TARGET = 'src/target.ts';
  const PRISTINE = 'export const guard = true;\n';
  const run = (verdict: JudgedRun['verdict']): JudgedRun => ({ verdict, reason: verdict, output: '', seconds: 0, signal: null });
  const mutation = (name: string, suite: string, find = 'guard = true'): Mutation => ({
    name,
    file: TARGET,
    find,
    replace: 'guard = false',
    suite: ['run', suite],
    because: 'a fixture',
  });

  /** The log file the workflow's tee writes: every logged line, newlines and all. */
  async function logFile(mutations: Mutation[], stopRequested = () => false) {
    let text = PRISTINE;
    const lines: string[] = [];
    const answers: Record<string, [JudgedRun['verdict'], JudgedRun['verdict']]> = {
      'test:kills': ['green', 'red'],
      'test:survives': ['green', 'green'],
      'test:undecided': ['green', 'broken'],
      'test:malformed': ['green', 'broken'],
      'test:red': ['red', 'red'],
    };
    const result = await runner.runMutationCheck({
      mutations,
      runSuite: suite => {
        const [before, after] = answers[suite[1] ?? ''] ?? ['broken', 'broken'];
        const judged = run(text === PRISTINE ? before : after);
        // Lane g80: a mutated file that did not parse is a broken run of its own kind.
        return suite[1] === 'test:malformed' && text !== PRISTINE ? { ...judged, brokenRun: true } : judged;
      },
      readFile: () => text,
      writeFile: (_file, next) => {
        text = next;
      },
      log: line => lines.push(line),
      stopRequested,
    });
    return { result, file: lines.join('\n').split('\n') };
  }

  it('finds the summary line, and only it, in a clean run', async () => {
    const { result, file } = await logFile([mutation('killed', 'test:kills')]);
    expect(result).toEqual({ killed: 1, killedByKind: { behaviour: 1, wiring: 0 }, problems: 0, brokenRuns: 0, interrupted: false });
    expect(file.filter(line => SUMMARY.test(line))).toEqual(['1 mutation(s) killed, 0 problem(s).']);
    expect(file.filter(line => PROBLEM.test(line))).toEqual([]);
  });

  it('finds one problem line for every problem the runner counts, of every kind', async () => {
    const { result, file } = await logFile([
      mutation('killed', 'test:kills'),
      mutation('stale', 'test:kills', 'not in the file'),
      mutation('survivor', 'test:survives'),
      mutation('undecided', 'test:undecided'),
      mutation('malformed', 'test:malformed'),
      mutation('red suite', 'test:red'),
    ]);
    // Stale, survived, undecided, a broken run, and the red suite twice: once for the
    // suite, once for the mutation it could not run.
    expect(result).toEqual({ killed: 1, killedByKind: { behaviour: 1, wiring: 0 }, problems: 6, brokenRuns: 1, interrupted: false });
    const problems = file.filter(line => PROBLEM.test(line));
    expect(problems).toHaveLength(result.problems);
    expect(problems.map(line => line.split(' ')[0]).sort()).toEqual([
      'MUTATION_NOT_RUN',
      'MUTATION_STALE',
      'MUTATION_SURVIVED',
      'MUTATION_UNDECIDED',
      'MUTATION_UNDECIDED',
      'SUITE_RED_BEFORE_MUTATION',
    ]);
    expect(file.filter(line => SUMMARY.test(line))).toEqual(['1 mutation(s) killed, 6 problem(s).']);
  });

  it('finds the interruption too', async () => {
    const { result, file } = await logFile([mutation('killed', 'test:kills')], () => true);
    expect(result).toMatchObject({ interrupted: true, problems: 1 });
    expect(file.filter(line => PROBLEM.test(line)).map(line => line.split(' ')[0])).toEqual(['INTERRUPTED']);
  });
});
