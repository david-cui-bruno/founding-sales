import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
it('builds backup tools separately without widening the three-input read-only tools graph', () => {
  const result = spawnSync(process.execPath, ['scripts/buildOperationalTools.mjs'], { encoding: 'utf8' }); expect(result.status).toBe(0);
  const audit = JSON.parse(readFileSync('build/generated/operational-tools/inputs.json'));
  expect(audit).toEqual(['src/main/db/readOnlyEncryptedDatabase.ts', 'src/main/db/sqliteDriver.ts', 'src/main/db/sqliteDriverDecision.ts']);
  const backup = JSON.parse(readFileSync('build/generated/pre-release-tools/inputs.json'));
  expect(backup).toContain('src/main/backup/preReleaseBackupRuntime.ts'); expect(backup).toContain('src/main/backup/backupService.ts');
  expect(backup.some(path => /(?:migrations\/|\/migrate\.ts|startApplication|recoveryService|sourcing\/)/.test(path))).toBe(false);
  expect(readFileSync('build/generated/pre-release-tools/preReleaseBackupRuntime.cjs', 'utf8')).toContain('runPreReleaseBackupHost');
});
it.each(['', 'candidate-output'])('composes marker hooks with encrypted-native copy and existing helper/fuse/signature hooks with output %s', async candidate => {
  vi.stubEnv('CALLIE_RELEASE_OUT_DIR', candidate);
  vi.stubEnv('CALLIE_E2E_OUT_DIR', undefined);
  vi.resetModules();
  const events = [];
  const hooks = { generateAssets: async () => events.push('helper-assets'), packageAfterCopy: async () => events.push('helper-fuses'), postPackage: async () => events.push('signature-repair') };
  vi.doMock('../build/signingIdentity', () => ({ resolveMacSigningIdentity: () => undefined }));
  vi.doMock('../build/appleBridge', () => ({ createAppleBridgeForgeHooks: () => hooks, createAppleBridgeSigningOptions: () => undefined }));
  vi.doMock('../scripts/writeReleaseMarker.mjs', () => ({ createReleaseAssembly: () => ({ begin: () => events.push('begin'), copy: () => events.push('marker-copy'), finish: () => events.push('finish') }) }));
  vi.doMock('../scripts/packageEncryptedSqliteNative.mjs', () => ({ retainOnlyPackagedEncryptedSqliteRuntime: async () => events.push('native-copy') }));
  try {
    const { default: config } = await import('../forge.config.ts');
    expect(config.outDir).toBe(resolve(candidate || 'out'));
    await config.hooks.generateAssets(); await config.hooks.prePackage();
    await new Promise((resolve, reject) => config.packagerConfig.afterCopy[0]('fixture', '44', 'darwin', 'arm64', error => error ? reject(error) : resolve()));
    await config.hooks.packageAfterCopy(); await config.hooks.postPackage();
    expect(events).toEqual(['helper-assets', 'begin', 'native-copy', 'marker-copy', 'helper-fuses', 'signature-repair', 'finish']);
  } finally { for (const module of ['../build/signingIdentity', '../build/appleBridge', '../scripts/writeReleaseMarker.mjs', '../scripts/packageEncryptedSqliteNative.mjs']) vi.doUnmock(module); vi.resetModules(); vi.unstubAllEnvs(); }
});
