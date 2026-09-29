import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readRepositoryFile } from './support/repository.ts';

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
 *    attested against production's public `/health`, in a step of its own, and the
 *    variable must agree with it.
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
      { schema: 22, migrations: { '0021_a.sql': ONE, '0022_b.sql': TWO } },
      { schema: 23, migrations: { '0021_a.sql': ONE, '0022_b.sql': TWO, '0023_c.sql': THREE } },
    );
    const outcome = guard(repository, { PROD_SCHEMA: '22' });
    expect(outcome.status, outcome.out).toBe(0);
    expect(outcome.outputs).toMatchObject({ run: 'yes', from: '22', to: '23' });
  });

  it('skips when the branch declares the deployed schema and every deployed file is identical', () => {
    const tree = { schema: 22, migrations: { '0021_a.sql': ONE, '0022_b.sql': TWO } };
    const outcome = guard(repositoryOf(tree, { ...tree, migrations: { ...tree.migrations } }), {
      PROD_SCHEMA: '22',
    });
    expect(outcome.status, outcome.out).toBe(0);
    expect(outcome.outputs['run']).toBe('no');
  });

  it('P0-1: refuses a deployed migration renamed to a number above the deployed schema', () => {
    // The whole finding in one case. `REQUIRED_SCHEMA` does not move, so the old guard
    // reached its equal-schema skip; rename detection hid the deletion of 0022_b.sql.
    const repository = repositoryOf(
      { schema: 22, migrations: { '0021_a.sql': ONE, '0022_b.sql': TWO } },
      { schema: 22, migrations: { '0021_a.sql': ONE, '0023_b.sql': TWO } },
    );
    const outcome = guard(repository, { PROD_SCHEMA: '22' });
    expect(outcome.status, outcome.out).not.toBe(0);
    expect(outcome.out).toContain('MIGRATION_CHECKSUM_MISMATCH');
    expect(outcome.out).toContain('0022_b.sql');
    expect(outcome.outputs['run']).toBeUndefined();
  });

  it('P0-1: refuses an edited deployed migration even when the branch adds a new one', () => {
    const repository = repositoryOf(
      { schema: 22, migrations: { '0021_a.sql': ONE, '0022_b.sql': TWO } },
      { schema: 23, migrations: { '0021_a.sql': ONE, '0022_b.sql': `${TWO}-- edited\n`, '0023_c.sql': THREE } },
    );
    const outcome = guard(repository, { PROD_SCHEMA: '22' });
    expect(outcome.status, outcome.out).not.toBe(0);
    expect(outcome.out).toContain('0022_b.sql');
  });

  it('P0-1: refuses a deleted deployed migration', () => {
    const repository = repositoryOf(
      { schema: 22, migrations: { '0021_a.sql': ONE, '0022_b.sql': TWO } },
      { schema: 22, migrations: { '0021_a.sql': ONE } },
    );
    const outcome = guard(repository, { PROD_SCHEMA: '22' });
    expect(outcome.status, outcome.out).not.toBe(0);
    expect(outcome.outputs['run']).toBeUndefined();
  });

  it('P0-2: refuses a deployed commit that is not an ancestor of origin/main', () => {
    const repository = repositoryOf(
      { schema: 22, migrations: { '0022_b.sql': TWO } },
      { schema: 23, migrations: { '0022_b.sql': TWO, '0023_c.sql': THREE } },
    );
    // Move the released line somewhere the deployed commit cannot be reached from.
    git(repository.path, 'checkout', '--quiet', '--orphan', 'elsewhere');
    git(repository.path, 'commit', '--quiet', '--allow-empty', '-m', 'unrelated');
    git(repository.path, 'update-ref', 'refs/remotes/origin/main', git(repository.path, 'rev-parse', 'HEAD'));
    git(repository.path, 'checkout', '--quiet', 'main');
    const outcome = guard(repository, { PROD_SCHEMA: '22' });
    expect(outcome.status, outcome.out).not.toBe(0);
    expect(outcome.out).toContain('origin/main');
  });

  it('P0-2: warns, and still runs, when the deployed commit is behind main at the same schema', () => {
    const repository = repositoryOf(
      { schema: 22, migrations: { '0022_b.sql': TWO } },
      { schema: 23, migrations: { '0022_b.sql': TWO, '0023_c.sql': THREE } },
      [{ schema: 22, migrations: { '0022_b.sql': TWO } }],
    );
    const outcome = guard(repository, { PROD_SCHEMA: '22' });
    expect(outcome.status, outcome.out).toBe(0);
    expect(outcome.out).toContain('FSS_PROD_COMMIT is behind');
    expect(outcome.outputs).toMatchObject({ run: 'yes', from: '22', to: '23' });
  });

  it('refuses a missing or nonsense FSS_PROD_SCHEMA rather than treating it as nothing to do', () => {
    const tree = { schema: 22, migrations: { '0022_b.sql': TWO } };
    const repository = repositoryOf(tree, { ...tree, migrations: { ...tree.migrations } });
    for (const value of ['', 'twenty-two', '0']) {
      const outcome = guard(repository, { PROD_SCHEMA: value });
      expect(outcome.status, `${value}: ${outcome.out}`).not.toBe(0);
      expect(outcome.outputs['run']).toBeUndefined();
    }
  });
});

