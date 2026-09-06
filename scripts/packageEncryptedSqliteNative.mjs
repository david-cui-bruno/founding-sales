import { lstat, readdir, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runEncryptedSqliteNativeProbe } from './runEncryptedSqliteNativeProbe.mjs';

const packageName = 'better-sqlite3-multiple-ciphers';
const runtimeDirectoryName = 'darwin-arm64-149';
const binaryName = 'better-sqlite3-multiple-ciphers.node';
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const electronExecutable = join(
  scriptDirectory,
  '../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
);

export async function retainOnlyPackagedEncryptedSqliteRuntime({
  buildPath,
  platform,
  arch,
  probeNative = runEncryptedSqliteNativeProbe,
}) {
  if (platform !== 'darwin' || arch !== 'arm64') return;
  if (!isAbsolute(buildPath)) {
    throw new Error('Packaged build path must be absolute.');
  }

  const packageRoot = join(buildPath, 'node_modules', packageName);
  const runtimeDirectory = join(packageRoot, 'bin', runtimeDirectoryName);
  const runtimeBinary = join(runtimeDirectory, binaryName);
  const metadata = await lstat(runtimeBinary);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error('Exact packaged encrypted SQLite native binary is invalid.');
  }

  await probeNative({
    executable: electronExecutable,
    nativeBinary: runtimeBinary,
    expectedAbi: '149',
    environment: { ELECTRON_RUN_AS_NODE: '1' },
    probeScript: join(scriptDirectory, 'probeEncryptedSqliteNative.cjs'),
  });

  const binDirectory = join(packageRoot, 'bin');
  for (const entry of await readdir(binDirectory, { withFileTypes: true })) {
    if (entry.name !== runtimeDirectoryName) {
      await rm(join(binDirectory, entry.name), { recursive: true, force: true });
    }
  }
  for (const entry of await readdir(runtimeDirectory, { withFileTypes: true })) {
    if (entry.name !== binaryName) {
      await rm(join(runtimeDirectory, entry.name), { recursive: true, force: true });
    }
  }
  await rm(join(packageRoot, 'build'), { recursive: true, force: true });
  // Compiler inputs are not runtime dependencies. Keep lib, package metadata,
  // the upstream LICENSE and the verified native binary in the packaged copy.
  await rm(join(packageRoot, 'deps'), { recursive: true, force: true });

  const nativeFiles = await listNativeFiles(packageRoot);
  if (nativeFiles.length !== 1 || nativeFiles[0] !== runtimeBinary) {
    throw new Error('Packaged encrypted SQLite native artifact set is ambiguous.');
  }
}

async function listNativeFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listNativeFiles(path));
    } else if (entry.isFile() && path.endsWith('.node')) {
      files.push(path);
    }
  }
  return files.sort();
}
