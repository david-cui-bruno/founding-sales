import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseOptions, UsageError } from '../../tools/upgrade/options.ts';
import { redactConnectionStrings, REDACTED } from '../../tools/upgrade/redact.ts';
import { Report } from '../../tools/upgrade/report.ts';
import { repositoryPath } from './support/repository.ts';

/**
 * The upgrade test's evidence file, and what may reach it.
 *
 * Three rules from the third GPT-6 review of PR 314 (P2), none of which the upgrade
 * test itself can demonstrate cheaply — it needs a PostgreSQL cluster and a quarter of
 * an hour. What is pinned here is the argument handling and the two terminal sinks:
 *
 *  - `--evidence` is compared by **canonical** path, so a symlink outside both
 *    checkouts pointing at a tracked file inside one is refused;
 *  - the final write happens **only** if this process created the file itself, so a
 *    path already taken is left exactly as it was found;
 *  - every terminal sink redacts, including the raw stderr write on an unexpected
 *    error, and a run that dies before it owns an artifact leaves a fallback one in CI.
 */

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

/** Two checkout-shaped directories and an outside directory, all under one canonical root. */
function world(): { readonly root: string; readonly base: string; readonly tree: string; readonly outside: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fss-upgrade-evidence-')));
  temporary.push(root);
  const base = join(root, 'base');
  const tree = join(root, 'head');
  const outside = join(root, 'outside');
  for (const checkout of [base, tree]) mkdirSync(join(checkout, 'packages', 'domain', 'db', 'migrations'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  return { root, base, tree, outside };
}

function parse(place: ReturnType<typeof world>, evidence: string): ReturnType<typeof parseOptions> {
  return parseOptions(['--from', '23', '--to', '24', '--base', place.base, '--tree', place.tree, '--evidence', evidence], place.tree);
}

describe('--evidence may not name a path inside either checkout, however it is spelled', () => {
  it('takes a path outside both checkouts', () => {
    const place = world();
    const path = join(place.outside, 'upgrade-evidence.txt');
    expect(parse(place, path).evidence).toBe(path);
  });

  it('refuses a path lexically inside the head checkout and one inside the base checkout', () => {
    const place = world();
    for (const checkout of [place.tree, place.base]) {
      expect(() => parse(place, join(checkout, 'packages', 'domain', 'db', 'migrations', '0024_email_presentation.sql'))).toThrow(
        UsageError,
      );
    }
  });

  it('refuses a symlink that sits outside and points at a tracked file inside', () => {
    const place = world();
    const tracked = join(place.tree, 'packages', 'domain', 'db', 'migrations', '0024_email_presentation.sql');
    writeFileSync(tracked, '-- 0024\n', 'utf8');
    const alias = join(place.outside, 'evidence-alias.txt');
    symlinkSync(tracked, alias);
    expect(() => parse(place, alias)).toThrow(/resolves to .*which is inside the head checkout/u);
    expect(readFileSync(tracked, 'utf8')).toBe('-- 0024\n');
  });

  it('refuses a path under a symlinked directory, where the file does not exist yet', () => {
    const place = world();
    const alias = join(place.outside, 'migrations-alias');
    symlinkSync(join(place.base, 'packages', 'domain', 'db', 'migrations'), alias);
    expect(() => parse(place, join(alias, 'upgrade-evidence.txt'))).toThrow(/which is inside the base checkout/u);
  });
});

/** The tool's entry point, with no cluster: every case here dies before step 1. */
function runTool(
  argv: readonly string[],
  environment: Readonly<Record<string, string>> = {},
): { readonly status: number | null; readonly stdout: string; readonly stderr: string } {
  const result = spawnSync(
    process.execPath,
    ['--experimental-transform-types', '--disable-warning=ExperimentalWarning', repositoryPath('tools/upgrade/main.ts'), ...argv],
    { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '', RUNNER_TEMP: '', ...environment } },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('the evidence file is written only by the run that created it', () => {
  it('leaves an evidence path that was already taken exactly as it found it, and fails', () => {
    const place = world();
    const path = join(place.outside, 'upgrade-evidence.txt');
    writeFileSync(path, "another run's evidence\n", 'utf8');
    const run = runTool(['--from', '23', '--to', '24', '--base', place.base, '--tree', place.tree, '--evidence', path]);
    expect(run.status, run.stderr).toBe(1);
    expect(run.stderr).toContain('already exists');
    expect(readFileSync(path, 'utf8')).toBe("another run's evidence\n");
  });

  it('creates a free path exclusively and then writes its own report there, and nothing else', () => {
    const place = world();
    const path = join(place.outside, 'upgrade-evidence.txt');
    // The stub goes in before the first step; this run fails long before a database
    // exists, so what lands is the failed run's report — written because the run owns
    // the file, which is the whole of the rule.
    runTool(['--from', '23', '--to', '24', '--base', place.base, '--tree', place.tree, '--evidence', path]);
    expect(readFileSync(path, 'utf8')).toContain('upgrade test: schema 23 → 24');
    expect(readdirSync(place.outside)).toEqual(['upgrade-evidence.txt']);
  });
});

describe('a run that dies before it owns an artifact leaves one in CI, and nothing outside it', () => {
  it('writes upgrade-evidence-unstarted-<pid>.txt for a usage error under GITHUB_ACTIONS', () => {
    const place = world();
    const run = runTool(['--from', '23', '--to', '24'], { GITHUB_ACTIONS: 'true', RUNNER_TEMP: place.outside });
    expect(run.status, run.stderr).toBe(1);
    expect(run.stderr).toContain('--base');
    const written = readdirSync(place.outside);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatch(/^upgrade-evidence-unstarted-\d+\.txt$/u);
    const text = readFileSync(join(place.outside, written[0] ?? ''), 'utf8');
    expect(text).toContain('the run did not start');
    expect(text).toContain('No database was created and no migration was applied.');
  });

  it('writes nothing at all outside CI', () => {
    const place = world();
    const run = runTool(['--from', '23', '--to', '24'], { RUNNER_TEMP: place.outside });
    expect(run.status).toBe(1);
    expect(readdirSync(place.outside)).toEqual([]);
  });

  it('does not write a fallback when the run owns an evidence file of its own', () => {
    const place = world();
    const artifacts = join(place.root, 'artifacts');
    mkdirSync(artifacts);
    const path = join(place.outside, 'upgrade-evidence.txt');
    runTool(['--from', '23', '--to', '24', '--base', place.base, '--tree', place.tree, '--evidence', path], {
      GITHUB_ACTIONS: 'true',
      RUNNER_TEMP: artifacts,
    });
    expect(readdirSync(artifacts)).toEqual([]);
  });
});

describe('every terminal sink redacts a connection string', () => {
  const url = 'postgresql://fss_runtime:hunter2@db.internal:5432/fss';

  it('replaces a URL and a bare user:password@host', () => {
    expect(redactConnectionStrings(`connect ${url} failed`)).toBe(`connect ${REDACTED} failed`);
    expect(redactConnectionStrings('fss_runtime:hunter2@db.internal:5432')).toBe(REDACTED);
  });

  it('redacts through Report.line, which every other Report method funnels into', () => {
    const report = new Report();
    report.line(`a ${url}`);
    report.step(1, `step with ${url}`, 1);
    report.table(['h'], [[url]]);
    expect(report.toString()).not.toContain('hunter2');
    expect(report.toString().split('\n').filter(line => line.includes(REDACTED))).toHaveLength(3);
  });

  it('redacts the raw stderr write of an unexpected error and the fallback artifact', () => {
    const place = world();
    const run = runTool(['--from', '23', '--to', '24', '--base', `/nonexistent-${url}`], {
      GITHUB_ACTIONS: 'true',
      RUNNER_TEMP: place.outside,
    });
    expect(run.status).toBe(1);
    expect(run.stderr).not.toContain('hunter2');
    expect(run.stderr).toContain(REDACTED);
    const written = readdirSync(place.outside);
    expect(written).toHaveLength(1);
    expect(readFileSync(join(place.outside, written[0] ?? ''), 'utf8')).not.toContain('hunter2');
  });
});
