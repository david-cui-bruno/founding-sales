import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { stageEncryptedSqliteNative } from '../scripts/stageEncryptedSqliteNative.mjs';

const directories = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })));
});

describe('encrypted SQLite native staging', () => {
  it('copies fresh Electron rebuild scratch into an initially empty ABI-149 bin', async () => {
    const packageRoot = await mkdtemp(join(tmpdir(), 'callie-native-stage-'));
    directories.push(packageRoot);
    const scratch = join(packageRoot, 'build/Release/better_sqlite3.node');
    const destination = join(
      packageRoot,
      'bin/darwin-arm64-149/better-sqlite3-multiple-ciphers.node',
    );
    await mkdir(dirname(scratch), { recursive: true });
    await writeFile(scratch, 'synthetic electron ABI rebuild');
    const probeNative = vi.fn(() => ({
      modules: '149',
      cipherVersion: 'synthetic',
    }));

    stageEncryptedSqliteNative({
      mode: 'electron',
      packageRoot,
      platform: 'darwin',
      arch: 'arm64',
      nodeModules: '137',
      electronExecutable: '/synthetic/Electron',
      nodeExecutable: '/synthetic/node',
      probeNative,
    });

    expect(existsSync(destination)).toBe(true);
    expect(await readFile(destination, 'utf8'))
      .toBe('synthetic electron ABI rebuild');
    expect(probeNative).toHaveBeenCalledWith(expect.objectContaining({
      expectedAbi: '149',
      nativeBinary: destination,
    }));
  });
});
