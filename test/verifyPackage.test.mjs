import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PackageVerificationError,
  selectPackagedApp,
  verifyPackagedApp,
} from '../scripts/verifyPackage.mjs';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

const makeTemporaryDirectory = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'callie-package-verifier-'));
  temporaryDirectories.push(directory);
  return directory;
};

const writeFixtureFile = async (path, contents = '') => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
};

const createPackagedApp = async (outDirectory, appName = 'Callie.app') => {
  const appPath = join(outDirectory, 'darwin-arm64', appName);
  const contentsPath = join(appPath, 'Contents');
  const executablePath = join(contentsPath, 'MacOS', 'Callie');
  const nativePath = join(
    contentsPath,
    'Resources',
    'app.asar.unpacked',
    'node_modules',
    'better-sqlite3',
    'prebuilds',
    'darwin-arm64.node',
  );

  await writeFixtureFile(join(contentsPath, 'Resources', 'app.asar'));
  await writeFixtureFile(join(contentsPath, 'Info.plist'));
  await writeFixtureFile(executablePath);
  await chmod(executablePath, 0o755);
  await writeFixtureFile(nativePath);

  return { appPath, executablePath, nativePath };
};

const successfulCommand = ({ command, args }) => {
  if (command === 'file') {
    return args.at(-1).endsWith('.node')
      ? 'Mach-O 64-bit bundle arm64'
      : 'Mach-O 64-bit executable arm64';
  }

  if (command === 'plutil') {
    const key = args[1];
    return {
      CFBundleExecutable: 'Callie',
      CFBundleIdentifier: 'com.example.callie',
      CFBundleDisplayName: 'Callie',
      CFBundleShortVersionString: '1.2.3',
    }[key];
  }

  if (command === 'asar') {
    return [
      '/.vite/build/preload.js',
      '/.vite/renderer/main_window/index.html',
      '/.vite/renderer/main_window/assets/index.js',
    ].join('\n');
  }

  if (command === 'electron-fuses') {
    return [
      'RunAsNode is Disabled',
      'EnableCookieEncryption is Enabled',
      'EnableNodeOptionsEnvironmentVariable is Disabled',
      'EnableNodeCliInspectArguments is Disabled',
      'EnableEmbeddedAsarIntegrityValidation is Enabled',
      'OnlyLoadAppFromAsar is Enabled',
    ].join('\n');
  }

  throw new Error(`Unexpected command: ${command}`);
};

describe('packaged app selection', () => {
  it('selects the only app bundle that contains the packaged ASAR', async () => {
    const outDirectory = await makeTemporaryDirectory();
    const { appPath } = await createPackagedApp(outDirectory);
    await mkdir(join(appPath, 'Contents', 'Frameworks', 'Helper.app'), {
      recursive: true,
    });

    expect(selectPackagedApp(outDirectory)).toBe(appPath);
  });

  it('rejects multiple packageable app bundles instead of choosing one arbitrarily', async () => {
    const outDirectory = await makeTemporaryDirectory();
    await createPackagedApp(outDirectory, 'Callie One.app');
    await createPackagedApp(outDirectory, 'Callie Two.app');

    expect(() => selectPackagedApp(outDirectory)).toThrow(
      'PACKAGE: expected exactly one packaged app containing Resources/app.asar',
    );
  });
});

