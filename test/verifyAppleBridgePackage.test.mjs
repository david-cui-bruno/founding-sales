import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, test } from 'node:test';

import {
  createAppleBridgeCommandRunner,
  expectedAppleBridge,
  verifyAppleBridgePackage,
} from '../scripts/verifyAppleBridgePackage.mjs';

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const writeFixture = (path, contents = '') => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
};

const stableRequirement = (identifier, teamIdentifier) =>
  `designated => identifier "${identifier}" and anchor apple generic and certificate leaf[subject.OU] = "${teamIdentifier}"`;

const adhocRequirement =
  '# designated => cdhash H"1234567890abcdef1234567890abcdef12345678"';

const packagedHelperFixture = ({
  architecture = 'Mach-O 64-bit executable arm64',
  bundleIdentifier = expectedAppleBridge.bundleIdentifier,
  minimumSystemVersion = expectedAppleBridge.minimumSystemVersion,
  parentTeam = undefined,
  helperTeam = undefined,
  automationEntitlement = true,
  helperSignatureValid = true,
  parentSignatureValid = true,
} = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'callie-apple-package-'));
  temporaryDirectories.push(root);
  const appPath = join(root, 'Callie Founder Sales System.app');
  const helperBundle = join(appPath, expectedAppleBridge.relativeBundle);
  const executable = join(helperBundle, expectedAppleBridge.executable);
  const helperPlist = join(helperBundle, 'Contents', 'Info.plist');

  writeFixture(join(appPath, 'Contents', 'Info.plist'));
  writeFixture(helperPlist);
  writeFixture(executable);
  chmodSync(executable, 0o755);

  const calls = [];
  const runCommand = ({ command, args, input }) => {
    calls.push({ command, args, input });

    if (command === '/usr/bin/file') {
      return architecture;
    }
    if (command === '/usr/bin/plutil' && args[0] === '-extract') {
      const key = args[1];
      return {
        CFBundleExecutable: 'CallieAppleBridge',
        CFBundleIdentifier: bundleIdentifier,
        LSMinimumSystemVersion: minimumSystemVersion,
      }[key];
    }
    if (command === '/usr/bin/plutil' && args[0] === '-convert') {
      return JSON.stringify(
        automationEntitlement
          ? { 'com.apple.security.automation.apple-events': true }
          : {},
      );
    }
    if (command === '/usr/bin/codesign' && args.includes('--verify')) {
      const target = args.at(-1);
      if (target === helperBundle && !helperSignatureValid) {
        throw new Error('helper signature invalid');
      }
      if (target === appPath && !parentSignatureValid) {
        throw new Error('parent signature invalid');
      }
      return '';
    }
    if (
      command === '/usr/bin/codesign'
      && args[0] === '--display'
      && args.includes('--entitlements')
    ) {
      return automationEntitlement
        ? '<plist><dict><key>com.apple.security.automation.apple-events</key><true/></dict></plist>'
        : '<plist><dict/></plist>';
    }
    if (command === '/usr/bin/codesign' && args.includes('--requirements')) {
      const target = args.at(-1);
      const team = target === appPath ? parentTeam : helperTeam;
      const identifier = target === appPath
        ? 'com.callie.foundersales'
        : expectedAppleBridge.bundleIdentifier;
      return team === undefined
        ? adhocRequirement
        : stableRequirement(identifier, team);
    }

    throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
  };

  return { appPath, calls, executable, helperBundle, runCommand };
};

test('fixed Apple verifier command runner pipes property-list input without a shell', () => {
  const executions = [];
  const runCommand = createAppleBridgeCommandRunner((command, args, options) => {
    executions.push({ command, args, options });
    return '{"com.apple.security.automation.apple-events":true}\n';
  });

  const output = runCommand({
    command: '/usr/bin/plutil',
    args: ['-convert', 'json', '-o', '-', '--', '-'],
    input: '<plist><dict/></plist>',
  });

  assert.equal(output, '{"com.apple.security.automation.apple-events":true}');
  assert.deepEqual(executions, [{
    command: '/usr/bin/plutil',
    args: ['-convert', 'json', '-o', '-', '--', '-'],
    options: {
      encoding: 'utf8',
      env: {
        LANG: 'C',
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      },
      input: '<plist><dict/></plist>',
      maxBuffer: 65_536,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5_000,
    },
  }]);
});

