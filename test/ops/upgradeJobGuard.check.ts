import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readRepositoryFile, repositoryPath } from './support/repository.ts';

/**
 * The upgrade job's guard — the step that decides what production runs, whether this
 * branch would move it, and whether there is anything to test at all.
 *
 * It is the only thing between a schema release and no upgrade evidence, so its two
 * dangerous answers are `run=no` (said when there *is* an upgrade) and a `from` that is
 * not the schema production is on. GPT-6's second review of PR 314 found both:
 *
 *  * **P0-1.** `git diff --name-only` follows renames and prints the post-image name.
 *    Renaming `0022_a.sql` to `0023_b.sql` while leaving `REQUIRED_SCHEMA` at 22 printed
 *    one path, `0023_b.sql`, whose number is above the deployed schema; nothing was left
 *    to filter, the schemas matched, and the job said `run=no`. Production's runner
 *    holds a sha256 for the applied `0022_a.sql` and would refuse the release. The guard
 *    now compares the deployed files 1..N as a manifest of name and blob id, before any
 *    equal-schema skip, so a rename shows up as a deletion and an addition.
 *  * **P0-2.** The deployed schema came from a repository variable and nothing else, so
 *    a stale variable produced evidence for an upgrade nobody would perform. It is now
 *    resolved from production's public `/health` in a step of its own
 *    (`tools/ci/resolve-prod-base.sh`, run by `resolveProdBase.check.ts`); the variables
 *    are only the fallback. This file runs the step after it, which takes that answer.
 *
 * These cases run the step's own shell — extracted from the workflow, not copied — in
 * throwaway git repositories, so they fail if the workflow's text drifts from them.
 */

const WORKFLOW = readRepositoryFile('.github/workflows/greenfield.yml');
const RANGE_STEP = 'What production runs, and what this branch would move it to';

/** The `run:` block of a named step, dedented to column zero. */
function runBody(name: string): string {
  const lines = WORKFLOW.split('\n');
  const start = lines.findIndex(line => line.trim() === `- name: ${name}`);
  expect(start, `the workflow has no step named "${name}"`).toBeGreaterThan(-1);
  const runAt = lines.findIndex((line, index) => index > start && line.trim() === 'run: |');
  expect(runAt, `the step "${name}" has no run: | block`).toBeGreaterThan(start);
  const indent = ' '.repeat((lines[runAt]?.length ?? 0) - (lines[runAt]?.trimStart().length ?? 0) + 2);
  const body: string[] = [];
  for (const line of lines.slice(runAt + 1)) {
    if (line.trim() !== '' && !line.startsWith(indent)) break;
    body.push(line.slice(indent.length));
  }
  return body.join('\n');
}

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function git(repository: string, ...args: readonly string[]): string {
  const result = spawnSync('git', args, { cwd: repository, encoding: 'utf8' });
  expect(result.status, `git ${args.join(' ')}: ${result.stderr}`).toBe(0);
  return result.stdout.trim();
}

function rangeFile(version: number): string {
  return `export const REQUIRED_SCHEMA = ${String(version)};\n`;
}

interface Tree {
  /** `REQUIRED_SCHEMA` this commit declares. */
  readonly schema: number;
  /** Migration file name → contents. The whole directory, replaced each commit. */
  readonly migrations: Readonly<Record<string, string>>;
}

/**
 * A repository with a deployed commit on `main` and a branch commit on top, each with
 * its own `schemaRange.ts` and its own migrations directory.
 */
