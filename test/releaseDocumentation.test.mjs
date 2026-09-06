import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import semver from 'semver';
import { describe, expect, it } from 'vitest';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

it('parses both workflow sources and syntax-checks each shell gate without executing providers', () => {
  const require = createRequire(import.meta.url);
  const yaml = createRequire(require.resolve('eslint/package.json'))('js-yaml');
  for (const name of ['ci', 'release']) {
    const workflow = yaml.load(readFileSync(join(projectRoot, `.github/workflows/${name}.yml`), 'utf8'));
    for (const job of Object.values(workflow.jobs)) for (const step of job.steps) if (step.run) {
      expect(spawnSync('/bin/bash', ['-n'], { input: step.run.replace(/\$\{\{[^}]+\}\}/g, 'fixture'), encoding: 'utf8' }).status).toBe(0);
    }
  }
});
it('executes one-artifact release ordering with fake tools and short-circuits every failing stage', () => {
  const root = mkdtempSync(join(process.env.JCODE_SCRATCH_DIR ?? tmpdir(), 'release-order-'));
  const gate = JSON.parse(readFileSync(join(projectRoot, 'package.json'))).scripts['verify:release'];
  const expected = ['npm run typecheck', 'npm run lint:tracked', 'npm run test', 'npm run verify:lambdas', 'npm run package', 'node scripts/verifyPackage.mjs', 'npm run verify:secrets', 'node scripts/verifySecrets.mjs --package', 'npm run test:e2e', 'node scripts/verifyPackage.mjs'];
  try {
    for (const tool of ['npm', 'node']) {
      const file = join(root, tool);
      writeFileSync(file, `#!${process.execPath}\nconst fs=require('fs');const line=${JSON.stringify(tool + ' ')}+process.argv.slice(2).join(' ');fs.appendFileSync(process.env.FIXTURE_LOG,line+'\\n');const count=fs.readFileSync(process.env.FIXTURE_LOG,'utf8').trim().split('\\n').length;process.exit(count===Number(process.env.FAIL_STAGE)?1:0);`); chmodSync(file, 0o755);
    }
    for (let failure = 0; failure <= expected.length; failure++) {
      const log = join(root, `log-${failure}`);
      const result = spawnSync('/bin/bash', ['-c', gate], { cwd: root, env: { ...process.env, PATH: root, FIXTURE_LOG: log, FAIL_STAGE: String(failure) }, encoding: 'utf8' });
      expect(result.status).toBe(failure ? 1 : 0);
      expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(expected.slice(0, failure || expected.length));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

describe('release verification documentation', () => {
  it('packages before packaged E2E and verifies that artifact afterward', () => {
    const readme = readFileSync(join(projectRoot, 'README.md'), 'utf8');
    const packageJson = JSON.parse(
      readFileSync(join(projectRoot, 'package.json'), 'utf8'),
    );
    const gate = packageJson.scripts['verify:release'];
    expect(typeof gate).toBe('string');
    expect((gate.match(/npm run package/g) ?? []).length).toBe(1);
    expect(gate).toContain('npm run lint:tracked');
    expect(gate).toContain('npm run verify:lambdas');
    expect(gate).toContain('npm run verify:secrets');
    expect(gate).toContain('node scripts/verifySecrets.mjs --package');
    expect(gate).not.toContain('backup:pre-release');
    expect(gate.indexOf('npm run package')).toBeLessThan(gate.indexOf('npm run test:e2e'));
    expect(gate.lastIndexOf('node scripts/verifyPackage.mjs')).toBeGreaterThan(gate.indexOf('npm run test:e2e'));
    expect(readme).toContain('npm run verify:release');
    expect(readme).toContain('CI never');
    expect(readme).toMatch(/separately\s+authorized/);
  });

  it('declares only Node release lines supported by the installed toolchain', () => {
    const packageJson = JSON.parse(
      readFileSync(join(projectRoot, 'package.json'), 'utf8'),
    );
    const nodeRange = packageJson.engines.node;
    const boundaries = [
      ['22.12.999', false],
      ['22.13.0', false],
      ['22.99.0', false],
      ['23.0.0', false],
      ['23.99.0', false],
      ['24.0.0', true],
      ['24.99.0', true],
      ['25.9.0', false],
    ];

    for (const [version, expected] of boundaries) {
      expect(semver.satisfies(version, nodeRange), version).toBe(expected);
    }
  });

  it('makes npm enforce the project engine policy', () => {
    expect(
      execFileSync('npm', ['config', 'get', 'engine-strict', '--location=project'], {
        cwd: projectRoot,
        encoding: 'utf8',
      }).trim(),
    ).toBe('true');
  });

  it('documents only the Gate 0 Node 24 release line', () => {
    const readme = readFileSync(join(projectRoot, 'README.md'), 'utf8');

    expect(readme).toMatch(
      /Use Node\.js 24\..*other Node majors fail closed/s,
    );
  });
});

describe('source-only workflow policy', () => {
  it('pins full-history actions, exact Node, independent installs and real scanner without founder backup', () => {
    for (const name of ['ci', 'release']) {
      const source = readFileSync(join(projectRoot, `.github/workflows/${name}.yml`), 'utf8');
      expect(source).toContain('actions/checkout@11d5960a326750d5838078e36cf38b85af677262');
      expect(source).toContain('actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020');
      expect(source).toContain('fetch-depth: 0'); expect(source).toContain('fetch-tags: true'); expect(source).toContain('persist-credentials: false');
      expect(source).toContain("node-version: '24.20.0'"); expect(source).toContain("process.versions.node !== '24.20.0'");
      expect(source).toContain('npm ci --prefix cloud/lambdas/shared'); expect(source).toContain('cloud/lambdas/*/package-lock.json');
      expect(source).toContain('b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5');
      expect(source).not.toMatch(/pull_request_target|npm run publish|backup:pre-release|aws |tofu /);
      for (const line of source.split('\n').filter(line => /^\s*(?:npm|npx) /.test(line))) expect(line).toContain('export PATH=');
    }
  });
  it('keeps PRs on disposable hosted runners and release dispatch on approved exact tag/ref with external approvals', () => {
    const ci = readFileSync(join(projectRoot, '.github/workflows/ci.yml'), 'utf8');
    const release = readFileSync(join(projectRoot, '.github/workflows/release.yml'), 'utf8');
    expect(ci).toContain('pull_request:'); expect(ci).not.toContain('self-hosted');
    expect(release).toContain('workflow_dispatch:'); expect(release).toContain('audited_sha:'); expect(release).toContain('tag:');
    expect(release).toContain('ARM64'); expect(release).toContain('CALLIE_APPROVED_RELEASE_SHA'); expect(release).toContain('CALLIE_RELEASE_RUNNER_APPROVED');
    expect(release).toContain('scripts/writeReleaseMarker.mjs --verify-ref'); expect(release).toContain('npm run verify:release');
    expect(release).toContain('sw_vers'); expect(release).toContain('xcrun');
  });
});
