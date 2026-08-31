import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(scriptDirectory, '..');
const packageRoot = dirname(
  fileURLToPath(import.meta.resolve(
    'better-sqlite3-multiple-ciphers/package.json',
  )),
);
const binaryName = 'better-sqlite3-multiple-ciphers.node';
const mode = process.argv[2];

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('Encrypted SQLite native staging supports Darwin arm64 only.');
}

const runtimes = {
  node: {
    abi: '137',
    executable: process.execPath,
    environment: process.env,
  },
  electron: {
    abi: '149',
    executable: join(projectRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
    environment: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  },
};
const runtime = runtimes[mode];
if (runtime === undefined) {
  throw new Error('Native staging mode must be node or electron.');
}
if (mode === 'node' && process.versions.modules !== runtime.abi) {
  throw new Error(
    `Node native staging requires ABI ${runtime.abi}; found ${process.versions.modules}.`,
  );
}

const destination = join(
  packageRoot,
  'bin',
  `darwin-arm64-${runtime.abi}`,
  binaryName,
);
if (mode === 'node') {
  const scratch = join(packageRoot, 'build/Release/better_sqlite3.node');
  if (!existsSync(scratch)) {
    throw new Error('Node ABI scratch native binary is missing.');
  }
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(scratch, destination);
}
if (!existsSync(destination)) {
  throw new Error(`Staged encrypted SQLite ABI ${runtime.abi} binary is missing.`);
}

const probe = spawnSync(runtime.executable, [
  join(scriptDirectory, 'probeEncryptedSqliteNative.cjs'),
  destination,
], {
  cwd: projectRoot,
  encoding: 'utf8',
  env: runtime.environment,
  timeout: 30_000,
});
if (probe.status !== 0 || probe.signal !== null) {
  throw new Error(
    `Encrypted SQLite ABI ${runtime.abi} probe failed: ${probe.stderr || probe.signal || probe.status}`,
  );
}
