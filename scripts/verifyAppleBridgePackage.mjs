import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const FIXED_COMMANDS = {
  codesign: '/usr/bin/codesign',
  file: '/usr/bin/file',
  plutil: '/usr/bin/plutil',
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

export const expectedAppleBridge = Object.freeze({
  relativeBundle: 'Contents/Helpers/Callie Apple Bridge.app',
  executable: 'Contents/MacOS/CallieAppleBridge',
  bundleIdentifier: 'com.callie.foundersales.applebridge',
  parentBundleIdentifier: 'com.callie.foundersales',
  minimumSystemVersion: '26.4',
  requiredEntitlement: 'com.apple.security.automation.apple-events',
});

export class AppleBridgePackageVerificationError extends Error {
  constructor(message) {
    super(`APPLE BRIDGE PACKAGE: ${message}`);
    this.name = 'AppleBridgePackageVerificationError';
  }
}

const fail = (message) => {
  throw new AppleBridgePackageVerificationError(message);
};

export const createAppleBridgeCommandRunner = (
  runExecutable = spawnSync,
) => ({ command, args, includeStderr = false, input }) => {
  const result = runExecutable(command, args, {
    ...COMMAND_OPTIONS,
    ...(input === undefined ? {} : { input }),
    shell: false,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  if (typeof result === 'string' || Buffer.isBuffer(result)) {
    return String(result).trim();
  }
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr ?? '').trim();
    throw new Error(
      `command exited with status ${result.status ?? 'none'}${detail.length === 0 ? '' : `: ${detail}`}`,
    );
  }
  const stdout = String(result.stdout ?? '');
  const stderr = String(result.stderr ?? '');
  return (includeStderr ? `${stdout}\n${stderr}` : stdout).trim();
};

const defaultRunCommand = createAppleBridgeCommandRunner();

const runOrFail = (
  runCommand,
  command,
  args,
  purpose,
  input,
  includeStderr = false,
) => {
  try {
    const output = runCommand({ command, args, includeStderr, input });
    if (typeof output !== 'string') {
      fail(`${purpose} returned a non-text result`);
    }
    return output.trim();
  } catch (error) {
    if (error instanceof AppleBridgePackageVerificationError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    fail(`${purpose} failed: ${detail}`);
  }
};

const assertDirectory = (path, description) => {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    fail(`${description} is missing: ${path}`);
  }
};

const assertExecutable = (path) => {
  if (!existsSync(path) || !statSync(path).isFile()) {
    fail(`helper executable is missing: ${path}`);
  }
  if ((statSync(path).mode & 0o100) === 0) {
    fail(`helper executable is not executable: ${path}`);
  }
  try {
    accessSync(path, constants.X_OK);
  } catch {
    fail(`helper executable is not executable: ${path}`);
  }
};

const readPlistField = (plistPath, key, runCommand) => {
  const value = runOrFail(
    runCommand,
    FIXED_COMMANDS.plutil,
    ['-extract', key, 'raw', '-o', '-', plistPath],
    `reading helper Info.plist field ${key}`,
  );
  if (value.length === 0) {
    fail(`helper Info.plist field ${key} is empty`);
  }
  return value;
};

const verifyExactArchitecture = (executable, runCommand) => {
  const output = runOrFail(
    runCommand,
    FIXED_COMMANDS.file,
    ['-b', executable],
    'inspecting helper architecture',
  );
  if (output !== 'Mach-O 64-bit executable arm64') {
    fail(`helper executable must be a thin Darwin arm64 Mach-O; found ${output}`);
  }
};

const verifyStrictSignatures = (
  appPath,
  helperBundle,
  runCommand,
) => {
  try {
    runCommand({
      command: FIXED_COMMANDS.codesign,
      args: [
        '--verify',
        '--strict',
        '--verbose=4',
        '--requirement',
        `=identifier "${expectedAppleBridge.bundleIdentifier}"`,
        helperBundle,
      ],
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`strict nested signature verification failed: ${detail}`);
  }

  runOrFail(
    runCommand,
    FIXED_COMMANDS.codesign,
    ['--verify', '--strict', '--verbose=4', appPath],
    'strict parent signature verification',
  );
};

const uniqueMetadataField = (metadata, field, { required = true } = {}) => {
  const prefix = `${field}=`;
  const values = metadata
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length));
  if (values.length === 0 && !required) return undefined;
  if (values.length !== 1 || values[0].length === 0) {
    fail(`signature metadata must contain exactly one non-empty ${field}`);
  }
  return values[0];
};

const uniqueSignatureField = (metadata) => {
  const lines = metadata
    .split(/\r?\n/u)
    .filter((line) => /^Signature(?:=| size=)/u.test(line));
  if (lines.length !== 1) {
    fail('signature metadata must contain exactly one authoritative Signature field');
  }
  if (lines[0] === 'Signature=adhoc') return 'adhoc';
  if (/^Signature size=\d+$/u.test(lines[0])) return 'stable';
  fail(`signature metadata contains an invalid Signature field: ${lines[0]}`);
};

