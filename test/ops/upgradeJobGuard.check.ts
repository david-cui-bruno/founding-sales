import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  it('P0-2: warns, and still runs, when the deployed commit is behind main at the same schema', () => {
    const repository = repositoryOf(
      { schema: 2, migrations: { '0001_a.sql': ONE, '0002_b.sql': TWO } },
      { schema: 3, migrations: { '0001_a.sql': ONE, '0002_b.sql': TWO, '0003_c.sql': THREE } },
      [{ schema: 2, migrations: { '0001_a.sql': ONE, '0002_b.sql': TWO } }],
    );
    const outcome = guard(repository, { PROD_SCHEMA: '2' });
    expect(outcome.status, outcome.out).toBe(0);
    expect(outcome.out).toContain('FSS_PROD_COMMIT is behind');
    expect(outcome.outputs).toMatchObject({ run: 'yes', from: '2', to: '3' });
  });

  it('refuses a missing or nonsense FSS_PROD_SCHEMA rather than treating it as nothing to do', () => {
    const tree = { schema: 2, migrations: { '0001_a.sql': ONE, '0002_b.sql': TWO } };
    const repository = repositoryOf(tree, { ...tree, migrations: { ...tree.migrations } });
    for (const value of ['', 'two', '0']) {
      const outcome = guard(repository, { PROD_SCHEMA: value });
      expect(outcome.status, `${value}: ${outcome.out}`).not.toBe(0);
      expect(outcome.outputs['run']).toBeUndefined();
    }
  });
});

