import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createPackageCommandRunner,
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
  const appleBridgeBundle = join(
    contentsPath,
    'Helpers',
    'Callie Apple Bridge.app',
  );
  const appleBridgeExecutable = join(
    appleBridgeBundle,
    'Contents',
    'MacOS',
    'CallieAppleBridge',
  );
  const nativePath = join(
    contentsPath,
    'Resources',
    'app.asar.unpacked',
    'node_modules',
    'better-sqlite3-multiple-ciphers',
    'bin',
    'darwin-arm64-149',
    'better-sqlite3-multiple-ciphers.node',
  );

  await writeFixtureFile(join(contentsPath, 'Resources', 'app.asar'));
  await writeFixtureFile(join(contentsPath, 'Info.plist'));
  await writeFixtureFile(executablePath);
  await chmod(executablePath, 0o755);
  await writeFixtureFile(nativePath);
  await writeFixtureFile(join(appleBridgeBundle, 'Contents', 'Info.plist'));
  await writeFixtureFile(appleBridgeExecutable);
  await chmod(appleBridgeExecutable, 0o755);

  return {
    appPath,
    appleBridgeBundle,
    appleBridgeExecutable,
    executablePath,
    nativePath,
  };
};

const successfulCommand = ({ command, args }) => {
  const commandName = command.split('/').at(-1);
  if (commandName === 'file') {
    return args.at(-1).endsWith('.node')
      ? 'Mach-O 64-bit bundle arm64'
      : 'Mach-O 64-bit executable arm64';
  }

  if (commandName === 'plutil') {
    if (args[0] === '-convert') {
      return JSON.stringify({
        'com.apple.security.automation.apple-events': true,
      });
    }
    const key = args[1];
    const isAppleBridge = args.at(-1).includes('Callie Apple Bridge.app');
    if (isAppleBridge) {
      return {
        CFBundleExecutable: 'CallieAppleBridge',
        CFBundleIdentifier: 'com.callie.foundersales.applebridge',
        LSMinimumSystemVersion: '26.4',
      }[key];
    }
    return {
      CFBundleExecutable: 'Callie',
      CFBundleIdentifier: 'com.example.callie',
      CFBundleDisplayName: 'Callie',
      CFBundleShortVersionString: '1.2.3',
      'NSAppTransportSecurity.NSAllowsArbitraryLoads': 'false',
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
      'Analyzing app: Callie.app',
      'Fuse Version: v1',
      'RunAsNode is Disabled',
      'EnableCookieEncryption is Enabled',
      'EnableNodeOptionsEnvironmentVariable is Disabled',
      'EnableNodeCliInspectArguments is Disabled',
      'EnableEmbeddedAsarIntegrityValidation is Enabled',
      'OnlyLoadAppFromAsar is Enabled',
      'LoadBrowserProcessSpecificV8Snapshot is Disabled',
      'GrantFileProtocolExtraPrivileges is Disabled',
      'WasmTrapHandlers is Enabled',
    ].join('\n');
  }

  if (command === 'encrypted-sqlite-electron-probe') {
    return JSON.stringify({
      modules: '149',
      cipherVersion: 'SQLite3 Multiple Ciphers 2.3.5',
    });
  }

  if (commandName === 'codesign') {
    if (args[0] === '--display' && args.includes('--verbose=4')) {
      const isAppleBridge = args.at(-1).includes('Callie Apple Bridge.app');
      return [
        `Identifier=${isAppleBridge
          ? 'com.callie.foundersales.applebridge'
          : 'com.callie.foundersales'}`,
        'Signature=adhoc',
        'TeamIdentifier=not set',
      ].join('\n');
    }
    if (args.includes('--requirements')) {
      return '# designated => cdhash H"1234567890abcdef1234567890abcdef12345678"';
    }
    if (args.includes('--entitlements')) {
      return '<plist><dict><key>com.apple.security.automation.apple-events</key><true/></dict></plist>';
    }
    return '';
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

describe('package command runner', () => {
  it('runs the encrypted SQLite probe under Electron with run-as-node isolated to the child', () => {
    const executions = [];
    const runCommand = createPackageCommandRunner((command, args, options) => {
      executions.push({ command, args, options });
      return JSON.stringify({ modules: '149', cipherVersion: 'synthetic' });
    });

    runCommand({
      command: 'encrypted-sqlite-electron-probe',
      args: ['/tmp/selected.node'],
    });

    expect(executions).toEqual([expect.objectContaining({
      command: expect.stringMatching(/Electron\.app\/Contents\/MacOS\/Electron$/),
      args: [
        expect.stringMatching(/probeEncryptedSqliteNative\.cjs$/),
        '/tmp/selected.node',
      ],
      options: expect.objectContaining({
        env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: '1' }),
      }),
    })]);
  });

  it('forwards verifier property-list input to the fixed executable without a shell', () => {
    const executions = [];
    const runCommand = createPackageCommandRunner((command, args, options) => {
      executions.push({ command, args, options });
      return '{"com.apple.security.automation.apple-events":true}\n';
    });

    const output = runCommand({
      command: '/usr/bin/plutil',
      args: ['-convert', 'json', '-o', '-', '--', '-'],
      input: '<plist><dict/></plist>',
    });

    expect(output).toBe('{"com.apple.security.automation.apple-events":true}');
    expect(executions).toEqual([{
      command: '/usr/bin/plutil',
      args: ['-convert', 'json', '-o', '-', '--', '-'],
      options: expect.objectContaining({
        encoding: 'utf8',
        input: '<plist><dict/></plist>',
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    }]);
  });

  it('preserves the verifier timeout, bounded output, clean environment, and codesign stderr', () => {
    const executions = [];
    const runCommand = createPackageCommandRunner((command, args, options) => {
      executions.push({ command, args, options });
      return {
        error: undefined,
        signal: null,
        status: 0,
        stderr: 'Identifier=com.callie.foundersales\nTeamIdentifier=TEAMAAAA\n',
        stdout: '',
      };
    });

    const output = runCommand({
      command: '/usr/bin/codesign',
      args: ['--display', '--verbose=4', '/tmp/Callie.app'],
      includeStderr: true,
    });

    expect(output).toContain('TeamIdentifier=TEAMAAAA');
    expect(executions).toEqual([{
      command: '/usr/bin/codesign',
      args: ['--display', '--verbose=4', '/tmp/Callie.app'],
      options: expect.objectContaining({
        encoding: 'utf8',
        env: {
          LANG: 'C',
          PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        },
        maxBuffer: 65_536,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5_000,
      }),
    }]);
  });
});

describe('package verification', () => {
  it('accepts exactly the encrypted-driver Electron ABI artifact and records it', async () => {
    const outDirectory = await makeTemporaryDirectory();
    const fixture = await createPackagedApp(outDirectory);

    const report = verifyPackagedApp(fixture.appPath, {
      runCommand: successfulCommand,
      asarCommand: 'asar',
      fusesCommand: 'electron-fuses',
    });

    expect(report.nativeBinary).toBe(fixture.nativePath);
    expect(report.nativeRuntime).toEqual({
      modules: '149',
      cipherVersion: 'SQLite3 Multiple Ciphers 2.3.5',
    });
    expect(report.executable).toBe(fixture.executablePath);
    expect(report.bundle).toEqual({
      identifier: 'com.example.callie',
      displayName: 'Callie',
      version: '1.2.3',
      atsAllowsArbitraryLoads: false,
    });
    expect(report.fuses).toEqual({
      RunAsNode: 'Disabled',
      EnableCookieEncryption: 'Enabled',
      EnableNodeOptionsEnvironmentVariable: 'Disabled',
      EnableNodeCliInspectArguments: 'Disabled',
      EnableEmbeddedAsarIntegrityValidation: 'Enabled',
      OnlyLoadAppFromAsar: 'Enabled',
      LoadBrowserProcessSpecificV8Snapshot: 'Disabled',
      GrantFileProtocolExtraPrivileges: 'Disabled',
      WasmTrapHandlers: 'Enabled',
    });
    expect(report.appleBridge).toEqual({
      bundlePath: fixture.appleBridgeBundle,
      executable: fixture.appleBridgeExecutable,
      bundleIdentifier: 'com.callie.foundersales.applebridge',
      minimumSystemVersion: '26.4',
      architecture: 'arm64',
      signatureMode: 'adhoc',
      automationEntitlement: true,
    });
  });

  it('rejects an arm64 native binary that reports the Node ABI from the Electron probe', async () => {
    const outDirectory = await makeTemporaryDirectory();
    const fixture = await createPackagedApp(outDirectory);

    expect(() => verifyPackagedApp(fixture.appPath, {
      runCommand: ({ command, args }) =>
        command === 'encrypted-sqlite-electron-probe'
          ? JSON.stringify({ modules: '137', cipherVersion: 'synthetic' })
          : successfulCommand({ command, args }),
      asarCommand: 'asar',
      fusesCommand: 'electron-fuses',
    })).toThrow('PACKAGE: encrypted SQLite native probe did not use Electron ABI 149');
  });

  it('explains when the encrypted SQLite binary was not unpacked from ASAR', async () => {
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
      'PACKAGE: expected exactly one encrypted SQLite native binary',
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
      `PACKAGE: encrypted SQLite native binary is not Darwin arm64: ${fixture.nativePath}`,
    );
  });

  it('rejects a decoy native artifact beside the exact encrypted-driver target', async () => {
    const outDirectory = await makeTemporaryDirectory();
    const fixture = await createPackagedApp(outDirectory);
    const decoyPath = join(
      fixture.appPath,
      'Contents',
      'Resources',
      'app.asar.unpacked',
      'node_modules',
      'better-sqlite3-multiple-ciphers',
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
      'PACKAGE: expected exactly one encrypted SQLite native binary',
    );
  });

  it('rejects a debug fallback when the exact ABI target is absent', async () => {
    const outDirectory = await makeTemporaryDirectory();
    const fixture = await createPackagedApp(outDirectory);
    const debugFallbackPath = join(
      fixture.appPath,
      'Contents',
      'Resources',
      'app.asar.unpacked',
      'node_modules',
      'better-sqlite3-multiple-ciphers',
      'build',
      'Debug',
      'better_sqlite3.node',
    );
    await rm(fixture.nativePath);
    await writeFixtureFile(debugFallbackPath);

    expect(() => verifyPackagedApp(fixture.appPath, {
      runCommand: successfulCommand,
      asarCommand: 'asar',
      fusesCommand: 'electron-fuses',
    })).toThrow('PACKAGE: expected exactly one encrypted SQLite native binary');
  });

  it('rejects an unrelated encrypted-driver directory when the packaged module root is absent', async () => {
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
      'better-sqlite3-multiple-ciphers',
    );
    const unrelatedNativePath = join(
      unpackedDirectory,
      'assets',
      'better-sqlite3-multiple-ciphers',
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
      `PACKAGE: packaged encrypted SQLite module root is missing: ${expectedModuleRoot}`,
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
            ? successfulCommand({ command, args }).replace(
                'RunAsNode is Disabled',
                'RunAsNode is Enabled',
              )
            : successfulCommand({ command, args }),
        asarCommand: 'asar',
        fusesCommand: 'electron-fuses',
      }),
    ).toThrow(PackageVerificationError);
    expect(() =>
      verifyPackagedApp(fixture.appPath, {
        runCommand: ({ command, args }) =>
          command === 'electron-fuses'
            ? successfulCommand({ command, args }).replace(
                'RunAsNode is Disabled',
                'RunAsNode is Enabled',
              )
            : successfulCommand({ command, args }),
        asarCommand: 'asar',
        fusesCommand: 'electron-fuses',
      }),
    ).toThrow('PACKAGE: required security fuse is not configured: RunAsNode is Disabled');
  });

  it('rejects an unknown fuse name even when its state is known', async () => {
    const outDirectory = await makeTemporaryDirectory();
    const fixture = await createPackagedApp(outDirectory);
    const unknownOutput = successfulCommand({
      command: 'electron-fuses',
      args: [fixture.appPath],
    })
      .concat('\nFutureElectronFuse is Enabled');

    expect(() =>
      verifyPackagedApp(fixture.appPath, {
        runCommand: ({ command, args }) =>
          command === 'electron-fuses'
            ? unknownOutput
            : successfulCommand({ command, args }),
        asarCommand: 'asar',
        fusesCommand: 'electron-fuses',
      }),
    ).toThrow(
      'PACKAGE: Electron fuse enumeration contains unknown fuse name: FutureElectronFuse',
    );
  });

  it('rejects a missing fuse name explicitly', async () => {
    const outDirectory = await makeTemporaryDirectory();
    const fixture = await createPackagedApp(outDirectory);
    const incompleteOutput = successfulCommand({
      command: 'electron-fuses',
      args: [fixture.appPath],
    })
      .split('\n')
      .filter((line) => !line.startsWith('WasmTrapHandlers'))
      .join('\n');

    expect(() =>
      verifyPackagedApp(fixture.appPath, {
        runCommand: ({ command, args }) =>
          command === 'electron-fuses'
            ? incompleteOutput
            : successfulCommand({ command, args }),
        asarCommand: 'asar',
        fusesCommand: 'electron-fuses',
      }),
    ).toThrow(
      'PACKAGE: Electron fuse enumeration is missing required fuse: WasmTrapHandlers',
    );
  });

  it('rejects duplicate fuse names explicitly', async () => {
    const outDirectory = await makeTemporaryDirectory();
    const fixture = await createPackagedApp(outDirectory);
    const duplicateOutput = successfulCommand({
      command: 'electron-fuses',
      args: [fixture.appPath],
    }).concat('\nRunAsNode is Disabled');

    expect(() =>
      verifyPackagedApp(fixture.appPath, {
        runCommand: ({ command, args }) =>
          command === 'electron-fuses'
            ? duplicateOutput
            : successfulCommand({ command, args }),
        asarCommand: 'asar',
        fusesCommand: 'electron-fuses',
      }),
    ).toThrow(
      'PACKAGE: Electron fuse enumeration contains duplicate state for RunAsNode',
    );
  });

  it('rejects an unknown state token instead of silently skipping its fuse line', async () => {
    const outDirectory = await makeTemporaryDirectory();
    const fixture = await createPackagedApp(outDirectory);
    const unknownStateOutput = successfulCommand({
      command: 'electron-fuses',
      args: [fixture.appPath],
    }).replace('WasmTrapHandlers is Enabled', 'WasmTrapHandlers is Locked');

    expect(() =>
      verifyPackagedApp(fixture.appPath, {
        runCommand: ({ command, args }) =>
          command === 'electron-fuses'
            ? unknownStateOutput
            : successfulCommand({ command, args }),
        asarCommand: 'asar',
        fusesCommand: 'electron-fuses',
      }),
    ).toThrow(
      'PACKAGE: Electron fuse enumeration contains unknown state for WasmTrapHandlers: Locked',
    );
  });

  it('rejects an unsupported or unreadable fuse version', async () => {
    const outDirectory = await makeTemporaryDirectory();
    const fixture = await createPackagedApp(outDirectory);

    expect(() =>
      verifyPackagedApp(fixture.appPath, {
        runCommand: ({ command, args }) =>
          command === 'electron-fuses'
            ? successfulCommand({ command, args }).replace(
                'Fuse Version: v1',
                'Fuse Version: unknown',
              )
            : successfulCommand({ command, args }),
        asarCommand: 'asar',
        fusesCommand: 'electron-fuses',
      }),
    ).toThrow('PACKAGE: expected Electron Fuse Version v1');
  });

  it('rejects ATS arbitrary network loads', async () => {
    const outDirectory = await makeTemporaryDirectory();
    const fixture = await createPackagedApp(outDirectory);

    expect(() =>
      verifyPackagedApp(fixture.appPath, {
        runCommand: ({ command, args }) =>
          command === 'plutil' &&
          args[1] === 'NSAppTransportSecurity.NSAllowsArbitraryLoads'
            ? 'true'
            : successfulCommand({ command, args }),
        asarCommand: 'asar',
        fusesCommand: 'electron-fuses',
      }),
    ).toThrow(
      'PACKAGE: Info.plist must set NSAppTransportSecurity.NSAllowsArbitraryLoads to false',
    );
  });

  it('rejects a packaged app whose final ad-hoc signature is invalid', async () => {
    const outDirectory = await makeTemporaryDirectory();
    const fixture = await createPackagedApp(outDirectory);

    expect(() =>
      verifyPackagedApp(fixture.appPath, {
        runCommand: ({ command, args }) => {
          if (command === 'codesign') {
            throw new Error('invalid Info.plist');
          }
          return successfulCommand({ command, args });
        },
        asarCommand: 'asar',
        fusesCommand: 'electron-fuses',
      }),
    ).toThrow('PACKAGE: could not verify final macOS code signature');
  });
});