const readSigningIdentity = (path, expectedIdentifier, runCommand) => {
  const metadata = runOrFail(
    runCommand,
    FIXED_COMMANDS.codesign,
    ['--display', '--verbose=4', path],
    'reading authoritative signing metadata',
    undefined,
    true,
  );
  const identifier = uniqueMetadataField(metadata, 'Identifier');
  if (identifier !== expectedIdentifier) {
    fail(`signature metadata identifier is invalid: ${identifier}`);
  }
  const teamIdentifier = uniqueMetadataField(metadata, 'TeamIdentifier');
  const signatureMode = uniqueSignatureField(metadata);
  const hasAdhocSignature = signatureMode === 'adhoc';
  const hasNoTeam = teamIdentifier === 'not set';
  if (hasAdhocSignature || hasNoTeam) {
    if (!hasAdhocSignature || !hasNoTeam) {
      fail('ad-hoc signature metadata is inconsistent');
    }
    return { mode: 'adhoc' };
  }
  if (signatureMode !== 'stable' || !/^[A-Z0-9]+$/u.test(teamIdentifier)) {
    fail('stable signing metadata did not expose a valid non-empty Team ID');
  }
  return { mode: 'stable', teamIdentifier };
};

const verifySigningRelationship = (appPath, helperBundle, runCommand) => {
  const helperIdentity = readSigningIdentity(
    helperBundle,
    expectedAppleBridge.bundleIdentifier,
    runCommand,
  );
  const parentIdentity = readSigningIdentity(
    appPath,
    expectedAppleBridge.parentBundleIdentifier,
    runCommand,
  );

  if (helperIdentity.mode !== parentIdentity.mode) {
    fail('parent and helper signature modes do not match');
  }
  if (helperIdentity.mode === 'adhoc') {
    return 'adhoc';
  }
  if (
    parentIdentity.mode !== 'stable'
    || helperIdentity.teamIdentifier !== parentIdentity.teamIdentifier
  ) {
    fail('helper signing Team ID does not match the parent Team ID');
  }
  return 'stable';
};

const verifyEntitlements = (helperBundle, runCommand) => {
  const entitlementsPlist = runOrFail(
    runCommand,
    FIXED_COMMANDS.codesign,
    ['--display', '--xml', '--entitlements', '-', helperBundle],
    'reading helper entitlements',
  );
  const entitlementsJson = runOrFail(
    runCommand,
    FIXED_COMMANDS.plutil,
    ['-convert', 'json', '-o', '-', '--', '-'],
    'parsing helper entitlements',
    entitlementsPlist,
  );

  let entitlements;
  try {
    entitlements = JSON.parse(entitlementsJson);
  } catch {
    fail('helper entitlements were not a valid property list');
  }
  const keys =
    typeof entitlements === 'object' && entitlements !== null
      ? Object.keys(entitlements)
      : [];
  if (
    keys.length !== 1
    || keys[0] !== expectedAppleBridge.requiredEntitlement
    || entitlements[expectedAppleBridge.requiredEntitlement] !== true
  ) {
    fail(
      `helper must contain exactly ${expectedAppleBridge.requiredEntitlement}=true`,
    );
  }
};

export const verifyAppleBridgePackage = (
  appPath,
  { runCommand = defaultRunCommand } = {},
) => {
  assertDirectory(appPath, 'parent app bundle');
  const helperBundle = join(appPath, expectedAppleBridge.relativeBundle);
  assertDirectory(helperBundle, 'nested Apple bridge bundle');
  const executable = join(helperBundle, expectedAppleBridge.executable);
  assertExecutable(executable);
  const plistPath = join(helperBundle, 'Contents', 'Info.plist');
  if (!existsSync(plistPath) || !statSync(plistPath).isFile()) {
    fail(`helper Info.plist is missing: ${plistPath}`);
  }

  const executableName = readPlistField(
    plistPath,
    'CFBundleExecutable',
    runCommand,
  );
  if (executableName !== 'CallieAppleBridge') {
    fail(`helper executable name is invalid: ${executableName}`);
  }
  const bundleIdentifier = readPlistField(
    plistPath,
    'CFBundleIdentifier',
    runCommand,
  );
  if (bundleIdentifier !== expectedAppleBridge.bundleIdentifier) {
    fail(`helper bundle identifier is invalid: ${bundleIdentifier}`);
  }
  const minimumSystemVersion = readPlistField(
    plistPath,
    'LSMinimumSystemVersion',
    runCommand,
  );
  if (minimumSystemVersion !== expectedAppleBridge.minimumSystemVersion) {
    fail(`helper minimum system version is invalid: ${minimumSystemVersion}`);
  }

  verifyExactArchitecture(executable, runCommand);
  verifyStrictSignatures(appPath, helperBundle, runCommand);
  const signatureMode = verifySigningRelationship(
    appPath,
    helperBundle,
    runCommand,
  );
  verifyEntitlements(helperBundle, runCommand);

  return {
    bundlePath: helperBundle,
    executable,
    bundleIdentifier,
    minimumSystemVersion,
    architecture: 'arm64',
    signatureMode,
    automationEntitlement: true,
  };
};