describe('package verification', () => {
  it('accepts better-sqlite3 v13 prebuilds/darwin-arm64.node and records it', async () => {
    const outDirectory = await makeTemporaryDirectory();
    const fixture = await createPackagedApp(outDirectory);

    const report = verifyPackagedApp(fixture.appPath, {
      runCommand: successfulCommand,
      asarCommand: 'asar',
      fusesCommand: 'electron-fuses',
    });

    expect(report.nativeBinary).toBe(fixture.nativePath);
    expect(report.executable).toBe(fixture.executablePath);
    expect(report.bundle).toEqual({
      identifier: 'com.example.callie',
      displayName: 'Callie',
      version: '1.2.3',
    });
  });

  it('explains when the better-sqlite3 native binary was not unpacked from ASAR', async () => {
    const outDirectory = await makeTemporaryDirectory();
    const fixture = await createPackagedApp(outDirectory);
    await rm(fixture.nativePath);

    expect(() =>
      verifyPackagedApp(fixture.appPath, {
        runCommand: successfulCommand,
        asarCommand: 'asar',
        fusesCommand: 'electron-fuses',
      }),
    ).toThrow(
      'PACKAGE: better-sqlite3 native binary is missing from Resources/app.asar.unpacked',
    );
  });

  it('reports an arm64-specific diagnostic for a wrong native architecture', async () => {
    const outDirectory = await makeTemporaryDirectory();
    const fixture = await createPackagedApp(outDirectory);

    expect(() =>
      verifyPackagedApp(fixture.appPath, {
        runCommand: ({ command, args }) =>
          command === 'file' && args.at(-1) === fixture.nativePath
            ? 'Mach-O 64-bit bundle x86_64'
            : successfulCommand({ command, args }),
        asarCommand: 'asar',
        fusesCommand: 'electron-fuses',
      }),
    ).toThrow(
      `PACKAGE: better-sqlite3 native binary is not Darwin arm64: ${fixture.nativePath}`,
    );
  });

  it('rejects a wrong selected prebuild even when an arm64 decoy exists elsewhere in better-sqlite3', async () => {
    const outDirectory = await makeTemporaryDirectory();
    const fixture = await createPackagedApp(outDirectory);
    const decoyPath = join(
      fixture.appPath,
      'Contents',
      'Resources',
      'app.asar.unpacked',
      'node_modules',
      'better-sqlite3',
      'build',
      'Release',
      'better_sqlite3.node',
    );
    await writeFixtureFile(decoyPath);

    expect(() =>
      verifyPackagedApp(fixture.appPath, {
        runCommand: ({ command, args }) =>
          command === 'file' && args.at(-1) === fixture.nativePath
            ? 'Mach-O 64-bit bundle x86_64'
            : successfulCommand({ command, args }),
        asarCommand: 'asar',
        fusesCommand: 'electron-fuses',
      }),
    ).toThrow(
      `PACKAGE: better-sqlite3 native binary is not Darwin arm64: ${fixture.nativePath}`,
    );
  });

  it('uses the loader debug fallback when the selected prebuild is absent', async () => {
    const outDirectory = await makeTemporaryDirectory();
    const fixture = await createPackagedApp(outDirectory);
    const debugFallbackPath = join(
      fixture.appPath,
      'Contents',
      'Resources',
      'app.asar.unpacked',
      'node_modules',
      'better-sqlite3',
      'build',
      'Debug',
      'better_sqlite3.node',
    );
    await rm(fixture.nativePath);
    await writeFixtureFile(debugFallbackPath);

    const report = verifyPackagedApp(fixture.appPath, {
      runCommand: successfulCommand,
      asarCommand: 'asar',
      fusesCommand: 'electron-fuses',
    });

    expect(report.nativeBinary).toBe(debugFallbackPath);
  });

  it('rejects an unrelated better-sqlite3 directory when the packaged module root is absent', async () => {
    const outDirectory = await makeTemporaryDirectory();
    const fixture = await createPackagedApp(outDirectory);
    const unpackedDirectory = join(
      fixture.appPath,
      'Contents',
      'Resources',
      'app.asar.unpacked',
    );
    const expectedModuleRoot = join(
      unpackedDirectory,
      'node_modules',
      'better-sqlite3',
    );
    const unrelatedNativePath = join(
      unpackedDirectory,
      'assets',
      'better-sqlite3',
      'prebuilds',
      'darwin-arm64.node',
    );
    await rm(expectedModuleRoot, { recursive: true, force: true });
    await writeFixtureFile(unrelatedNativePath);

    expect(() =>
      verifyPackagedApp(fixture.appPath, {
        runCommand: successfulCommand,
        asarCommand: 'asar',
        fusesCommand: 'electron-fuses',
      }),
    ).toThrow(
      `PACKAGE: packaged better-sqlite3 module root is missing: ${expectedModuleRoot}`,
    );
  });

  it('rejects a plist executable value that escapes Contents/MacOS', async () => {
    const outDirectory = await makeTemporaryDirectory();
    const fixture = await createPackagedApp(outDirectory);

    expect(() =>
      verifyPackagedApp(fixture.appPath, {
        runCommand: ({ command, args }) =>
          command === 'plutil' && args[1] === 'CFBundleExecutable'
            ? '../../outside'
            : successfulCommand({ command, args }),
        asarCommand: 'asar',
        fusesCommand: 'electron-fuses',
      }),
    ).toThrow(
      'PACKAGE: Info.plist field CFBundleExecutable must be a single executable filename: ../../outside',
    );
  });

  it('rejects an executable without owner execute permission even if the test user can bypass access checks', async () => {
    const outDirectory = await makeTemporaryDirectory();
    const fixture = await createPackagedApp(outDirectory);
    await chmod(fixture.executablePath, 0o055);

    expect(() =>
      verifyPackagedApp(fixture.appPath, {
        runCommand: successfulCommand,
        asarCommand: 'asar',
        fusesCommand: 'electron-fuses',
      }),
    ).toThrow(`PACKAGE: packaged executable is not executable: ${fixture.executablePath}`);
  });

  it('reports missing required fuses as package security failures', async () => {
    const outDirectory = await makeTemporaryDirectory();
    const fixture = await createPackagedApp(outDirectory);

    expect(() =>
      verifyPackagedApp(fixture.appPath, {
        runCommand: ({ command, args }) =>
          command === 'electron-fuses'
            ? 'RunAsNode is Enabled'
            : successfulCommand({ command, args }),
        asarCommand: 'asar',
        fusesCommand: 'electron-fuses',
      }),
    ).toThrow(PackageVerificationError);
    expect(() =>
      verifyPackagedApp(fixture.appPath, {
        runCommand: ({ command, args }) =>
          command === 'electron-fuses'
            ? 'RunAsNode is Enabled'
            : successfulCommand({ command, args }),
        asarCommand: 'asar',
        fusesCommand: 'electron-fuses',
      }),
    ).toThrow('PACKAGE: required security fuse is not configured: RunAsNode is Disabled');
  });
});
