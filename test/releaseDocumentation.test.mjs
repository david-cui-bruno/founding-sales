import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
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
describe('release verification documentation', () => {
  it('separates exact current24 pre-release backup from historical15 audit and the older-workspace protected-copy hold', () => {
    // The release manual moved verbatim from README.md to docs/engineering/release.md on 2026-09-16.
    const releaseManual = readFileSync(join(projectRoot, 'docs/engineering/release.md'), 'utf8');
    // Historical plan, archived under docs/archive/ on 2026-09-16 without content changes.
    const plan = readFileSync(join(projectRoot, 'docs/archive/superpowers/plans/2026-09-04-runtime-recovery-security-hardening.md'), 'utf8');
    expect(releaseManual).toContain('exact current schema24 only');
    expect(releaseManual).toContain('supersedes the unreleased schema15-only host');
    expect(releaseManual).toContain('historical schema15 audit');
    expect(releaseManual).toMatch(/older founder workspace[\s\S]*separately approved protected-copy workflow/);
    expect(releaseManual).toMatch(/schema15[\s\S]*refused without migration or backup\/receipt writes/);
    expect(plan).toMatch(/Task12[\s\S]*exact current schema16 only/);
    expect(plan).toMatch(/Task10[\s\S]*historical[\s\S]*schema15/);
  });
  it('packages before packaged E2E and verifies that artifact afterward', () => {
    // The release manual moved verbatim from README.md to docs/engineering/release.md on 2026-09-16.
    const releaseManual = readFileSync(join(projectRoot, 'docs/engineering/release.md'), 'utf8');
    const packageJson = JSON.parse(
      readFileSync(join(projectRoot, 'package.json'), 'utf8'),
    );
    expect(packageJson.scripts['verify:release']).toBe('node scripts/verifyRelease.mjs');
    expect(packageJson.scripts['test:helpers:node']).toBe('node --test test/appleBridgeBuild.test.mjs test/verifyAppleBridgePackage.test.mjs');
    expect(packageJson.scripts['test:backup:electron']).toBe('CALLIE_TEST_SYNTHETIC_ELECTRON=1 vitest run test/preReleaseElectronHost.test.mjs');
    expect(releaseManual).toContain('two independent');
    expect(releaseManual).toContain('CALLIE_RELEASE_OUT_DIR');
    expect(releaseManual).toContain('CALLIE_E2E_OUT_DIR');
    expect(releaseManual).toContain('ASAR SHA256');
    expect(releaseManual).toContain('owned encrypted migration/transition fixtures');
    expect(releaseManual).toContain('npm run verify:release');
    expect(releaseManual).toContain('CI never');
    expect(releaseManual).toMatch(/separately\s+authorized/);
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
    // The release manual moved verbatim from README.md to docs/engineering/release.md on 2026-09-16.
    const releaseManual = readFileSync(join(projectRoot, 'docs/engineering/release.md'), 'utf8');

    expect(releaseManual).toMatch(
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
      // setup-node owns PATH on hosted and release runners. A developer's
      // Homebrew prefix can silently select a different Node installation.
      expect(source).not.toMatch(/export\s+PATH=|^\s+PATH:/m);
    }
  });
  it('keeps PRs on disposable hosted runners and release dispatch on approved exact tag/ref with external approvals', () => {
    const ci = readFileSync(join(projectRoot, '.github/workflows/ci.yml'), 'utf8');
    const release = readFileSync(join(projectRoot, '.github/workflows/release.yml'), 'utf8');
    expect(ci).toContain('pull_request:'); expect(ci).not.toContain('self-hosted');
    expect(release).toContain('workflow_dispatch:'); expect(release).toContain('audited_sha:'); expect(release).toContain('tag:');
    expect(release).toContain('ARM64'); expect(release).toContain('CALLIE_APPROVED_RELEASE_SHA'); expect(release).toContain('CALLIE_RELEASE_RUNNER_APPROVED');
    expect(release).toContain('scripts/writeReleaseMarker.mjs --verify-ref'); expect(release).toContain('npm run verify:release');
    expect(ci).toContain('npm run test:browser:native-desk');
    expect(ci).toContain('npm run test:helpers:node');
    expect(release).toContain('test:swift');
    expect(release).toContain('test:backup:electron');
    expect(release).toContain('sw_vers'); expect(release).toContain('xcrun');
  });
});
