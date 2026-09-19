import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFile } from '@electron/asar';
import { selectPackagedApp } from '../../scripts/verifyPackage.mjs';
import { expectedAppleBridge } from '../../scripts/verifyAppleBridgePackage.mjs';
import { assertCleanHead, readReleaseMarker, validateReleaseMarker } from '../../scripts/writeReleaseMarker.mjs';

/**
 * The trimmed package verifier for the thin client (FSS target design, section 7): release marker, the
 * nine Electron fuses, the final code signature, and the Apple bridge helper bundle in place. There is no
 * SQLite probe and no ASAR unpack directory: this package ships no native module. The bundle identifier
 * differs from the old app's, so the helper checks here are the presence, identity, architecture and
 * signature of the helper itself, not the root verifier's parent-identifier relationship.
 */
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const clientRoot = resolve(scriptDirectory, '..');
const fusesCli = join(clientRoot, 'node_modules', '@electron', 'fuses', 'dist', 'bin.js');
const asarCli = join(clientRoot, 'node_modules', '@electron', 'asar', 'bin', 'asar.js');

export const CLIENT_BUNDLE_IDENTIFIER = 'com.callie.client';

// The same states `build/electronFuses.ts` flips for Electron 44; a drift here is a drift in that module.
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
  env: { LANG: 'C', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
  maxBuffer: 65_536,
  timeout: 5_000,
};

export class ClientPackageVerificationError extends Error {
  constructor(message) {
    super(`CLIENT PACKAGE: ${message}`);
    this.name = 'ClientPackageVerificationError';
  }
}
const fail = (message) => { throw new ClientPackageVerificationError(message); };

const assertDirectory = (path, description) => {
  if (!existsSync(path) || !statSync(path).isDirectory()) fail(`${description} is missing: ${path}`);
};
const assertFile = (path, description) => {
  if (!existsSync(path) || !statSync(path).isFile()) fail(`${description} is missing: ${path}`);
};
const assertExecutable = (path, description) => {
  assertFile(path, description);
  if ((statSync(path).mode & 0o100) === 0) fail(`${description} is not executable: ${path}`);
  try { accessSync(path, constants.X_OK); } catch { fail(`${description} is not executable: ${path}`); }
};