function repositoryOf(deployed: Tree, branch: Tree, between: readonly Tree[] = []): { path: string; deployed: string } {
  const path = mkdtempSync(join(tmpdir(), 'fss-upgrade-guard-'));
  temporary.push(path);
  git(path, 'init', '--quiet', '--initial-branch=main');
  git(path, 'config', 'user.email', 'guard@example.invalid');
  git(path, 'config', 'user.name', 'guard');
  mkdirSync(join(path, 'packages', 'domain', 'db', 'migrations'), { recursive: true });
  mkdirSync(join(path, 'tools', 'upgrade'), { recursive: true });
  // The guard runs the tool's own deployed-range comparison rather than a git-level
  // one, so the fixture repository needs the four files that comparison is made of.
  // They import nothing else — that is the property that lets the guard run before
  // `npm ci`, and copying them here is how this test proves it.
  for (const file of [
    'tools/upgrade/deployedMigrations.ts',
    'tools/upgrade/deployedMigrationsMain.ts',
    'packages/domain/db/migrationRunner.ts',
    'packages/domain/db/queryable.ts',
  ]) {
    cpSync(repositoryPath(file), join(path, file));
  }

  const commit = (tree: Tree, message: string): string => {
    writeFileSync(join(path, 'packages', 'domain', 'db', 'schemaRange.ts'), rangeFile(tree.schema), 'utf8');
    rmSync(join(path, 'packages', 'domain', 'db', 'migrations'), { recursive: true, force: true });
    mkdirSync(join(path, 'packages', 'domain', 'db', 'migrations'), { recursive: true });
    for (const [name, sql] of Object.entries(tree.migrations)) {
      writeFileSync(join(path, 'packages', 'domain', 'db', 'migrations', name), sql, 'utf8');
    }
    git(path, 'add', '-A');
    git(path, 'commit', '--quiet', '--allow-empty', '-m', message);
    return git(path, 'rev-parse', 'HEAD');
  };

  const deployedSha = commit(deployed, 'deployed');
  for (const [index, tree] of between.entries()) commit(tree, `main ${String(index)}`);
  // The released line. The guard cross-checks the deployed commit against it, so it has
  // to exist as a remote-tracking ref exactly as `actions/checkout` would leave it.
  git(path, 'update-ref', 'refs/remotes/origin/main', git(path, 'rev-parse', 'HEAD'));
  commit(branch, 'branch');
  return { path, deployed: deployedSha };
}

interface Outcome {
  readonly status: number;
  readonly out: string;
  readonly outputs: Readonly<Record<string, string>>;
}

function guard(
  repository: { path: string; deployed: string },
  environment: Readonly<Record<string, string>>,
): Outcome {
  const outputFile = join(repository.path, 'github-output');
  writeFileSync(outputFile, '', 'utf8');
  const result = spawnSync('bash', ['-c', runBody(RANGE_STEP)], {
    cwd: repository.path,
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_OUTPUT: outputFile,
      RUNNER_TEMP: mkdtempSync(join(tmpdir(), 'fss-runner-temp-')),
      PROD_COMMIT: repository.deployed,
      ...environment,
    },
  });
  const outputs: Record<string, string> = {};
  for (const line of readFileSync(outputFile, 'utf8').split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) outputs[line.slice(0, at)] = line.slice(at + 1);
  }
  return { status: result.status ?? -1, out: `${result.stdout}${result.stderr}`, outputs };
}

const ONE = '-- changes: firms\nCREATE TABLE firms (id uuid primary key);\n';
const TWO = '-- changes: firms\nALTER TABLE firms ADD COLUMN name text;\n';
const THREE = '-- changes: leads\nCREATE TABLE leads (id uuid primary key);\n';

