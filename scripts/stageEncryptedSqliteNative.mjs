import { copyFileSync, lstatSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runEncryptedSqliteNativeProbe } from './runEncryptedSqliteNativeProbe.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(scriptDirectory, '..');
const require = createRequire(import.meta.url);
const defaultPackageRoot = dirname(
  require.resolve('better-sqlite3-multiple-ciphers/package.json'),
);
const binaryName = 'better-sqlite3-multiple-ciphers.node';

export function stageEncryptedSqliteNative({
  mode,
  packageRoot = defaultPackageRoot,
  platform = process.platform,
  arch = process.arch,
  nodeModules = process.versions.modules,
  nodeExecutable = process.execPath,
  electronExecutable = join(
    projectRoot,
    'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
  ),
  probeNative = runEncryptedSqliteNativeProbe,
}) {
  if (platform !== 'darwin' || arch !== 'arm64') {
    throw new Error('Encrypted SQLite native staging supports Darwin arm64 only.');
  }
  const runtimes = {
    node: {
      abi: '137',
      executable: nodeExecutable,
      environment: {},
    },
    electron: {
      abi: '149',
      executable: electronExecutable,
      environment: { ELECTRON_RUN_AS_NODE: '1' },
    },
  };
  const runtime = runtimes[mode];
  if (runtime === undefined) {
    throw new Error('Native staging mode must be node or electron.');
  }
  if (mode === 'node' && nodeModules !== runtime.abi) {
    throw new Error(
      `Node native staging requires ABI ${runtime.abi}; found ${nodeModules}.`,
    );
  }

  const scratch = join(packageRoot, 'build/Release/better_sqlite3.node');
  let scratchMetadata;
  try {
    scratchMetadata = lstatSync(scratch);
  } catch {
    throw new Error(`${mode} ABI scratch native binary is missing.`);
  }
  if (!scratchMetadata.isFile() || scratchMetadata.isSymbolicLink()) {
    throw new Error(`${mode} ABI scratch native binary is invalid.`);
  }
  const destination = join(
    packageRoot,
    'bin',
    `darwin-arm64-${runtime.abi}`,
    binaryName,
  );
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(scratch, destination);

  return probeNative({
    executable: runtime.executable,
    nativeBinary: destination,
    expectedAbi: runtime.abi,
    environment: runtime.environment,
    probeScript: join(scriptDirectory, 'probeEncryptedSqliteNative.cjs'),
  });
}

if (process.argv[1] === scriptPath) {
  stageEncryptedSqliteNative({ mode: process.argv[2] });
}