/** Fixed system tools and the two Node CLIs, never a shell. */
export const createClientCommandRunner = (runExecutable = spawnSync) => ({ command, args }) => {
  const [executable, commandArgs] =
    command === 'electron-fuses' ? [process.execPath, [fusesCli, 'read', '--app', args[0]]]
      : command === 'asar' ? [process.execPath, [asarCli, 'list', args[0]]]
        : [`/usr/bin/${command}`, args];
  const result = runExecutable(executable, commandArgs, { ...COMMAND_OPTIONS, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error !== undefined) fail(`could not run ${command}: ${result.error instanceof Error ? result.error.message : String(result.error)}`);
  if (result.status !== 0) {
    const detail = String(result.stderr ?? '').trim();
    fail(`could not run ${command}: exited with status ${result.status ?? 'none'}${detail.length === 0 ? '' : `: ${detail}`}`);
  }
  return String(result.stdout ?? '').trim();
};

const readPlistField = (plistPath, key, runCommand) => {
  const value = runCommand({ command: 'plutil', args: ['-extract', key, 'raw', '-o', '-', plistPath] }).trim();
  if (value.length === 0) fail(`Info.plist field ${key} is empty: ${plistPath}`);
  return value;
};

const verifySecurityFuses = (appPath, runCommand) => {
  const output = runCommand({ command: 'electron-fuses', args: [appPath] });
  if (!output.split(/\r?\n/).some((line) => line.trim() === 'Fuse Version: v1')) fail('expected Electron Fuse Version v1');
  const states = {};
  for (const line of output.split(/\r?\n/)) {
    const match = line.trim().match(/^(\S+) is (Enabled|Disabled|Inherited|Removed)$/);
    if (match === null) continue;
    const [, name, state] = match;
    if (!(name in requiredFuses)) fail(`Electron fuse enumeration contains unknown fuse name: ${name}`);
    if (name in states) fail(`Electron fuse enumeration contains duplicate state for ${name}`);
    states[name] = state;
  }
  for (const [name, required] of Object.entries(requiredFuses)) {
    if (states[name] !== required) fail(`required security fuse is not configured: ${name} is ${required}`);
  }
  return states;
};

const verifyRendererResources = (asarPath, runCommand) => {
  const entries = runCommand({ command: 'asar', args: [asarPath] }).split('\n');
  const hasMain = entries.some((entry) => /\/\.vite\/build\/main\.js$/.test(entry));
  const hasPreload = entries.some((entry) => /\/\.vite\/build\/preload\.js$/.test(entry));
  const hasHtml = entries.some((entry) => /\/\.vite\/renderer\/[^/]+\/index\.html$/.test(entry));
  const hasScript = entries.some((entry) => /\/\.vite\/renderer\/[^/]+\/assets\/[^/]+\.js$/.test(entry));
  if (!hasMain || !hasPreload || !hasHtml || !hasScript) {
    fail(`bundled resources are incomplete in app.asar (main=${hasMain}, preload=${hasPreload}, html=${hasHtml}, script=${hasScript})`);
  }
  if (entries.some((entry) => /\.node$/.test(entry))) fail('the thin client must not ship a native module');
};

const verifyAppleBridgeHelper = (appPath, runCommand) => {
  const helperBundle = join(appPath, expectedAppleBridge.relativeBundle);
  assertDirectory(helperBundle, 'Apple bridge helper bundle');
  const executable = join(helperBundle, expectedAppleBridge.executable);
  assertExecutable(executable, 'Apple bridge helper executable');
  const plistPath = join(helperBundle, 'Contents', 'Info.plist');
  assertFile(plistPath, 'Apple bridge helper Info.plist');
  const identifier = readPlistField(plistPath, 'CFBundleIdentifier', runCommand);
  if (identifier !== expectedAppleBridge.bundleIdentifier) fail(`helper bundle identifier is invalid: ${identifier}`);
  const architecture = runCommand({ command: 'file', args: ['-b', executable] });
  if (architecture !== 'Mach-O 64-bit executable arm64') fail(`helper executable must be a thin Darwin arm64 Mach-O; found ${architecture}`);
  runCommand({ command: 'codesign', args: ['--verify', '--strict', '--verbose=4', '--requirement', `=identifier "${expectedAppleBridge.bundleIdentifier}"`, helperBundle] });
  return { bundlePath: helperBundle, executable, bundleIdentifier: identifier, architecture: 'arm64' };
};

/**
 * Whether this build is notarized, stated plainly rather than assumed either way (slice S6). Forge notarizes
 * only when a configuration declares `osxNotarize`; neither the root configuration nor the client's does, so a
 * packaged build is signed and not notarized, and Gatekeeper asks on first launch. The answer is derived from
 * the two configurations at verification time, so adding notarization later changes this report by itself — and
 * when it is declared, the stapled ticket is checked on the bundle instead of being taken on trust.
 */
export const verifyNotarization = (appPath, runCommand, root) => {
  const configured = [join(root, 'forge.config.ts'), resolve(root, '..', 'forge.config.ts')]
    .filter((path) => existsSync(path))
    .some((path) => /(^|[^\w])osxNotarize\s*[:=]/.test(readFileSync(path, 'utf8')));
  if (!configured) {
    return { configured: false, notarized: false,
      reason: 'No Forge configuration declares osxNotarize, so this build is signed and not notarized. Gatekeeper asks once on first launch; open it from Finder with Control-click and Open.' };
  }
  runCommand({ command: 'xcrun', args: ['stapler', 'validate', appPath] });
  return { configured: true, notarized: true, reason: 'A stapled notarization ticket is present and valid.' };
};

export const verifyClientPackage = (appPath, { runCommand = createClientCommandRunner(), root = clientRoot } = {}) => {
  assertDirectory(appPath, 'packaged app bundle');
  const contentsPath = join(appPath, 'Contents');
  const plistPath = join(contentsPath, 'Info.plist');
  assertFile(plistPath, 'Info.plist');
  const asarPath = join(contentsPath, 'Resources', 'app.asar');
  assertFile(asarPath, 'app.asar');

  const releaseMarker = validateReleaseMarker(readReleaseMarker({ root }));
  assertCleanHead({ root, expectedSha: releaseMarker.commitSha });
  const embedded = validateReleaseMarker(JSON.parse(extractFile(asarPath, 'release-marker.json').toString('utf8')));
  if (embedded.commitSha !== releaseMarker.commitSha || embedded.builtAt !== releaseMarker.builtAt) fail('embedded release marker does not match the original clean build');

  const identifier = readPlistField(plistPath, 'CFBundleIdentifier', runCommand);
  if (identifier !== CLIENT_BUNDLE_IDENTIFIER) fail(`bundle identifier is invalid: ${identifier}`);
  const executableName = readPlistField(plistPath, 'CFBundleExecutable', runCommand);
  if (executableName.includes('/') || executableName === '.' || executableName === '..') fail(`CFBundleExecutable must be a single filename: ${executableName}`);
  const executablePath = join(contentsPath, 'MacOS', executableName);
  assertExecutable(executablePath, 'packaged executable');
  const executableArchitecture = runCommand({ command: 'file', args: ['-b', executablePath] });
  if (!/Mach-O/.test(executableArchitecture) || !/(^|[^a-z0-9])arm64([^a-z0-9]|$)/i.test(executableArchitecture)) fail(`packaged executable is not Darwin arm64: ${executableArchitecture}`);
  if (existsSync(join(contentsPath, 'Resources', 'app.asar.unpacked'))) fail('the thin client must not ship an ASAR unpack directory');
  const arbitraryLoads = readPlistField(plistPath, 'NSAppTransportSecurity.NSAllowsArbitraryLoads', runCommand);
  if (arbitraryLoads !== 'false') fail(`Info.plist must set NSAppTransportSecurity.NSAllowsArbitraryLoads to false; found ${arbitraryLoads}`);

  verifyRendererResources(asarPath, runCommand);
  const fuses = verifySecurityFuses(appPath, runCommand);
  runCommand({ command: 'codesign', args: ['--verify', '--deep', '--strict', '--verbose=2', appPath] });
  const appleBridge = verifyAppleBridgeHelper(appPath, runCommand);
  const notarization = verifyNotarization(appPath, runCommand, root);
  assertCleanHead({ root, expectedSha: releaseMarker.commitSha });

  return { appPath, executable: executablePath, executableArchitecture, bundleIdentifier: identifier, fuses, appleBridge,
    notarization, releaseMarker: embedded,
    install: 'Drag the app to /Applications, then open it once from Finder. On first launch it reads its worker endpoint from <userData>/client/worker-endpoint.json; see docs/cutover/INSTALL-CLIENT.md.' };
};

const main = () => {
  const outDirectory = resolve(clientRoot, process.argv[2] ?? 'out');
  const appPath = selectPackagedApp(outDirectory);
  process.stdout.write(`${JSON.stringify(verifyClientPackage(appPath), null, 2)}\n`);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