describe('the attestation step asks production, and only when there is an upgrade to test', () => {
  const body = runBody('What production actually runs, attested from production');

  /**
   * A one-request HTTP server on loopback, so the step's own shell is run against a
   * real status line. `file://` was not good enough once the step began requiring a
   * 200: curl reports `000` for a file, and a harness that cannot produce the code
   * under test proves nothing about it.
   */
  async function attest(
    answer: { status: number; body: string; location?: string } | null,
    environment: Readonly<Record<string, string>>,
  ): Promise<Outcome> {
    const directory = mkdtempSync(join(tmpdir(), 'fss-attest-'));
    temporary.push(directory);
    const server =
      answer === null
        ? null
        : createServer((request, response) => {
            const headers: Record<string, string> = { 'content-type': 'application/json' };
            if (answer.location !== undefined) headers['location'] = answer.location;
            response.writeHead(answer.status, headers);
            response.end(answer.body);
          });
    const origin = await new Promise<string>(resolve => {
      if (server === null) {
        // Nothing listening: a port the test never binds.
        resolve('http://127.0.0.1:9');
        return;
      }
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        resolve(`http://127.0.0.1:${String(typeof address === 'object' && address !== null ? address.port : 0)}`);
      });
    });
    try {
      // `spawn`, not `spawnSync`: the server above is in this process, and a
      // synchronous child blocks the event loop that would have answered it.
      return await new Promise<Outcome>(resolve => {
        const child = spawn('bash', ['-c', body], {
          cwd: directory,
          env: { ...process.env, FSS_PRODUCTION_ORIGIN: origin, RUNNER_TEMP: directory, PROD_COMMIT: COMMIT, ...environment },
        });
        let out = '';
        child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
        child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
        child.on('close', code => resolve({ status: code ?? -1, out, outputs: {} }));
      });
    } finally {
      server?.close();
    }
  }

  const COMMIT = 'a'.repeat(40);
  const serving = (extra: Record<string, unknown> = {}): { status: number; body: string } => ({
    status: 200,
    body: JSON.stringify({
      status: 'serving',
      schema: { declaredRange: { minimum: 22, maximum: 22 }, databaseVersion: 22, accepted: true },
      ...extra,
    }),
  });

  it('accepts the shape production answers with today, which carries no build commit yet', async () => {
    const outcome = await attest(serving(), { PROD_SCHEMA: '22', FROM_SCHEMA: '22' });
    expect(outcome.status, outcome.out).toBe(0);
    expect(outcome.out).toContain('FROM is attested');
    // The transition: until an image built after this change is deployed, the commit
    // is taken on trust and the job says so out loud.
    expect(outcome.out).toContain('The build commit is not attested yet');
  });

  it('attests the commit once production reports one, and refuses a variable that disagrees with it', async () => {
    const agreeing = await attest(serving({ build: { commit: COMMIT } }), { PROD_SCHEMA: '22', FROM_SCHEMA: '22' });
    expect(agreeing.status, agreeing.out).toBe(0);
    expect(agreeing.out).not.toContain('not attested yet');

    const disagreeing = await attest(serving({ build: { commit: 'b'.repeat(40) } }), {
      PROD_SCHEMA: '22',
      FROM_SCHEMA: '22',
    });
    expect(disagreeing.status, disagreeing.out).not.toBe(0);
    expect(disagreeing.out).toContain('the fixture would be written by the wrong application code');
  });

  it('treats a null build commit as the transition, not as an attestation', async () => {
    const outcome = await attest(serving({ build: { commit: null } }), { PROD_SCHEMA: '22', FROM_SCHEMA: '22' });
    expect(outcome.status, outcome.out).toBe(0);
    expect(outcome.out).toContain('The build commit is not attested yet');
  });

  it('refuses a variable that disagrees with the schema production attests', async () => {
    const outcome = await attest(serving(), { PROD_SCHEMA: '21', FROM_SCHEMA: '21' });
    expect(outcome.status, outcome.out).not.toBe(0);
    expect(outcome.out).toContain('the variable is stale');
  });

  it('refuses a deployed commit whose own REQUIRED_SCHEMA is not what production runs', async () => {
    const outcome = await attest(serving(), { PROD_SCHEMA: '22', FROM_SCHEMA: '21' });
    expect(outcome.status, outcome.out).not.toBe(0);
    expect(outcome.out).toContain('production is not running');
  });

  it('refuses anything that is not a 200, a redirect with the right body included', async () => {
    const redirect = await attest(
      { status: 302, body: serving().body, location: 'https://elsewhere.example/health' },
      { PROD_SCHEMA: '22', FROM_SCHEMA: '22' },
    );
    expect(redirect.status, redirect.out).not.toBe(0);
    expect(redirect.out).toContain('did not answer 200');

    const serverError = await attest({ status: 503, body: serving().body }, { PROD_SCHEMA: '22', FROM_SCHEMA: '22' });
    expect(serverError.status, serverError.out).not.toBe(0);
  });

  it('refuses a service that is not serving, or that refuses its own schema', async () => {
    const degraded = await attest(
      {
        status: 200,
        body: JSON.stringify({ status: 'degraded', schema: { databaseVersion: 22, accepted: true } }),
      },
      { PROD_SCHEMA: '22', FROM_SCHEMA: '22' },
    );
    expect(degraded.status, degraded.out).not.toBe(0);
    expect(degraded.out).toContain("not 'serving'");

    const unaccepted = await attest(
      {
        status: 200,
        body: JSON.stringify({ status: 'serving', schema: { databaseVersion: 22, accepted: false } }),
      },
      { PROD_SCHEMA: '22', FROM_SCHEMA: '22' },
    );
    expect(unaccepted.status, unaccepted.out).not.toBe(0);
    expect(unaccepted.out).toContain('does not accept its own schema');
  });

  it('fails closed when production does not answer', async () => {
    const outcome = await attest(null, { PROD_SCHEMA: '22', FROM_SCHEMA: '22' });
    expect(outcome.status, outcome.out).not.toBe(0);
    expect(outcome.out).toContain('did not answer 200 in three attempts');
  });

  it('fails closed on a malformed answer rather than guessing', async () => {
    for (const malformed of ['not json at all', '{}', '{"status":"serving","schema":{"accepted":true}}']) {
      const outcome = await attest({ status: 200, body: malformed }, { PROD_SCHEMA: '22', FROM_SCHEMA: '22' });
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
  const body = runBody('The grants baseline may not move in the same pull request as a migration');

  it('names both halves of the rule', () => {
    expect(body).toContain('tools/upgrade/grants-baseline.json');
    expect(body).toContain('packages/domain/db/migrations/');
    expect(body).toContain('--no-renames');
  });
});
