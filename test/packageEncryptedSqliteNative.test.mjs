import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
  const buildSources = join(root, 'deps/sqlite3/sqlite3.c');
  for (const path of [selected, nodeAbi, scratch, buildSources]) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'synthetic native fixture');
  }
  return { buildPath, root, selected, nodeAbi, scratch, buildSources };
}

describe('packaged encrypted SQLite artifacts', () => {
  it('removes build-only dependency sources while preserving runtime code, metadata and license bytes', async () => {
    const files = await fixture();
    const retained = {
      'lib/index.js': "module.exports = require('./database');\n",
      'lib/database.js': '// runtime JavaScript fixture\n',
      'package.json': '{"main":"lib/index.js"}\n',
      LICENSE: 'Retained upstream copyright and license fixture\n',
    };
    for (const [name, content] of Object.entries(retained)) {
      await mkdir(dirname(join(files.root, name)), { recursive: true });
      await writeFile(join(files.root, name), content);
    }
    await retainOnlyPackagedEncryptedSqliteRuntime({
      buildPath: files.buildPath, platform: 'darwin', arch: 'arm64',
      probeNative: () => ({ modules: '149', cipherVersion: 'synthetic' }),
    });
    expect(existsSync(join(files.root, 'deps'))).toBe(false);
    expect(await readFile(files.selected, 'utf8')).toBe('synthetic native fixture');
    for (const [name, content] of Object.entries(retained)) {
      expect(await readFile(join(files.root, name), 'utf8')).toBe(content);
    }
  });

  it('retains exactly the Electron ABI target in the generated build copy', async () => {
    const files = await fixture();
    await retainOnlyPackagedEncryptedSqliteRuntime({
      buildPath: files.buildPath,
      platform: 'darwin',
      arch: 'arm64',
      probeNative: () => ({ modules: '149', cipherVersion: 'synthetic' }),
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
      probeNative: () => ({ modules: '149', cipherVersion: 'synthetic' }),
    })).rejects.toThrow();
    expect(existsSync(files.nodeAbi)).toBe(true);
    expect(existsSync(files.scratch)).toBe(true);
    expect(existsSync(files.buildSources)).toBe(true);
  });

  it('rejects a Node ABI binary renamed as ABI 149 before stripping any copy', async () => {
    const files = await fixture();
    const nodeAbiBinary = join(
      process.cwd(),
      'node_modules/better-sqlite3-multiple-ciphers/bin/darwin-arm64-137/better-sqlite3-multiple-ciphers.node',
    );
    await copyFile(nodeAbiBinary, files.selected);

    await expect(retainOnlyPackagedEncryptedSqliteRuntime({
      buildPath: files.buildPath,
      platform: 'darwin',
      arch: 'arm64',
    })).rejects.toThrow(/ABI 149|native probe/i);
    expect(existsSync(files.nodeAbi)).toBe(true);
    expect(existsSync(files.scratch)).toBe(true);
    expect(existsSync(files.buildSources)).toBe(true);
  });
});