describe('the upgrade job decides what to run from what production runs, not from git history', () => {
  it('runs the upgrade when the branch declares a higher schema', () => {
    const repository = repositoryOf(
      { schema: 2, migrations: { '0001_a.sql': ONE, '0002_b.sql': TWO } },
      { schema: 3, migrations: { '0001_a.sql': ONE, '0002_b.sql': TWO, '0003_c.sql': THREE } },
    );
    const outcome = guard(repository, { PROD_SCHEMA: '2' });
    expect(outcome.status, outcome.out).toBe(0);
    expect(outcome.outputs).toMatchObject({ run: 'yes', from: '2', to: '3' });
  });

  it('skips when the branch declares the deployed schema and every deployed file is identical', () => {
    const tree = { schema: 2, migrations: { '0001_a.sql': ONE, '0002_b.sql': TWO } };
    const outcome = guard(repositoryOf(tree, { ...tree, migrations: { ...tree.migrations } }), {
      PROD_SCHEMA: '2',
    });
    expect(outcome.status, outcome.out).toBe(0);
    expect(outcome.outputs['run']).toBe('no');
  });

  it('P0-1: refuses a deployed migration renamed to a number above the deployed schema', () => {
    // The whole finding in one case. `REQUIRED_SCHEMA` does not move, so the old guard
    // reached its equal-schema skip; rename detection hid the deletion of the deployed
    // file. What refuses it is the runner's own loader, which is the point of calling
    // the tool's comparison rather than reimplementing one: the deployed file is gone
    // and the sequence has a hole, and production would refuse the same directory.
    const repository = repositoryOf(
      { schema: 2, migrations: { '0001_a.sql': ONE, '0002_b.sql': TWO } },
      { schema: 2, migrations: { '0001_a.sql': ONE, '0003_b.sql': TWO } },
    );
    const outcome = guard(repository, { PROD_SCHEMA: '2' });
    expect(outcome.status, outcome.out).not.toBe(0);
    expect(outcome.out).toContain('this branch');
    expect(outcome.out).toContain('expected migration 2, found 3');
    expect(outcome.outputs['run']).toBeUndefined();
  });

  it('P0-1: refuses a deployed migration renamed within its own number', () => {
    // The same escape without the sequence hole, so the checksum rule is what catches
    // it: production recorded `0002_b.sql` and this branch offers `0002_c.sql`.
    const repository = repositoryOf(
      { schema: 2, migrations: { '0001_a.sql': ONE, '0002_b.sql': TWO } },
      { schema: 2, migrations: { '0001_a.sql': ONE, '0002_c.sql': TWO } },
    );
    const outcome = guard(repository, { PROD_SCHEMA: '2' });
    expect(outcome.status, outcome.out).not.toBe(0);
    expect(outcome.out).toContain('MIGRATION_CHECKSUM_MISMATCH');
    expect(outcome.out).toContain('0002_b.sql');
    expect(outcome.out).toContain('0002_c.sql');
    expect(outcome.outputs['run']).toBeUndefined();
  });

  it('P0-1: refuses an edited deployed migration even when the branch adds a new one', () => {
    const repository = repositoryOf(
      { schema: 2, migrations: { '0001_a.sql': ONE, '0002_b.sql': TWO } },
      { schema: 3, migrations: { '0001_a.sql': ONE, '0002_b.sql': `${TWO}-- edited\n`, '0003_c.sql': THREE } },
    );
    const outcome = guard(repository, { PROD_SCHEMA: '2' });
    expect(outcome.status, outcome.out).not.toBe(0);
    expect(outcome.out).toContain('0002_b.sql');
  });

  it('P0-1: refuses a deleted deployed migration', () => {
    const repository = repositoryOf(
      { schema: 2, migrations: { '0001_a.sql': ONE, '0002_b.sql': TWO } },
      { schema: 2, migrations: { '0001_a.sql': ONE } },
    );
    const outcome = guard(repository, { PROD_SCHEMA: '2' });
    expect(outcome.status, outcome.out).not.toBe(0);
    expect(outcome.outputs['run']).toBeUndefined();
  });

  it('P0-1: refuses a .sql name the migration runner would not load', () => {
    // The shell parser this replaced split a name at whitespace, so an invalid name
    // could be read as a number the filter passed over. `loadMigrations` is the
    // runner's own loader, so the answer here is production's answer.
    const repository = repositoryOf(
      { schema: 2, migrations: { '0001_a.sql': ONE, '0002_b.sql': TWO } },
      { schema: 2, migrations: { '0001_a.sql': ONE, '0002_b.sql': TWO, '0002 b copy.sql': TWO } },
    );
    const outcome = guard(repository, { PROD_SCHEMA: '2' });
    expect(outcome.status, outcome.out).not.toBe(0);
    expect(outcome.out).toContain('NNNN_snake_case.sql');
  });

  it('P0-2: refuses a deployed commit that is not an ancestor of origin/main', () => {
    const repository = repositoryOf(
      { schema: 2, migrations: { '0001_a.sql': ONE, '0002_b.sql': TWO } },
      { schema: 3, migrations: { '0001_a.sql': ONE, '0002_b.sql': TWO, '0003_c.sql': THREE } },
    );
    // Move the released line somewhere the deployed commit cannot be reached from.
    git(repository.path, 'checkout', '--quiet', '--orphan', 'elsewhere');
    git(repository.path, 'commit', '--quiet', '--allow-empty', '-m', 'unrelated');
    git(repository.path, 'update-ref', 'refs/remotes/origin/main', git(repository.path, 'rev-parse', 'HEAD'));
    git(repository.path, 'checkout', '--quiet', 'main');
    const outcome = guard(repository, { PROD_SCHEMA: '2' });
    expect(outcome.status, outcome.out).not.toBe(0);
    expect(outcome.out).toContain('origin/main');
  });

  it('refuses a missing or nonsense attested schema rather than treating it as nothing to do', () => {
    const tree = { schema: 2, migrations: { '0001_a.sql': ONE, '0002_b.sql': TWO } };
    const repository = repositoryOf(tree, { ...tree, migrations: { ...tree.migrations } });
    for (const value of ['', 'two', '0', '1']) {
      const outcome = guard(repository, { PROD_SCHEMA: value });
      expect(outcome.status, `${value}: ${outcome.out}`).not.toBe(0);
      expect(outcome.outputs['run']).toBeUndefined();
    }
  });
});