describe('the attestation step asks production, and only when there is an upgrade to test', () => {
  const body = runBody('What production actually runs, attested from production');

  /**
   * `curl` answers `file://` too, so the step's own shell can be run against a health
   * document on disk. Nothing here touches the network, and the step under test is the
   * text in the workflow rather than a copy of it.
   */
  function attest(health: string | null, environment: Readonly<Record<string, string>>): Outcome {
    const directory = mkdtempSync(join(tmpdir(), 'fss-attest-'));
    temporary.push(directory);
    if (health !== null) writeFileSync(join(directory, 'health'), health, 'utf8');
    const result = spawnSync('bash', ['-c', body], {
      cwd: directory,
      encoding: 'utf8',
      env: { ...process.env, FSS_PRODUCTION_ORIGIN: `file://${directory}`, ...environment },
    });
    return { status: result.status ?? -1, out: `${result.stdout}${result.stderr}`, outputs: {} };
  }

  const SERVING = JSON.stringify({
    status: 'serving',
    schema: { declaredRange: { minimum: 22, maximum: 22 }, databaseVersion: 22, accepted: true },
  });

  it('accepts the shape production answers with today', () => {
    const outcome = attest(SERVING, { PROD_SCHEMA: '22', FROM_SCHEMA: '22' });
    expect(outcome.status, outcome.out).toBe(0);
    expect(outcome.out).toContain('FROM is attested');
  });

  it('refuses a variable that disagrees with what production attests', () => {
    const outcome = attest(SERVING, { PROD_SCHEMA: '21', FROM_SCHEMA: '21' });
    expect(outcome.status, outcome.out).not.toBe(0);
    expect(outcome.out).toContain('the variable is stale');
  });

  it('refuses a deployed commit whose own REQUIRED_SCHEMA is not what production runs', () => {
    const outcome = attest(SERVING, { PROD_SCHEMA: '22', FROM_SCHEMA: '21' });
    expect(outcome.status, outcome.out).not.toBe(0);
    expect(outcome.out).toContain('production is not running');
  });

  it('fails closed when production does not answer', () => {
    const outcome = attest(null, { PROD_SCHEMA: '22', FROM_SCHEMA: '22' });
    expect(outcome.status, outcome.out).not.toBe(0);
    expect(outcome.out).toContain('did not answer in three attempts');
  });

  it('fails closed on a malformed answer rather than guessing', () => {
    for (const malformed of ['not json at all', '{}', '{"schema":{}}', '{"schema":{"databaseVersion":"twenty-two"}}']) {
      const outcome = attest(malformed, { PROD_SCHEMA: '22', FROM_SCHEMA: '22' });
      expect(outcome.status, `${malformed}: ${outcome.out}`).not.toBe(0);
    }
  });

  it('runs only after the guard has decided there is an upgrade, so an unrelated branch never calls production', () => {
    // Otherwise every pull request in the repository turns red whenever
    // api.usecallie.com has a bad minute, which is a worse failure than the one the
    // attestation prevents.
    const workflow = WORKFLOW.split('\n');
    const at = workflow.findIndex(line => line.includes('- name: What production actually runs, attested from production'));
    expect(at).toBeGreaterThan(-1);
    const guardAt = workflow.findIndex(line => line.includes(`- name: ${RANGE_STEP}`));
    expect(at).toBeGreaterThan(guardAt);
    expect(workflow.slice(at, at + 25).join('\n')).toContain("if: steps.range.outputs.run == 'yes'");
  });

  it('carries no credential', () => {
    expect(body).not.toMatch(/Authorization|secrets\./u);
  });
});

describe('the baseline may not move in the same change as a migration', () => {
  const body = runBody('The grants baseline may not move in the same change as a migration');

  it('names both halves of the rule', () => {
    expect(body).toContain('tools/upgrade/grants-baseline.json');
    expect(body).toContain('packages/domain/db/migrations/');
    expect(body).toContain('--no-renames');
  });
});
