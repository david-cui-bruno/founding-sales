import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readRepositoryFile, repositoryPath } from './support/repository.ts';

/**
 * Slice R0: the upgrade check's base comes from production itself.
 *
 * `FSS_PROD_COMMIT` goes stale after every autodeploy (autodeploys move production, not
 * the variable); it broke PR 344 and again during releases 0028-0030. The upgrade job now
 * asks production's public `/health` (`build.commit`, `schema.databaseVersion`), and the
 * variables are only the fallback. This file runs `tools/ci/resolve-prod-base.sh` itself,
 * against a real loopback HTTP server, and holds the workflow to calling it.
 *
 * The script's answer is checked as the workflow reads it: `commit=`, `schema=` and
 * `source=` lines in `$GITHUB_OUTPUT`.
 */

const SCRIPT = repositoryPath('tools/ci/resolve-prod-base.sh');
const WORKFLOW = readRepositoryFile('.github/workflows/greenfield.yml');

const COMMIT = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

interface Outcome {
  readonly status: number;
  readonly out: string;
  readonly outputs: Readonly<Record<string, string>>;
  readonly sleeps: readonly string[];
}

type Answer = { status: number; body: string; location?: string } | null;

const health = (overrides: Record<string, unknown> = {}): Answer => ({
  status: 200,
  body: JSON.stringify({
    status: 'serving',
    build: { commit: COMMIT },
    schema: { declaredRange: { minimum: 30, maximum: 30 }, databaseVersion: 30, accepted: true },
    ...overrides,
  }),
});

/**
 * One loopback server (or, for `null`, a port nothing listens on), so the script's own
 * curl is run against a real status line. `sleep` is replaced by a recorder first on
 * PATH: the retries stay real, the waiting does not, and the recording is asserted.
 */
