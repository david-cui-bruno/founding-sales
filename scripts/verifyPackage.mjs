import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { verifyAppleBridgePackage } from './verifyAppleBridgePackage.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, '..');
const asarCli = join(projectRoot, 'node_modules', '@electron', 'asar', 'bin', 'asar.js');
const fusesCli = join(projectRoot, 'node_modules', '@electron', 'fuses', 'dist', 'bin.js');

const requiredFuses = {
  RunAsNode: 'Disabled',
  EnableCookieEncryption: 'Enabled',
  EnableNodeOptionsEnvironmentVariable: 'Disabled',
  EnableNodeCliInspectArguments: 'Disabled',
  EnableEmbeddedAsarIntegrityValidation: 'Enabled',
  OnlyLoadAppFromAsar: 'Enabled',
  LoadBrowserProcessSpecificV8Snapshot: 'Disabled',
  GrantFileProtocolExtraPrivileges: 'Disabled',
  WasmTrapHandlers: 'Enabled',
};

const COMMAND_OPTIONS = {
  encoding: 'utf8',
  env: {
    LANG: 'C',
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  },
  maxBuffer: 65_536,
  timeout: 5_000,
};

export class PackageVerificationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PackageVerificationError';
  }
}

const fail = (message) => {
  throw new PackageVerificationError(`PACKAGE: ${message}`);
};

const assertFile = (path, description) => {
  if (!existsSync(path) || !statSync(path).isFile()) {
    fail(`${description} is missing: ${path}`);
  }
};

const assertDirectory = (path, description) => {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    fail(`${description} is missing: ${path}`);
  }
};

const walkDirectories = (directory) => {
  const directories = [directory];
  const entries = readdirSync(directory, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      directories.push(...walkDirectories(join(directory, entry.name)));
    }
  }

  return directories;
};

const walkFiles = (directory) => {
  const files = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }

  return files;
};

const isPackagedApplication = (directory) =>
  directory.endsWith('.app') &&
  existsSync(join(directory, 'Contents', 'Resources', 'app.asar'));

export const selectPackagedApp = (outDirectory) => {
  if (!existsSync(outDirectory)) {
    fail(`packaged output directory is missing: ${outDirectory}. Run npm run package first.`);
  }

  const candidates = walkDirectories(outDirectory)
    .filter(isPackagedApplication)
    .sort();

  if (candidates.length !== 1) {
    fail(
      `expected exactly one packaged app containing Resources/app.asar under ${outDirectory}; found ${candidates.length}${
        candidates.length === 0 ? '' : `: ${candidates.join(', ')}`
      }`,
    );
  }

  return candidates[0];
};