/**
 * R0: the decision "does this pull request change the schema?" is made from the
 * repository alone, so an ordinary pull request never contacts production, never reads a
 * variable, and cannot go red on a deploy race. The two steps after it run only when it
 * says yes. These cases run the extracted steps in order, as the job does, with a stub
 * `curl` that records every invocation.
 */
const CHANGE_STEP = 'Does this branch change the schema or a migration?';
const PROD_STEP = 'Resolve what production runs, from production';
const GUARDED = "steps.change.outputs.changed == 'yes'";

/** The `if:` of a named step, or '' when it has none. */
function stepIf(name: string): string {
  const lines = WORKFLOW.split('\n');
  const start = lines.findIndex(line => line.trim() === `- name: ${name}`);
  expect(start, `the workflow has no step named "${name}"`).toBeGreaterThan(-1);
  const end = lines.findIndex((line, index) => index > start && /^ {6}- /u.test(line));
  const own = lines.slice(start, end === -1 ? undefined : end).find(line => /^ {8}if: /u.test(line));
  return own === undefined ? '' : own.replace(/^ {8}if: /u, '').trim();
}

function parseOutputs(file: string): Record<string, string> {
  const outputs: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) outputs[line.slice(0, at)] = line.slice(at + 1);
  }
  return outputs;
}

const COMMIT_40 = 'c'.repeat(40);

interface Health {
  readonly code?: number;
  readonly body?: string;
  readonly rc?: number;
}

/** What the job does for one pull request, with `health` as production's answer. */
function simulate(
  repository: { path: string; deployed: string },
  health: Health,
  extra: Readonly<Record<string, string>> = {},
): { failedAt: string | null; out: string; curlCalls: number; outputs: Readonly<Record<string, string>> } {
  const bin = mkdtempSync(join(tmpdir(), 'fss-sim-bin-'));
  temporary.push(bin);
  const log = join(bin, 'curl-calls');
  const body = health.body ?? JSON.stringify({ status: 'serving', build: { commit: repository.deployed }, schema: { databaseVersion: 2, accepted: true } });
  writeFileSync(join(bin, 'body'), body, 'utf8');
  writeFileSync(
    join(bin, 'curl'),
    `#!/bin/sh\necho call >> ${JSON.stringify(log)}\nwhile [ "$#" -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done\ncat ${JSON.stringify(join(bin, 'body'))} > "$out"\nprintf ${String(health.code ?? 200)}\nexit ${String(health.rc ?? 0)}\n`,
    { encoding: 'utf8', mode: 0o755 },
  );
  writeFileSync(join(bin, 'sleep'), '#!/bin/sh\n', { encoding: 'utf8', mode: 0o755 });
  const outputFile = join(repository.path, 'sim-output');
  writeFileSync(outputFile, '', 'utf8');
  const environment = {
    ...process.env,
    PATH: `${bin}:${process.env['PATH'] ?? ''}`,
    GITHUB_OUTPUT: outputFile,
    RUNNER_TEMP: mkdtempSync(join(tmpdir(), 'fss-runner-temp-')),
    FSS_PRODUCTION_ORIGIN: 'http://127.0.0.1:9',
    ...extra,
  };
  let out = '';
  const run = (script: string, more: Record<string, string> = {}): number => {
    const result = spawnSync('bash', ['-c', script], { cwd: repository.path, encoding: 'utf8', env: { ...environment, ...more } });
    out += `${result.stdout}${result.stderr}`;
    return result.status ?? -1;
  };
  const calls = (): number => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(line => line !== '').length : 0);
  const finish = (failedAt: string | null): ReturnType<typeof simulate> => ({ failedAt, out, curlCalls: calls(), outputs: parseOutputs(outputFile) });

  if (run(runBody(CHANGE_STEP)) !== 0) return finish('change');
  const changed = parseOutputs(outputFile)['changed'] === 'yes';
  // The later steps run exactly when their `if:` says so, and the `if:` is held below.
  expect(stepIf(PROD_STEP)).toBe(GUARDED);
  expect(stepIf(RANGE_STEP)).toBe(GUARDED);
  if (!changed) return finish(null);
  const script = repositoryPath('tools/ci/resolve-prod-base.sh');
  if (run(`bash ${JSON.stringify(script)}`) !== 0) return finish('prod');
  const resolved = parseOutputs(outputFile);
  if (run(runBody(RANGE_STEP), { PROD_SCHEMA: resolved['schema'] ?? '', PROD_COMMIT: resolved['commit'] ?? '' }) !== 0) return finish('range');
  return finish(null);
}