test('accepts an ad-hoc helper only after fixed strict signature, identity, architecture, and entitlement checks', () => {
  const fixture = packagedHelperFixture();

  const report = verifyAppleBridgePackage(fixture.appPath, {
    runCommand: fixture.runCommand,
  });

  assert.deepEqual(report, {
    bundlePath: fixture.helperBundle,
    executable: fixture.executable,
    bundleIdentifier: expectedAppleBridge.bundleIdentifier,
    minimumSystemVersion: expectedAppleBridge.minimumSystemVersion,
    architecture: 'arm64',
    signatureMode: 'adhoc',
    automationEntitlement: true,
  });
  assert.ok(
    fixture.calls.some(({ command, args }) =>
      command === '/usr/bin/file'
      && args[0] === '-b'
      && args[1] === fixture.executable),
  );
  assert.ok(
    fixture.calls.some(({ command, args }) =>
      command === '/usr/bin/codesign'
      && args.join('\0') === [
        '--verify',
        '--strict',
        '--verbose=4',
        '--requirement',
        `=identifier "${expectedAppleBridge.bundleIdentifier}"`,
        fixture.helperBundle,
      ].join('\0')),
  );
  assert.ok(
    fixture.calls.some(({ command, args, input }) =>
      command === '/usr/bin/plutil'
      && args.join('\0') === ['-convert', 'json', '-o', '-', '--', '-'].join('\0')
      && typeof input === 'string'
      && input.includes('com.apple.security.automation.apple-events')),
  );
});

test('rejects a stable helper whose Team ID differs from the parent', () => {
  const fixture = packagedHelperFixture({
    parentTeam: 'TEAMAAAA',
    helperTeam: 'TEAMBBBB',
  });

  assert.throws(
    () => verifyAppleBridgePackage(fixture.appPath, { runCommand: fixture.runCommand }),
    /Team ID/i,
  );
});

test('accepts a stable helper only when both non-empty Team IDs match', () => {
  const fixture = packagedHelperFixture({
    parentTeam: 'TEAMAAAA',
    helperTeam: 'TEAMAAAA',
  });

  const report = verifyAppleBridgePackage(fixture.appPath, {
    runCommand: fixture.runCommand,
  });

  assert.equal(report.signatureMode, 'stable');
});

test('rejects a helper missing the Apple Events entitlement', () => {
  const fixture = packagedHelperFixture({ automationEntitlement: false });

  assert.throws(
    () => verifyAppleBridgePackage(fixture.appPath, { runCommand: fixture.runCommand }),
    /automation\.apple-events/i,
  );
});

test('rejects the wrong helper bundle identifier', () => {
  const fixture = packagedHelperFixture({ bundleIdentifier: 'com.example.wrong' });

  assert.throws(
    () => verifyAppleBridgePackage(fixture.appPath, { runCommand: fixture.runCommand }),
    /bundle identifier/i,
  );
});

test('rejects the wrong helper minimum system version', () => {
  const fixture = packagedHelperFixture({ minimumSystemVersion: '26.3' });

  assert.throws(
    () => verifyAppleBridgePackage(fixture.appPath, { runCommand: fixture.runCommand }),
    /minimum system version/i,
  );
});

test('rejects a non-arm64 helper executable', () => {
  const fixture = packagedHelperFixture({
    architecture: 'Mach-O 64-bit executable x86_64',
  });

  assert.throws(
    () => verifyAppleBridgePackage(fixture.appPath, { runCommand: fixture.runCommand }),
    /arm64/i,
  );
});

test('rejects an invalid nested helper signature', () => {
  const fixture = packagedHelperFixture({ helperSignatureValid: false });

  assert.throws(
    () => verifyAppleBridgePackage(fixture.appPath, { runCommand: fixture.runCommand }),
    /strict nested signature/i,
  );
});

test('rejects a mixed ad-hoc and stable parent/helper signature mode', () => {
  const fixture = packagedHelperFixture({ helperTeam: 'TEAMAAAA' });

  assert.throws(
    () => verifyAppleBridgePackage(fixture.appPath, { runCommand: fixture.runCommand }),
    /signature mode/i,
  );
});
