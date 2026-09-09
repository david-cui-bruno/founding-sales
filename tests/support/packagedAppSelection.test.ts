import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createPackage, uncacheAll } from '@electron/asar';
import { readArtifactIdentity, resolveReleaseArtifact } from '../../scripts/releaseArtifact.mjs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('packaged test artifact selection', () => {
  const roots: string[] = [];
  afterEach(() => {
    roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
    uncacheAll();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('targets an explicitly selected candidate output instead of the running installed build', async () => {
    vi.stubEnv('CALLIE_E2E_OUT_DIR', '/fixture/fss-candidate');
    vi.resetModules();
    const { packagedApplicationBinary } = await import('./packagedApplication');
    expect(packagedApplicationBinary).toBe('/fixture/fss-candidate/Callie Founder Sales System-darwin-arm64/Callie Founder Sales System.app/Contents/MacOS/Callie Founder Sales System');
  });

  it('retains the existing out directory when no candidate is selected', async () => {
    vi.stubEnv('CALLIE_E2E_OUT_DIR', undefined);
    vi.stubEnv('CALLIE_RELEASE_OUT_DIR', undefined);
    vi.resetModules();
    const { packagedApplicationBinary } = await import('./packagedApplication');
    expect(packagedApplicationBinary).toBe(join(process.cwd(), 'out', 'Callie Founder Sales System-darwin-arm64', 'Callie Founder Sales System.app', 'Contents', 'MacOS', 'Callie Founder Sales System'));
  });

  it('checks the real selected archive before spawn, preserves standalone candidates and keeps runner metadata out of the app env', async () => {
    const root = mkdtempSync(join(process.env.JCODE_SCRATCH_DIR ?? tmpdir(), 'e2e-identity-'));
    roots.push(root);
    const artifacts = [];
    for (const name of ['a', 'b']) {
      const selected = resolveReleaseArtifact({ root, env: { CALLIE_RELEASE_OUT_DIR: name } });
      const input = join(root, `${name}-input`);
      mkdirSync(input);
      writeFileSync(join(input, 'release-marker.json'), JSON.stringify({ format: 'callie-release', version: 1, commitSha: name.repeat(40), builtAt: '2026-09-09T00:00:00.000Z' }));
      mkdirSync(dirname(selected.asarPath), { recursive: true });
      mkdirSync(dirname(selected.executable), { recursive: true });
      writeFileSync(selected.executable, 'synthetic', { mode: 0o700 });
      await createPackage(input, selected.asarPath);
      artifacts.push(selected);
    }
    const [a, b] = artifacts;
    vi.stubEnv('CALLIE_E2E_OUT_DIR', b.outDirectory);
    vi.stubEnv('CALLIE_E2E_EXPECTED_ARTIFACT', JSON.stringify(readArtifactIdentity(a.appPath)));
    vi.resetModules();
    const release = await import('./packagedApplication');
    expect(release.packagedApplicationBinary).toBe(b.executable);
    expect(() => release.assertPackagedApplicationIdentity(b.executable)).toThrow();
    const { createPackagedTestEnvironment } = await import('./packagedTestEnvironment');
    const environment = await createPackagedTestEnvironment();
    try {
      for (const name of ['CALLIE_E2E_EXPECTED_ARTIFACT', 'CALLIE_E2E_OUT_DIR', 'CALLIE_RELEASE_OUT_DIR']) expect(environment.env[name]).toBeUndefined();
      await expect(createPackagedTestEnvironment({ CALLIE_E2E_EXPECTED_ARTIFACT: '{}' })).rejects.toThrow('Unknown packaged test environment override');
    } finally { await environment.cleanup(); }
    vi.stubEnv('CALLIE_E2E_EXPECTED_ARTIFACT', undefined);
    vi.resetModules();
    const standalone = await import('./packagedApplication');
    expect(() => standalone.assertPackagedApplicationIdentity(b.executable)).not.toThrow();
    expect(() => standalone.assertPackagedApplicationIdentity(a.executable)).toThrow();
  });
});