async function resolve(
  answer: Answer,
  environment: Readonly<Record<string, string>> = {},
  origin?: string,
): Promise<Outcome> {
  const directory = mkdtempSync(join(tmpdir(), 'fss-resolve-'));
  temporary.push(directory);
  const bin = join(directory, 'bin');
  mkdirSync(bin, { recursive: true });
  const sleepLog = join(directory, 'sleeps');
  writeFileSync(join(bin, 'sleep'), `#!/bin/sh\necho "$1" >> ${JSON.stringify(sleepLog)}\n`, { encoding: 'utf8', mode: 0o755 });
  const outputFile = join(directory, 'github-output');
  writeFileSync(outputFile, '', 'utf8');
  const server =
    answer === null
      ? null
      : createServer((_request, response) => {
          const headers: Record<string, string> = { 'content-type': 'application/json' };
          if (answer.location !== undefined) headers['location'] = answer.location;
          response.writeHead(answer.status, headers);
          response.end(answer.body);
        });
  const base = await new Promise<string>(done => {
    if (server === null) {
      done('http://127.0.0.1:9');
      return;
    }
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      done(`http://127.0.0.1:${String(typeof address === 'object' && address !== null ? address.port : 0)}`);
    });
  });
  try {
    // `spawn`, not `spawnSync`: the server is in this process.
    return await new Promise<Outcome>(done => {
      const child = spawn('bash', [SCRIPT], {
        cwd: directory,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env['PATH'] ?? ''}`,
          GITHUB_OUTPUT: outputFile,
          FSS_PRODUCTION_ORIGIN: origin ?? base,
          VAR_PROD_COMMIT: '',
          VAR_PROD_SCHEMA: '',
          HEAD_SCHEMA: '30',
          ...environment,
        },
      });
      let out = '';
      child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
      child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
      child.on('close', code => {
        const outputs: Record<string, string> = {};
        for (const line of readFileSync(outputFile, 'utf8').split('\n')) {
          const at = line.indexOf('=');
          if (at > 0) outputs[line.slice(0, at)] = line.slice(at + 1);
        }
        done({
          status: code ?? -1,
          out,
          outputs,
          sleeps: existsSync(sleepLog) ? readFileSync(sleepLog, 'utf8').split('\n').filter(line => line !== '') : [],
        });
      });
    });
  } finally {
    server?.close();
  }
}

const VARIABLES = { VAR_PROD_COMMIT: OTHER, VAR_PROD_SCHEMA: '29' };


describe('the upgrade base is what production says it runs', () => {
  it('takes the commit and the schema from /health, with no variables set', async () => {
    const outcome = await resolve(health());
    expect(outcome.status, outcome.out).toBe(0);
    expect(outcome.outputs).toEqual({ commit: COMMIT, schema: '30', source: 'health' });
    expect(outcome.out).not.toContain('::warning');
    expect(outcome.out).not.toContain('::notice');
  });

  it('uses /health and says the variables are stale when they disagree', async () => {
    const outcome = await resolve(health(), VARIABLES);
    expect(outcome.status, outcome.out).toBe(0);
    expect(outcome.outputs).toEqual({ commit: COMMIT, schema: '30', source: 'health' });
    expect(outcome.out).toContain('::notice title=FSS_PROD_COMMIT is stale');
    expect(outcome.out).toContain('::notice title=FSS_PROD_SCHEMA is stale');
  });

  it('says nothing about the variables when they agree', async () => {
    const outcome = await resolve(health(), { VAR_PROD_COMMIT: COMMIT, VAR_PROD_SCHEMA: '30' });
    expect(outcome.status, outcome.out).toBe(0);
    expect(outcome.out).not.toContain('stale');
  });

  // The variables describe a lagging production (29) while production is on 30. A branch
  // declaring 31 runs an upgrade, so none of these may certify it from the variables.
  const LAGGING = { VAR_PROD_COMMIT: OTHER, VAR_PROD_SCHEMA: '29', HEAD_SCHEMA: '31' };
  // A branch that declares the schema the variables say: no upgrade, fallback allowed.
  const NO_UPGRADE = { VAR_PROD_COMMIT: OTHER, VAR_PROD_SCHEMA: '29', HEAD_SCHEMA: '29' };

  const unusable: readonly [string, Answer][] = [
    ['garbage', { status: 200, body: 'not json at all' }],
    ['an empty object', { status: 200, body: '{}' }],
    ['an array', { status: 200, body: '[]' }],
    ['a short commit', health({ build: { commit: 'abc123' } })],
    ['the zero commit', health({ build: { commit: '0'.repeat(40) } })],
    ['a null commit', health({ build: { commit: null } })],
    ['a missing build', health({ build: undefined })],
    ['an upper-case commit', health({ build: { commit: COMMIT.toUpperCase() } })],
    ['schema zero', health({ schema: { databaseVersion: 0, accepted: true } })],
    ['a non-numeric schema', health({ schema: { databaseVersion: 'thirty', accepted: true } })],
    ['a degraded service', health({ status: 'degraded' })],
    ['a schema it does not accept', health({ schema: { databaseVersion: 30, accepted: false } })],
    ['a redirect', { status: 302, body: health()?.body ?? '', location: 'https://elsewhere.example/health' }],
    ['a server error', { status: 503, body: health()?.body ?? '' }],
    ['nothing listening', null],
  ];

  it('never certifies an upgrade from the variables: every unusable /health fails', async () => {
    for (const [what, answer] of unusable) {
      const outcome = await resolve(answer, LAGGING);
      expect(outcome.status, `${what}: ${outcome.out}`).not.toBe(0);
      expect(outcome.out, what).toContain('would run an upgrade');
      expect(outcome.outputs['commit'], what).toBeUndefined();
    }
  });

  it('fails with no variables at all, whatever /health says', async () => {
    for (const [what, answer] of unusable) {
      const outcome = await resolve(answer, { HEAD_SCHEMA: '29' });
      expect(outcome.status, `${what}: ${outcome.out}`).not.toBe(0);
      expect(outcome.outputs['commit'], what).toBeUndefined();
    }
  });

  it('falls back, with a warning, only where there is no upgrade to test', async () => {
    for (const [what, answer] of unusable) {
      const outcome = await resolve(answer, NO_UPGRADE);
      expect(outcome.status, `${what}: ${outcome.out}`).toBe(0);
      expect(outcome.outputs, what).toEqual({ commit: OTHER, schema: '29', source: 'variables' });
      expect(outcome.out, what).toContain('::warning title=Using the repository variables');
    }
  });

  it('retries an unreachable production, bounded, before giving up', async () => {
    const outcome = await resolve(null, NO_UPGRADE);
    expect(outcome.sleeps).toEqual(['5', '5']);
  });

  it('refuses half-set variables and unusable variables on the fallback', async () => {
    for (const environment of [
      { VAR_PROD_COMMIT: OTHER, HEAD_SCHEMA: '29' },
      { VAR_PROD_SCHEMA: '29', HEAD_SCHEMA: '29' },
      { VAR_PROD_COMMIT: OTHER, VAR_PROD_SCHEMA: 'two', HEAD_SCHEMA: '29' },
      { VAR_PROD_COMMIT: OTHER, VAR_PROD_SCHEMA: '0', HEAD_SCHEMA: '29' },
      { VAR_PROD_COMMIT: 'abc', VAR_PROD_SCHEMA: '29', HEAD_SCHEMA: '29' },
      { VAR_PROD_COMMIT: '0'.repeat(40), VAR_PROD_SCHEMA: '29', HEAD_SCHEMA: '29' },
    ]) {
      const outcome = await resolve(null, environment);
      expect(outcome.status, outcome.out).not.toBe(0);
    }
    const unset = await resolve(null, NO_UPGRADE, '');
    expect(unset.outputs['source']).toBe('variables');
  });

  it('fails closed when the schema the branch declares cannot be read', async () => {
    const outcome = await resolve(health(), { HEAD_SCHEMA: 'x' });
    expect(outcome.status, outcome.out).not.toBe(0);
  });

  it('requires a clean transfer as well as a 200: a 200 whose transfer fails is not an answer', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fss-resolve-curl-'));
    temporary.push(directory);
    const bin = join(directory, 'bin');
    mkdirSync(bin, { recursive: true });
    // A curl that writes a complete healthy body, prints 200, and exits 28 (timeout).
    writeFileSync(
      join(bin, 'curl'),
      `#!/bin/sh\nwhile [ "$#" -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done\nprintf '%s' ${JSON.stringify(health()?.body ?? '')} > "$out"\nprintf 200\nexit 28\n`,
      { encoding: 'utf8', mode: 0o755 },
    );
    writeFileSync(join(bin, 'sleep'), '#!/bin/sh\n', { encoding: 'utf8', mode: 0o755 });
    const outputFile = join(directory, 'out');
    writeFileSync(outputFile, '', 'utf8');
    const run = (head: string): { status: number; out: string } => {
      const result = spawnSync('bash', [SCRIPT], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env['PATH'] ?? ''}`,
          GITHUB_OUTPUT: outputFile,
          FSS_PRODUCTION_ORIGIN: 'http://127.0.0.1:9',
          VAR_PROD_COMMIT: OTHER,
          VAR_PROD_SCHEMA: '29',
          HEAD_SCHEMA: head,
        },
      });
      return { status: result.status ?? -1, out: `${result.stdout}${result.stderr}` };
    };
    const upgrade = run('30');
    expect(upgrade.status, upgrade.out).not.toBe(0);
    expect(upgrade.out).toContain('curl exit 28');
    expect(readFileSync(outputFile, 'utf8')).not.toContain('source=health');
  });

  it('puts nothing from /health into an annotation that could forge another', async () => {
    const hostile = 'serving\n::error::forged\r::set-output name=x::y';
    const outcome = await resolve(health({ status: hostile }), LAGGING);
    expect(outcome.status, outcome.out).not.toBe(0);
    for (const line of outcome.out.split('\n')) {
      if (line.startsWith('::')) expect(line.match(/::/gu)?.length, line).toBe(2);
    }
    expect(outcome.out).not.toMatch(/^::error::forged/mu);
    expect(outcome.out).not.toMatch(/^::set-output/mu);
  });
});

describe('the upgrade job is wired to what production says', () => {
  const lines = WORKFLOW.split('\n');
  const stepAt = (name: string): number => {
    const at = lines.findIndex(line => line.trim() === `- name: ${name}`);
    expect(at, `the workflow has no step named "${name}"`).toBeGreaterThan(-1);
    return at;
  };
  /** The step's text up to the next `- name:` at the same indent. */
  const step = (name: string): string => {
    const at = stepAt(name);
    const end = lines.findIndex((line, index) => index > at && /^ {6}- /u.test(line));
    return lines.slice(at, end === -1 ? undefined : end).join('\n');
  };
  const RESOLVE = 'Resolve what production runs, from production';
  const RANGE = 'What production runs, and what this branch would move it to';

  it('resolves before the range step, by the tested script, with the variables only as the fallback', () => {
    expect(stepAt(RESOLVE)).toBeLessThan(stepAt(RANGE));
    const resolveStep = step(RESOLVE);
    expect(resolveStep).toContain('id: prod');
    expect(resolveStep).toContain('run: bash tools/ci/resolve-prod-base.sh');
    expect(resolveStep).toContain('VAR_PROD_COMMIT: ${{ vars.FSS_PROD_COMMIT }}');
    expect(resolveStep).toContain('VAR_PROD_SCHEMA: ${{ vars.FSS_PROD_SCHEMA }}');
  });

  it('gives the range step production’s answer, never the variables directly', () => {
    const rangeStep = step(RANGE);
    expect(rangeStep).toContain('PROD_SCHEMA: ${{ steps.prod.outputs.schema }}');
    expect(rangeStep).toContain('PROD_COMMIT: ${{ steps.prod.outputs.commit }}');
    expect(rangeStep).not.toMatch(/vars\.FSS_PROD_/u);
    // The job's own origin is what the script asks.
    expect(WORKFLOW).toMatch(/FSS_PRODUCTION_ORIGIN: \$\{\{ vars\.FSS_PRODUCTION_ORIGIN \|\| 'https:\/\/api\.usecallie\.com' \}\}/u);
  });

  it('carries no credential in the script', () => {
    expect(readFileSync(SCRIPT, 'utf8')).not.toMatch(/Authorization|secrets\./u);
  });
});
