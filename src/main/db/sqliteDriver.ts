import { existsSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';

import Database from 'better-sqlite3-multiple-ciphers';

export { encryptedDriverDecision } from './sqliteDriverDecision';

export type RawDatabase = Database.Database;

export type RawDatabaseOpenOptions = {
  readonly?: boolean;
  fileMustExist?: boolean;
};

const NATIVE_BINARY_NAME = 'better-sqlite3-multiple-ciphers.node';
const SUPPORTED_RUNTIME_TARGETS = new Set([
  'darwin-arm64-137',
  'darwin-arm64-149',
]);

export function createRawDatabase(
  path: string,
  options: RawDatabaseOpenOptions = {},
): RawDatabase {
  return new Database(path, {
    ...options,
    nativeBinding: resolveNativeBinding(),
  });
}

export function applyWorkspaceKey(database: RawDatabase, key: Buffer): void {
  if (key.byteLength !== 32) {
    throw new RangeError('Workspace key must contain 32 bytes.');
  }

  const keyHex = key.toString('hex');
  database.pragma("cipher='sqlcipher'");
  database.pragma('legacy=4');
  database.pragma(`key="x'${keyHex}'"`);
  database.prepare('SELECT count(*) FROM sqlite_master').get();
}

export function resolveNativeBinding(): string {
  const packageJsonPath = require.resolve(
    'better-sqlite3-multiple-ciphers/package.json',
  );
  const sourcePackageRoot = dirname(packageJsonPath);
  const packageRoot = sourcePackageRoot.replace(
    `${sep}app.asar${sep}`,
    `${sep}app.asar.unpacked${sep}`,
  );
  return resolveNativeBindingForRuntime({
    packageRoot,
    platform: process.platform,
    arch: process.arch,
    modules: process.versions.modules,
    exists: existsSync,
  });
}

export function resolveNativeBindingForRuntime(input: {
  packageRoot: string;
  platform: string;
  arch: string;
  modules: string;
  exists(path: string): boolean;
}): string {
  const runtimeTarget = `${input.platform}-${input.arch}-${input.modules}`;
  if (!SUPPORTED_RUNTIME_TARGETS.has(runtimeTarget)) {
    throw new Error('The encrypted SQLite native runtime is unsupported.');
  }
  const binaryPath = join(
    input.packageRoot,
    'bin',
    runtimeTarget,
    NATIVE_BINARY_NAME,
  );

  if (!input.exists(binaryPath)) {
    throw new Error('The encrypted SQLite native runtime is unavailable.');
  }

  return binaryPath;
}
