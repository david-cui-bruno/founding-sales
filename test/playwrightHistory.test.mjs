import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

it('keeps full history when the real Playwright runner captures GitHub PR metadata', () => {
  const root = mkdtempSync(join(process.env.JCODE_SCRATCH_DIR ?? tmpdir(), 'playwright-history-'));
  const seed = join(root, 'seed'), checkout = join(root, 'checkout');
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:GIT_|GITHUB_)/.test(key))),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  };
  const git = (cwd, ...args) => {
    const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd, env, encoding: 'utf8', timeout: 30_000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  try {
    mkdirSync(seed);
    git(seed, 'init', '-b', 'main');
    writeFileSync(join(seed, 'fixture.txt'), 'base\n');
    git(seed, 'add', '.'); git(seed, 'commit', '-m', 'base');
    const base = git(seed, 'rev-parse', 'HEAD');
    writeFileSync(join(seed, 'fixture.txt'), 'head\n');
    git(seed, 'commit', '-am', 'head');
    // --no-local exercises a real fetch protocol, using only this owned local origin.
    git(root, 'clone', '--no-local', seed, checkout);
    expect(git(checkout, 'rev-parse', '--is-shallow-repository')).toBe('false');
    const head = git(checkout, 'rev-parse', 'HEAD');
    const config = pathToFileURL(join(projectRoot, 'playwright.config.mjs')).href;
    const testApi = pathToFileURL(join(projectRoot, 'node_modules/playwright/test.mjs')).href;
    writeFileSync(join(checkout, 'playwright.config.mjs'), `import config from ${JSON.stringify(config)};\nexport default {...config, testDir: '.', testMatch: 'smoke.spec.mjs', workers: 1, reporter: 'line'};\n`);
    writeFileSync(join(checkout, 'smoke.spec.mjs'), `import {test, expect} from ${JSON.stringify(testApi)};\ntest('runs the actual metadata plugin', () => expect(1).toBe(1));\n`);
    const event = join(root, 'event.json');
    writeFileSync(event, JSON.stringify({ pull_request: { title: 'Synthetic PR', number: 1, base: { sha: base } } }));
    const run = spawnSync(process.execPath, [join(projectRoot, 'node_modules/playwright/cli.js'), 'test'], {
      cwd: checkout, encoding: 'utf8', timeout: 30_000,
      env: { ...env, CI: 'true', GITHUB_ACTIONS: 'true', GITHUB_EVENT_PATH: event,
        GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'fixture/repo', GITHUB_SHA: head, GITHUB_RUN_ID: '1' },
    });
    expect(run.error).toBeUndefined();
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.stdout).toContain('1 passed');
    expect(git(checkout, 'rev-parse', '--is-shallow-repository')).toBe('false');
    expect(git(checkout, 'rev-list', '--count', 'HEAD')).toBe('2');
    expect(git(checkout, 'rev-parse', 'HEAD')).toBe(head);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 45_000);
