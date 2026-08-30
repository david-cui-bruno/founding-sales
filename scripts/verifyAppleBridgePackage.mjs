import { execFileSync } from 'node:child_process';
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
  runExecutable = execFileSync,
) => ({ command, args, input }) => {
  try {
    return runExecutable(command, args, {
      ...COMMAND_OPTIONS,
      ...(input === undefined ? {} : { input }),
      shell: false,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(detail);
  }
};

const defaultRunCommand = createAppleBridgeCommandRunner();

const runOrFail = (runCommand, command, args, purpose, input) => {
  try {
    const output = runCommand({ command, args, input });
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

const readDesignatedRequirement = (path, runCommand) => runOrFail(
  runCommand,
  FIXED_COMMANDS.codesign,
  ['--display', '--requirements', '-', path],
  'reading signing identity',
);

const parseSigningIdentity = (requirement) => {
  if (/^# designated => cdhash H"[0-9a-f]{40}"$/iu.test(requirement)) {
    return { mode: 'adhoc' };
  }

  const teamFromOrganizationalUnit = requirement.match(
    /certificate leaf\[subject\.OU\]\s*=\s*"([A-Z0-9]+)"/u,
  )?.[1];
  const teamFromCommonName = requirement.match(
    /certificate leaf\[subject\.CN\]\s*=\s*"[^"]+\(([A-Z0-9]+)\)"/u,
  )?.[1];
  const teamIdentifier = teamFromOrganizationalUnit ?? teamFromCommonName;
  if (teamIdentifier === undefined || teamIdentifier.length === 0) {
    fail('stable signing identity did not expose a non-empty Team ID');
  }
  return { mode: 'stable', teamIdentifier };
};

const verifySigningRelationship = (appPath, helperBundle, runCommand) => {
  const helperIdentity = parseSigningIdentity(
    readDesignatedRequirement(helperBundle, runCommand),
  );
  const parentIdentity = parseSigningIdentity(
    readDesignatedRequirement(appPath, runCommand),
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
    ['--display', '--entitlements', ':-', helperBundle],
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
