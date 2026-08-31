import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { retainOnlyPackagedEncryptedSqliteRuntime } from '../scripts/packageEncryptedSqliteNative.mjs';

const directories = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const buildPath = await mkdtemp(join(tmpdir(), 'callie-native-package-'));
  directories.push(buildPath);
  const root = join(
    buildPath,
    'node_modules',
    'better-sqlite3-multiple-ciphers',
  );
  const selected = join(
    root,
    'bin/darwin-arm64-149/better-sqlite3-multiple-ciphers.node',
  );
  const nodeAbi = join(
    root,
    'bin/darwin-arm64-137/better-sqlite3-multiple-ciphers.node',
  );
  const scratch = join(root, 'build/Release/better_sqlite3.node');
  for (const path of [selected, nodeAbi, scratch]) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'synthetic native fixture');
  }
  return { buildPath, selected, nodeAbi, scratch };
}

describe('packaged encrypted SQLite artifacts', () => {
  it('retains exactly the Electron ABI target in the generated build copy', async () => {
    const files = await fixture();
    await retainOnlyPackagedEncryptedSqliteRuntime({
      buildPath: files.buildPath,
      platform: 'darwin',
      arch: 'arm64',
    });
    expect(existsSync(files.selected)).toBe(true);
    expect(existsSync(files.nodeAbi)).toBe(false);
    expect(existsSync(files.scratch)).toBe(false);
  });

  it('fails before deleting anything when the exact Electron ABI target is missing', async () => {
    const files = await fixture();
    await rm(files.selected);
    await expect(retainOnlyPackagedEncryptedSqliteRuntime({
      buildPath: files.buildPath,
      platform: 'darwin',
      arch: 'arm64',
    })).rejects.toThrow();
    expect(existsSync(files.nodeAbi)).toBe(true);
    expect(existsSync(files.scratch)).toBe(true);
  });
});