describe('an ordinary pull request never contacts production', () => {
  const tree = { schema: 2, migrations: { '0001_a.sql': ONE, '0002_b.sql': TWO } };

  it('makes no curl call and reads no variable when nothing about the schema changed, whatever production would say', () => {
    const repository = repositoryOf(tree, { ...tree, migrations: { ...tree.migrations } });
    for (const health of [{}, { code: 503 }, { rc: 7 }, { body: 'garbage' }, { body: JSON.stringify({ status: 'degraded' }) }]) {
      for (const variables of [{}, { FSS_PROD_COMMIT: 'b'.repeat(40), FSS_PROD_SCHEMA: '1' }, { VAR_PROD_COMMIT: '', VAR_PROD_SCHEMA: '' }]) {
        const run = simulate(repository, health, variables);
        expect(run.failedAt, run.out).toBeNull();
        expect(run.curlCalls).toBe(0);
        expect(run.outputs['changed']).toBe('no');
        expect(run.outputs['run']).toBeUndefined();
      }
    }
  });

  it('does not care that production deployed a commit this checkout has never seen', () => {
    const repository = repositoryOf(tree, { ...tree, migrations: { ...tree.migrations } });
    const run = simulate(repository, { body: JSON.stringify({ status: 'serving', build: { commit: COMMIT_40 }, schema: { databaseVersion: 2, accepted: true } }) });
    expect(run.failedAt, run.out).toBeNull();
    expect(run.curlCalls).toBe(0);
  });

  it('a code-only change, a docs change and a migration-free refactor are all "no"', () => {
    const repository = repositoryOf(tree, { ...tree, migrations: { ...tree.migrations } });
    writeFileSync(join(repository.path, 'app.ts'), 'export const a = 1;\n', 'utf8');
    git(repository.path, 'add', '-A');
    git(repository.path, 'commit', '--quiet', '-m', 'code');
    const run = simulate(repository, {});
    expect(run.outputs['changed']).toBe('no');
    expect(run.curlCalls).toBe(0);
  });
});

