import { spawn } from 'node:child_process';
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

  it('falls back to the variables, with a warning, on garbage', async () => {
    for (const body of ['not json at all', '{}', '[]']) {
      const outcome = await resolve({ status: 200, body }, VARIABLES);
      expect(outcome.status, `${body}: ${outcome.out}`).toBe(0);
      expect(outcome.outputs).toEqual({ commit: OTHER, schema: '29', source: 'variables' });
      expect(outcome.out).toContain('::warning title=Using the repository variables');
    }
  });

  it('refuses garbage with no variables rather than guessing', async () => {
    for (const body of ['not json at all', '{}', JSON.stringify({ status: 'serving', schema: { databaseVersion: 30, accepted: true } })]) {
      const outcome = await resolve({ status: 200, body });
      expect(outcome.status, `${body}: ${outcome.out}`).not.toBe(0);
      expect(outcome.outputs['commit']).toBeUndefined();
    }
  });

  it('does not take a /health that cannot be trusted: a bad commit, a bad schema, not serving, not accepted', async () => {
    const untrusted = [
      health({ build: { commit: 'abc123' } }),
      health({ build: { commit: '0'.repeat(40) } }),
      health({ build: { commit: null } }),
      health({ build: { commit: COMMIT.toUpperCase() } }),
      health({ schema: { databaseVersion: 0, accepted: true } }),
      health({ schema: { databaseVersion: 'thirty', accepted: true } }),
      health({ status: 'degraded' }),
      health({ schema: { databaseVersion: 30, accepted: false } }),
    ];
    for (const answer of untrusted) {
      const outcome = await resolve(answer, VARIABLES);
      expect(outcome.outputs['source'], `${answer?.body ?? ''}: ${outcome.out}`).toBe('variables');
      const alone = await resolve(answer);
      expect(alone.status, `${answer?.body ?? ''}: ${alone.out}`).not.toBe(0);
    }
  });

  it('falls back on a redirect and on a server error, and follows no redirect', async () => {
    const redirect = await resolve({ status: 302, body: health()?.body ?? '', location: 'https://elsewhere.example/health' }, VARIABLES);
    expect(redirect.outputs['source']).toBe('variables');
    const failing = await resolve({ status: 503, body: health()?.body ?? '' }, VARIABLES);
    expect(failing.outputs['source']).toBe('variables');
  });

  it('falls back, bounded and with retries, when production is unreachable', async () => {
    const outcome = await resolve(null, VARIABLES);
    expect(outcome.status, outcome.out).toBe(0);
    expect(outcome.outputs).toEqual({ commit: OTHER, schema: '29', source: 'variables' });
    expect(outcome.out).toContain('::warning title=Using the repository variables');
    // Three attempts, so two waits.
    expect(outcome.sleeps).toEqual(['5', '5']);
  });

  it('fails closed when production is unreachable and the variables are empty or half set', async () => {
    for (const environment of [{}, { VAR_PROD_COMMIT: OTHER }, { VAR_PROD_SCHEMA: '29' }]) {
      const outcome = await resolve(null, environment);
      expect(outcome.status, outcome.out).not.toBe(0);
      expect(outcome.out).toContain('::error::');
      expect(outcome.outputs['commit']).toBeUndefined();
    }
    const unset = await resolve(null, {}, '');
    expect(unset.status, unset.out).not.toBe(0);
  });

  it('refuses unusable variables on the fallback', async () => {
    for (const environment of [
      { VAR_PROD_COMMIT: 'abc', VAR_PROD_SCHEMA: '29' },
      { VAR_PROD_COMMIT: '0'.repeat(40), VAR_PROD_SCHEMA: '29' },
      { VAR_PROD_COMMIT: OTHER, VAR_PROD_SCHEMA: 'two' },
      { VAR_PROD_COMMIT: OTHER, VAR_PROD_SCHEMA: '0' },
    ]) {
      const outcome = await resolve(null, environment);
      expect(outcome.status, outcome.out).not.toBe(0);
    }
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
