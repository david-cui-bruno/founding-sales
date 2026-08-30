import { execFile } from 'node:child_process';
import { chmod, copyFile, cp, mkdir, readFile, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const defaultFileSystem = {
  chmod,
  copyFile,
  cp,
  mkdir,
  readFile,
  rm,
};

const helperBundleName = 'Callie Apple Bridge.app';

const expectedInfoValues = {
  CFBundleIdentifier: 'com.callie.foundersales.applebridge',
  CFBundleExecutable: 'CallieAppleBridge',
  CFBundleVersion: '1',
  CFBundlePackageType: 'APPL',
  LSMinimumSystemVersion: '26.4',
  NSContactsUsageDescription:
    'Callie checks whether a test caller is already in Contacts before deciding whether recording is eligible.',
  NSAppleEventsUsageDescription:
    'Callie uses Apple Events only for founder-confirmed Messages tests and Notes recording export.',
};

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const readPlistString = (plist, key) => {
  const match = plist.match(
    new RegExp(
      `<key>\\s*${escapeRegExp(key)}\\s*</key>\\s*<string>([^<]*)</string>`,
    ),
  );
  return match?.[1];
};

const validateAppleBridgeResources = async (packagePath, fileSystem) => {
  const infoPath = resolve(packagePath, 'Resources/Helper-Info.plist');
  const entitlementsPath = resolve(
    packagePath,
    'Resources/CallieAppleBridge.entitlements',
  );
  const protocolVersionPath = resolve(
    packagePath,
    'Sources/CallieAppleProtocol/ProtocolVersion.swift',
  );
  const [infoPlist, entitlements, protocolVersion] = await Promise.all([
    fileSystem.readFile(infoPath, 'utf8'),
    fileSystem.readFile(entitlementsPath, 'utf8'),
    fileSystem.readFile(protocolVersionPath, 'utf8'),
  ]);

  const nativeVersion = protocolVersion.match(
    /helperVersion\s*=\s*"([^"]+)"/,
  )?.[1];
  if (nativeVersion === undefined) {
    throw new Error('Could not read the native helper version.');
  }
  const bundleVersion = readPlistString(
    infoPlist,
    'CFBundleShortVersionString',
  );
  if (bundleVersion !== nativeVersion) {
    throw new Error(
      `Helper plist version must match native helper version ${nativeVersion}.`,
    );
  }

  for (const [key, expectedValue] of Object.entries(expectedInfoValues)) {
    if (readPlistString(infoPlist, key) !== expectedValue) {
      throw new Error(`Helper Info.plist has an invalid ${key} value.`);
    }
  }
  if (!/<key>\s*LSUIElement\s*<\/key>\s*<true\s*\/>/.test(infoPlist)) {
    throw new Error('Helper Info.plist must make the helper an LSUIElement.');
  }

  const entitlementKeys = [
    ...entitlements.matchAll(/<key>\s*([^<]+?)\s*<\/key>/g),
  ].map((match) => match[1]);
  if (
    entitlementKeys.length !== 1 ||
    entitlementKeys[0] !== 'com.apple.security.automation.apple-events' ||
    !/<key>\s*com\.apple\.security\.automation\.apple-events\s*<\/key>\s*<true\s*\/>/.test(
      entitlements,
    )
  ) {
    throw new Error(
      'Helper entitlements must contain exactly the Apple Events automation entitlement.',
    );
  }
};

const defaultRun = async ({ command, args, cwd }) => {
  await execFileAsync(command, args, { cwd });
};

export const buildAppleBridgeBundle = async ({
  projectRoot,
  platform,
  arch,
  run = defaultRun,
  fileSystem = defaultFileSystem,
}) => {
  if (platform !== 'darwin' || arch !== 'arm64') {
    throw new Error('Callie Apple Bridge packaging requires Darwin arm64.');
  }

  const packagePath = resolve(projectRoot, 'native/apple-bridge');
  await validateAppleBridgeResources(packagePath, fileSystem);
  const bundlePath = resolve(
    projectRoot,
    'build/generated/apple-bridge/Callie Apple Bridge.app',
  );
  const contentsPath = resolve(bundlePath, 'Contents');
  const executablePath = resolve(
    contentsPath,
    'MacOS/CallieAppleBridge',
  );

  await run({
    command: 'swift',
    args: [
      'build',
      '--package-path',
      packagePath,
      '-c',
      'release',
      '--arch',
      arch,
    ],
    cwd: projectRoot,
  });

  await fileSystem.rm(bundlePath, { recursive: true, force: true });
  await fileSystem.mkdir(resolve(contentsPath, 'MacOS'), {
    recursive: true,
    mode: 0o755,
  });
  await fileSystem.copyFile(
    resolve(packagePath, 'Resources/Helper-Info.plist'),
    resolve(contentsPath, 'Info.plist'),
  );
  await fileSystem.copyFile(
    resolve(
      packagePath,
      `.build/${arch}-apple-macosx/release/CallieAppleBridge`,
    ),
    executablePath,
  );
  await fileSystem.chmod(executablePath, 0o755);

  return { bundlePath, executablePath };
};

export const copyAppleBridgeBundle = async (
  buildPath,
  sourceBundle,
  { fileSystem = defaultFileSystem } = {},
) => {
  if (!isAbsolute(buildPath)) {
    throw new Error('Apple helper copy requires an absolute build path.');
  }
  if (!isAbsolute(sourceBundle) || basename(sourceBundle) !== helperBundleName) {
    throw new Error('Apple helper copy requires the expected generated helper bundle.');
  }

  const helpersPath = resolve(buildPath, '../..', 'Helpers');
  const destination = resolve(helpersPath, helperBundleName);
  await fileSystem.rm(destination, { recursive: true, force: true });
  await fileSystem.mkdir(helpersPath, { recursive: true, mode: 0o755 });
  await fileSystem.cp(sourceBundle, destination, {
    recursive: true,
    force: true,
    dereference: false,
  });
  return destination;
};

export const prepareAppleBridgePackage = async ({
  projectRoot,
  buildPath,
  platform,
  arch,
  hasConfiguredMacSigning,
  copyBundle = copyAppleBridgeBundle,
  runCommand = async (command, args) => {
    await execFileAsync(command, args);
  },
}) => {
  if (platform !== 'darwin' || arch !== 'arm64') {
    return undefined;
  }

  const sourceBundle = resolve(
    projectRoot,
    'build/generated/apple-bridge/Callie Apple Bridge.app',
  );
  const destination = await copyBundle(buildPath, sourceBundle);
  if (!hasConfiguredMacSigning) {
    await runCommand('/usr/bin/codesign', [
      '--force',
      '--sign',
      '-',
      '--entitlements',
      resolve(
        projectRoot,
        'native/apple-bridge/Resources/CallieAppleBridge.entitlements',
      ),
      resolve(destination, 'Contents/MacOS/CallieAppleBridge'),
    ]);
  }
  return destination;
};

const main = async () => {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  await buildAppleBridgeBundle({
    projectRoot,
    platform: process.platform,
    arch: process.arch,
  });
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
