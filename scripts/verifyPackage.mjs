import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve, sep } from 'node:path';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, '..');
const asarCli = join(projectRoot, 'node_modules', '@electron', 'asar', 'bin', 'asar.js');
const fusesCli = join(projectRoot, 'node_modules', '@electron', 'fuses', 'dist', 'bin.js');

const requiredFuses = [
  'RunAsNode is Disabled',
  'EnableCookieEncryption is Enabled',
  'EnableNodeOptionsEnvironmentVariable is Disabled',
  'EnableNodeCliInspectArguments is Disabled',
  'EnableEmbeddedAsarIntegrityValidation is Enabled',
  'OnlyLoadAppFromAsar is Enabled',
];

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

const defaultRunCommand = ({ command, args }) => {
  const commandArgs =
    command === 'asar'
      ? [asarCli, 'list', args[0]]
      : command === 'electron-fuses'
        ? [fusesCli, 'read', '--app', args[0]]
        : args;
  const executable =
    command === 'asar' || command === 'electron-fuses' ? process.execPath : command;

  try {
    return execFileSync(executable, commandArgs, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`could not run ${command}: ${detail}`);
  }
};

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

  for (const requiredFuse of requiredFuses) {
    if (!fuseOutput.includes(requiredFuse)) {
      fail(`required security fuse is not configured: ${requiredFuse}`);
    }
  }
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
  const executablePath = join(contentsPath, 'MacOS', executableName);
  assertFile(executablePath, 'packaged executable');
  if ((statSync(executablePath).mode & 0o111) === 0) {
    fail(`packaged executable is not executable: ${executablePath}`);
  }
  const executableArchitecture = requireArm64MachO(
    'packaged executable',
    executablePath,
    runCommand,
  );

  const unpackedDirectory = join(resourcesPath, 'app.asar.unpacked');
  assertDirectory(unpackedDirectory, 'ASAR unpacked resources directory');
  const nativeCandidates = listBetterSqliteNativeCandidates(unpackedDirectory);
  if (nativeCandidates.length === 0) {
    fail(
      `better-sqlite3 native binary is missing from Resources/app.asar.unpacked: ${unpackedDirectory}`,
    );
  }

  const nativeArtifacts = nativeCandidates.map((path) => ({
    path,
    architecture: runOrFail(
      runCommand,
      'file',
      ['-b', path],
      'inspect better-sqlite3 native binary architecture',
    ),
  }));
  const nativeArtifact = nativeArtifacts.find(
    ({ architecture }) =>
      /Mach-O/.test(architecture) &&
      /(^|[^a-z0-9])arm64([^a-z0-9]|$)/i.test(architecture),
  );
  if (nativeArtifact === undefined) {
    const details = nativeArtifacts
      .map(({ path, architecture }) => `${path} (${architecture})`)
      .join('; ');
    fail(`better-sqlite3 native binary is not Darwin arm64: ${nativeCandidates[0]} (${details})`);
  }

  const bundle = {
    identifier: readPlistField(plistPath, 'CFBundleIdentifier', runCommand),
    displayName: readPlistField(plistPath, 'CFBundleDisplayName', runCommand),
    version: readPlistField(plistPath, 'CFBundleShortVersionString', runCommand),
  };

  verifyRendererResources(asarPath, runCommand, asarCommand);
  verifySecurityFuses(appPath, runCommand, fusesCommand);

  return {
    appPath,
    executable: executablePath,
    executableArchitecture,
    nativeBinary: nativeArtifact.path,
    nativeArchitecture: nativeArtifact.architecture,
    bundle,
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
