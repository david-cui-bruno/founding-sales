import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import semver from 'semver';
import { describe, expect, it } from 'vitest';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('release verification documentation', () => {
  it('packages before packaged E2E and verifies that artifact afterward', () => {
    const readme = readFileSync(join(projectRoot, 'README.md'), 'utf8');
    const packageJson = JSON.parse(
      readFileSync(join(projectRoot, 'package.json'), 'utf8'),
    );
    const documentedSequence = [
      'npm ci',
      'npm run rebuild',
      'npm run verify',
      'npm run verify:e2e',
      'npm run verify:package',
      'npm run start',
    ].join('\n');

    expect(readme).toContain(documentedSequence);
    expect(packageJson.scripts['verify:e2e']).toBe(
      'npm run package && npm run test:e2e',
    );
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