describe('a pull request that changes the schema or a migration needs production attested', () => {
  const before = { schema: 2, migrations: { '0001_a.sql': ONE, '0002_b.sql': TWO } };
  const after = { schema: 3, migrations: { '0001_a.sql': ONE, '0002_b.sql': TWO, '0003_c.sql': THREE } };
  const attested = (repository: { deployed: string }, version: number): Health => ({
    body: JSON.stringify({ status: 'serving', build: { commit: repository.deployed }, schema: { databaseVersion: version, accepted: true } }),
  });

  it('runs the upgrade with FROM = the attested schema when production answers', () => {
    const repository = repositoryOf(before, after);
    const run = simulate(repository, attested(repository, 2));
    expect(run.failedAt, run.out).toBeNull();
    expect(run.curlCalls).toBe(1);
    expect(run.outputs).toMatchObject({ changed: 'yes', run: 'yes', from: '2', to: '3', base_commit: repository.deployed });
  });

  it('fails, with no variable fallback, on every unusable /health', () => {
    const repository = repositoryOf(before, after);
    const unusable: readonly Health[] = [
      { code: 503 },
      { code: 302 },
      { rc: 28 },
      { body: 'garbage' },
      { body: JSON.stringify({ status: 'degraded', build: { commit: repository.deployed }, schema: { databaseVersion: 2, accepted: true } }) },
      { body: JSON.stringify({ status: 'serving', build: { commit: repository.deployed }, schema: { databaseVersion: 2, accepted: false } }) },
      { body: JSON.stringify({ status: 'serving', schema: { databaseVersion: 2, accepted: true } }) },
    ];
    for (const health of unusable) {
      // Variables that agree with the branch, which the old fallback would have accepted.
      const run = simulate(repository, health, { FSS_PROD_COMMIT: repository.deployed, FSS_PROD_SCHEMA: '3', VAR_PROD_COMMIT: repository.deployed, VAR_PROD_SCHEMA: '3' });
      expect(run.failedAt, `${JSON.stringify(health)}: ${run.out}`).toBe('prod');
      expect(run.outputs['run']).toBeUndefined();
    }
  });

  it('the restore scenario: HEAD 31, live database 30, degraded health, variables saying 31, is not "no upgrade"', () => {
    const repository = repositoryOf(
      { schema: 30, migrations: { '0001_a.sql': ONE } },
      { schema: 31, migrations: { '0001_a.sql': ONE, '0002_b.sql': TWO } },
    );
    const run = simulate(
      repository,
      { body: JSON.stringify({ status: 'degraded', schema: { databaseVersion: 30, accepted: true } }) },
      { FSS_PROD_COMMIT: repository.deployed, FSS_PROD_SCHEMA: '31', VAR_PROD_COMMIT: repository.deployed, VAR_PROD_SCHEMA: '31' },
    );
    expect(run.failedAt, run.out).toBe('prod');
    expect(run.outputs['run']).not.toBe('no');
    expect(run.outputs['run']).toBeUndefined();
  });

  it('refuses an attested schema that is not the schema the attested commit declares', () => {
    const repository = repositoryOf(before, after);
    const run = simulate(repository, attested(repository, 1));
    expect(run.failedAt, run.out).toBe('range');
    expect(run.out).toContain('/health says the database is on 1');
  });

  it('a changed migration at an unchanged schema still goes to production and is compared by bytes', () => {
    const repository = repositoryOf(before, { schema: 2, migrations: { '0001_a.sql': ONE, '0002_b.sql': `${TWO}-- edited\n` } });
    const run = simulate(repository, attested(repository, 2));
    expect(run.outputs['changed']).toBe('yes');
    expect(run.curlCalls).toBe(1);
    expect(run.failedAt).toBe('range');
    expect(run.out).toContain('differ from the deployed bytes');
  });

  it('fetches an attested commit that this checkout does not have, then checks it (here: it is not an ancestor)', () => {
    const repository = repositoryOf(before, after);
    // A bare "origin" holding a commit the checkout has never seen, as a deploy that
    // landed after the checkout would leave it.
    const remote = mkdtempSync(join(tmpdir(), 'fss-remote-'));
    temporary.push(remote);
    git(remote, 'init', '--quiet', '--bare');
    git(remote, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
    const side = mkdtempSync(join(tmpdir(), 'fss-side-'));
    temporary.push(side);
    git(side, 'clone', '--quiet', repository.path, '.');
    git(side, 'config', 'user.email', 'guard@example.invalid');
    git(side, 'config', 'user.name', 'guard');
    writeFileSync(join(side, 'later.ts'), 'export const later = 1;\n', 'utf8');
    git(side, 'add', '-A');
    git(side, 'commit', '--quiet', '-m', 'a code-only deploy after the checkout');
    const absent = git(side, 'rev-parse', 'HEAD');
    git(side, 'push', '--quiet', remote, 'HEAD:refs/heads/main');
    git(repository.path, 'remote', 'add', 'origin', remote);
    expect(spawnSync('git', ['cat-file', '-e', `${absent}^{commit}`], { cwd: repository.path }).status).not.toBe(0);
    const run = simulate(repository, { body: JSON.stringify({ status: 'serving', build: { commit: absent }, schema: { databaseVersion: 2, accepted: true } }) });
    expect(spawnSync('git', ['cat-file', '-e', `${absent}^{commit}`], { cwd: repository.path }).status, 'it was fetched').toBe(0);
    expect(run.failedAt, run.out).toBe('range');
    expect(run.out).toContain('is not an ancestor of this branch');
    expect(run.out).not.toContain('could not be fetched');
  });

  it('says so when the attested commit is absent and cannot be fetched', () => {
    const repository = repositoryOf(before, after);
    const run = simulate(repository, { body: JSON.stringify({ status: 'serving', build: { commit: COMMIT_40 }, schema: { databaseVersion: 2, accepted: true } }) });
    expect(run.failedAt, run.out).toBe('range');
    expect(run.out).toContain('could not be fetched');
  });
});

describe('what counts as a change to the schema or a migration', () => {
  const tree = { schema: 2, migrations: { '0001_a.sql': ONE, '0002_b.sql': TWO } };
  const changed = (repository: { path: string; deployed: string }): string | undefined => simulate(repository, {}).outputs['changed'];

  it('a REQUIRED_SCHEMA bump, a new migration, an edited one, a renamed one, a deleted one and .gitattributes are changes', () => {
    expect(changed(repositoryOf(tree, { ...tree, schema: 3 }))).toBe('yes');
    expect(changed(repositoryOf(tree, { ...tree, migrations: { ...tree.migrations, '0003_c.sql': THREE } }))).toBe('yes');
    expect(changed(repositoryOf(tree, { ...tree, migrations: { ...tree.migrations, '0002_b.sql': `${TWO}-- x\n` } }))).toBe('yes');
    expect(changed(repositoryOf(tree, { ...tree, migrations: { '0001_a.sql': ONE, '0002_renamed.sql': TWO } }))).toBe('yes');
    expect(changed(repositoryOf(tree, { ...tree, migrations: { '0001_a.sql': ONE } }))).toBe('yes');
    const repository = repositoryOf(tree, { ...tree, migrations: { ...tree.migrations } });
    writeFileSync(join(repository.path, '.gitattributes'), '*.sql text eol=crlf\n', 'utf8');
    git(repository.path, 'add', '-A');
    git(repository.path, 'commit', '--quiet', '-m', 'attributes');
    expect(changed(repository)).toBe('yes');
  });

  it('nothing else is', () => {
    expect(changed(repositoryOf(tree, { ...tree, migrations: { ...tree.migrations } }))).toBe('no');
  });

  it('is read against the merge-base, so a change that landed on main after the fork is not this branch\'s', () => {
    const repository = repositoryOf(tree, { ...tree, migrations: { ...tree.migrations } });
    // origin/main moves on by a commit that bumps the schema; the branch is untouched.
    const parent = git(repository.path, 'rev-parse', 'origin/main');
    const moved = git(repository.path, 'rev-parse', 'HEAD^{tree}');
    expect(moved).not.toBe('');
    const sibling = mkdtempSync(join(tmpdir(), 'fss-moved-'));
    temporary.push(sibling);
    git(sibling, 'clone', '--quiet', repository.path, '.');
    git(sibling, 'config', 'user.email', 'guard@example.invalid');
    git(sibling, 'config', 'user.name', 'guard');
    git(sibling, 'checkout', '--quiet', parent);
    writeFileSync(join(sibling, 'packages', 'domain', 'db', 'schemaRange.ts'), rangeFile(9), 'utf8');
    git(sibling, 'commit', '--quiet', '-am', 'main moves on');
    git(repository.path, 'fetch', '--quiet', sibling, 'HEAD');
    git(repository.path, 'update-ref', 'refs/remotes/origin/main', git(repository.path, 'rev-parse', 'FETCH_HEAD'));
    expect(changed(repository)).toBe('no');
  });
});

describe('the baseline may not move in the same change as a migration', () => {
  const body = runBody('The grants baseline may not move in the same pull request as a migration');

  it('names both halves of the rule', () => {
    expect(body).toContain('tools/upgrade/grants-baseline.json');
    expect(body).toContain('packages/domain/db/migrations/');
    expect(body).toContain('--no-renames');
  });
});