export const createPackageCommandRunner = (
  runExecutable = spawnSync,
) => ({ command, args, includeStderr = false, input }) => {
  const commandArgs =
    command === 'asar'
      ? [asarCli, 'list', args[0]]
      : command === 'electron-fuses'
        ? [fusesCli, 'read', '--app', args[0]]
        : args;
  const executable =
    command === 'asar' || command === 'electron-fuses' ? process.execPath : command;

  const result = runExecutable(executable, commandArgs, {
    ...COMMAND_OPTIONS,
    ...(input === undefined ? {} : { input }),
    shell: false,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  if (typeof result === 'string' || Buffer.isBuffer(result)) {
    return String(result).trim();
  }
  if (result.error !== undefined) {
    const detail = result.error instanceof Error
      ? result.error.message
      : String(result.error);
    fail(`could not run ${command}: ${detail}`);
  }
  if (result.status !== 0) {
    const detail = String(result.stderr ?? '').trim();
    fail(
      `could not run ${command}: exited with status ${result.status ?? 'none'}${detail.length === 0 ? '' : `: ${detail}`}`,
    );
  }
  const stdout = String(result.stdout ?? '');
  const stderr = String(result.stderr ?? '');
  return (includeStderr ? `${stdout}\n${stderr}` : stdout).trim();
};

const defaultRunCommand = createPackageCommandRunner();

const runOrFail = (runCommand, command, args, purpose) => {
  try {
    return runCommand({ command, args });
  } catch (error) {
    if (error instanceof PackageVerificationError) {
      throw error;
    }

    const detail = error instanceof Error ? error.message : String(error);
    fail(`could not ${purpose}: ${detail}`);
  }
};

const requireArm64MachO = (description, path, runCommand) => {
  const fileDescription = runOrFail(
    runCommand,
    'file',
    ['-b', path],
    `inspect ${description} architecture`,
  );

  if (!/Mach-O/.test(fileDescription) || !/(^|[^a-z0-9])arm64([^a-z0-9]|$)/i.test(fileDescription)) {
    fail(`${description} is not Darwin arm64: ${path} (${fileDescription})`);
  }

  return fileDescription;
};

const readPlistField = (plistPath, key, runCommand) => {
  const value = runOrFail(
    runCommand,
    'plutil',
    ['-extract', key, 'raw', '-o', '-', plistPath],
    `read Info.plist field ${key}`,
  ).trim();

  if (value.length === 0) {
    fail(`Info.plist field ${key} is empty: ${plistPath}`);
  }

  return value;
};

const isBetterSqliteArtifact = (unpackedDirectory, path) =>
  relative(unpackedDirectory, path)
    .split(sep)
    .includes('better-sqlite3');

const listBetterSqliteNativeCandidates = (unpackedDirectory) =>
  walkFiles(unpackedDirectory)
    .filter((path) => path.endsWith('.node'))
    .filter((path) => isBetterSqliteArtifact(unpackedDirectory, path))
    .sort();

const expectedBetterSqlitePackageRoot = (unpackedDirectory) => {
  const packageRoot = join(unpackedDirectory, 'node_modules', 'better-sqlite3');
  if (!existsSync(packageRoot) || !statSync(packageRoot).isDirectory()) {
    const nativeCandidates = listBetterSqliteNativeCandidates(unpackedDirectory);
    fail(
      `packaged better-sqlite3 module root is missing: ${packageRoot}. Native candidates: ${nativeCandidates.join(', ') || 'none'}`,
    );
  }

  return packageRoot;
};

const selectBetterSqliteLoaderTarget = (unpackedDirectory) => {
  const packageRoot = expectedBetterSqlitePackageRoot(unpackedDirectory);
  const prebuildTarget = join(packageRoot, 'prebuilds', 'darwin-arm64.node');
  const debugFallback = join(packageRoot, 'build', 'Debug', 'better_sqlite3.node');
  const releaseFallback = join(packageRoot, 'build', 'Release', 'better_sqlite3.node');

  if (existsSync(prebuildTarget)) {
    return prebuildTarget;
  }

  if (existsSync(debugFallback)) {
    return debugFallback;
  }

  if (existsSync(releaseFallback)) {
    return releaseFallback;
  }

  const nativeCandidates = listBetterSqliteNativeCandidates(unpackedDirectory);
  fail(
    `better-sqlite3 native binary is missing from Resources/app.asar.unpacked; selected Darwin arm64 loader target is absent: ${prebuildTarget}. Loader fallbacks checked: ${debugFallback}, ${releaseFallback}. Native candidates: ${nativeCandidates.join(', ') || 'none'}`,
  );
};

const resolvePackagedExecutable = (contentsPath, executableName) => {
  const macosPath = join(contentsPath, 'MacOS');
  const unsafeExecutableName =
    executableName === '.' ||
    executableName === '..' ||
    executableName.includes('/') ||
    executableName.includes('\\') ||
    isAbsolute(executableName) ||
    basename(executableName) !== executableName;
  if (unsafeExecutableName) {
    fail(
      `Info.plist field CFBundleExecutable must be a single executable filename: ${executableName}`,
    );
  }

  const executablePath = resolve(macosPath, executableName);
  const pathWithinMacOs = relative(macosPath, executablePath);
  if (
    pathWithinMacOs === '' ||
    pathWithinMacOs === '..' ||
    pathWithinMacOs.startsWith(`..${sep}`) ||
    isAbsolute(pathWithinMacOs)
  ) {
    fail(
      `Info.plist field CFBundleExecutable escapes Contents/MacOS: ${executableName}`,
    );
  }

  return executablePath;
};

const assertExecutable = (executablePath) => {
  const executableMode = statSync(executablePath).mode;
  if ((executableMode & 0o100) === 0) {
    fail(`packaged executable is not executable: ${executablePath}`);
  }

  try {
    accessSync(executablePath, constants.X_OK);
  } catch {
    fail(`packaged executable is not executable: ${executablePath}`);
  }
};

const verifyRendererResources = (asarPath, runCommand, asarCommand) => {
  const entries = runOrFail(
    runCommand,
    asarCommand,
    [asarPath],
    'list bundled renderer resources',
  ).split('\n');

  const hasPreload = entries.some((entry) => /\/\.vite\/build\/preload\.js$/.test(entry));
  const hasRendererHtml = entries.some((entry) =>
    /\/\.vite\/renderer\/[^/]+\/index\.html$/.test(entry),
  );
  const hasRendererScript = entries.some((entry) =>
    /\/\.vite\/renderer\/[^/]+\/assets\/[^/]+\.js$/.test(entry),
  );

  if (!hasPreload || !hasRendererHtml || !hasRendererScript) {
    fail(
      `bundled renderer resources are incomplete in app.asar (preload=${hasPreload}, html=${hasRendererHtml}, script=${hasRendererScript})`,
    );
  }
};

const verifySecurityFuses = (appPath, runCommand, fusesCommand) => {
  const fuseOutput = runOrFail(
    runCommand,
    fusesCommand,
    [appPath],
    'read packaged Electron security fuses',
  );

  if (!fuseOutput.split(/\r?\n/).some((line) => line.trim() === 'Fuse Version: v1')) {
    fail('expected Electron Fuse Version v1');
  }

  const fuseStates = {};
  const knownStates = new Set(['Enabled', 'Disabled', 'Inherited', 'Removed']);
  for (const line of fuseOutput.split(/\r?\n/)) {
    const match = line.trim().match(/^(\S+) is (.+)$/);
    if (match === null) {
      continue;
    }

    const [, name, state] = match;
    if (!knownStates.has(state)) {
      fail(
        `Electron fuse enumeration contains unknown state for ${name}: ${state}`,
      );
    }
    if (!(name in requiredFuses)) {
      fail(`Electron fuse enumeration contains unknown fuse name: ${name}`);
    }
    if (name in fuseStates) {
      fail(`Electron fuse enumeration contains duplicate state for ${name}`);
    }
    fuseStates[name] = state;
  }

  for (const name of Object.keys(requiredFuses)) {
    if (!(name in fuseStates)) {
      fail(`Electron fuse enumeration is missing required fuse: ${name}`);
    }
  }

  for (const [name, requiredState] of Object.entries(requiredFuses)) {
    if (fuseStates[name] !== requiredState) {
      fail(`required security fuse is not configured: ${name} is ${requiredState}`);
    }
  }

  return fuseStates;
};

export const verifyPackagedApp = (
  appPath,
  {
    runCommand = defaultRunCommand,
    asarCommand = 'asar',
    fusesCommand = 'electron-fuses',
  } = {},
) => {
  assertDirectory(appPath, 'packaged app bundle');

  const contentsPath = join(appPath, 'Contents');
  assertDirectory(contentsPath, 'app Contents directory');
  const resourcesPath = join(contentsPath, 'Resources');
  assertDirectory(resourcesPath, 'app Resources directory');
  const plistPath = join(contentsPath, 'Info.plist');
  assertFile(plistPath, 'Info.plist');
  const asarPath = join(resourcesPath, 'app.asar');
  assertFile(asarPath, 'app.asar');

  const executableName = readPlistField(plistPath, 'CFBundleExecutable', runCommand);
  const executablePath = resolvePackagedExecutable(contentsPath, executableName);
  assertFile(executablePath, 'packaged executable');
  assertExecutable(executablePath);
  const executableArchitecture = requireArm64MachO(
    'packaged executable',
    executablePath,
    runCommand,
  );

  const unpackedDirectory = join(resourcesPath, 'app.asar.unpacked');
  assertDirectory(unpackedDirectory, 'ASAR unpacked resources directory');
  const nativeBinary = selectBetterSqliteLoaderTarget(unpackedDirectory);
  const nativeArchitecture = requireArm64MachO(
    'better-sqlite3 native binary',
    nativeBinary,
    runCommand,
  );

  const atsAllowsArbitraryLoads = readPlistField(
    plistPath,
    'NSAppTransportSecurity.NSAllowsArbitraryLoads',
    runCommand,
  );
  if (atsAllowsArbitraryLoads !== 'false') {
    fail(
      `Info.plist must set NSAppTransportSecurity.NSAllowsArbitraryLoads to false; found ${atsAllowsArbitraryLoads}`,
    );
  }

  const bundle = {
    identifier: readPlistField(plistPath, 'CFBundleIdentifier', runCommand),
    displayName: readPlistField(plistPath, 'CFBundleDisplayName', runCommand),
    version: readPlistField(plistPath, 'CFBundleShortVersionString', runCommand),
    atsAllowsArbitraryLoads: false,
  };

  verifyRendererResources(asarPath, runCommand, asarCommand);
  const fuses = verifySecurityFuses(appPath, runCommand, fusesCommand);
  runOrFail(
    runCommand,
    'codesign',
    ['--verify', '--deep', '--strict', '--verbose=2', appPath],
    'verify final macOS code signature',
  );
  const appleBridge = verifyAppleBridgePackage(appPath, { runCommand });

  return {
    appPath,
    executable: executablePath,
    executableArchitecture,
    nativeBinary,
    nativeArchitecture,
    bundle,
    fuses,
    appleBridge,
  };
};

const main = () => {
  const outDirectory = resolve(projectRoot, process.argv[2] ?? 'out');
  const appPath = selectPackagedApp(outDirectory);
  const report = verifyPackagedApp(appPath);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
