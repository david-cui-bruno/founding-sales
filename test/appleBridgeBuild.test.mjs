import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildAppleBridgeBundle,
  copyAppleBridgeBundle,
  prepareAppleBridgePackage,
} from '../scripts/buildAppleBridge.mjs';

const validInfoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.callie.foundersales.applebridge</string>
<key>CFBundleExecutable</key><string>CallieAppleBridge</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>1.0.0</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
<key>LSMinimumSystemVersion</key><string>26.4</string>
<key>NSContactsUsageDescription</key><string>Callie checks whether a test caller is already in Contacts before deciding whether recording is eligible.</string>
<key>NSAppleEventsUsageDescription</key><string>Callie uses Apple Events only for founder-confirmed Messages tests and Notes recording export.</string>
</dict></plist>`;

const validEntitlements = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>com.apple.security.automation.apple-events</key><true/>
</dict></plist>`;

const validProtocolVersion = `public enum AppleBridgeBuildInfo {
  public static let helperVersion = "1.0.0"
}`;

const resourceContents = (path) => {
  if (path.endsWith('Helper-Info.plist')) return validInfoPlist;
  if (path.endsWith('CallieAppleBridge.entitlements')) return validEntitlements;
  if (path.endsWith('ProtocolVersion.swift')) return validProtocolVersion;
  throw new Error(`unexpected read: ${path}`);
};

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('assembles the generated helper at the fixed arm64 bundle path', async () => {
  const commands = [];
  const writes = [];
  const fileSystem = {
    chmod: async (...args) => writes.push(['chmod', ...args]),
    copyFile: async (...args) => writes.push(['copyFile', ...args]),
    mkdir: async (...args) => writes.push(['mkdir', ...args]),
    readFile: async (path) => resourceContents(path),
    rm: async (...args) => writes.push(['rm', ...args]),
  };

  const result = await buildAppleBridgeBundle({
    projectRoot: '/repo',
    platform: 'darwin',
    arch: 'arm64',
    run: async (command) => commands.push(command),
    fileSystem,
  });

  assert.deepEqual(result, {
    bundlePath: '/repo/build/generated/apple-bridge/Callie Apple Bridge.app',
    executablePath:
      '/repo/build/generated/apple-bridge/Callie Apple Bridge.app/Contents/MacOS/CallieAppleBridge',
  });
  assert.deepEqual(commands, [
    {
      command: 'swift',
      args: [
        'build',
        '--package-path',
        '/repo/native/apple-bridge',
        '-c',
        'release',
        '--arch',
        'arm64',
      ],
      cwd: '/repo',
    },
  ]);
  assert.deepEqual(writes, [
    [
      'rm',
      '/repo/build/generated/apple-bridge/Callie Apple Bridge.app',
      { recursive: true, force: true },
    ],
    [
      'mkdir',
      '/repo/build/generated/apple-bridge/Callie Apple Bridge.app/Contents/MacOS',
      { recursive: true, mode: 0o755 },
    ],
    [
      'copyFile',
      '/repo/native/apple-bridge/Resources/Helper-Info.plist',
      '/repo/build/generated/apple-bridge/Callie Apple Bridge.app/Contents/Info.plist',
    ],
    [
      'copyFile',
      '/repo/native/apple-bridge/.build/arm64-apple-macosx/release/CallieAppleBridge',
      '/repo/build/generated/apple-bridge/Callie Apple Bridge.app/Contents/MacOS/CallieAppleBridge',
    ],
    [
      'chmod',
      '/repo/build/generated/apple-bridge/Callie Apple Bridge.app/Contents/MacOS/CallieAppleBridge',
      0o755,
    ],
  ]);
});

test('rejects any target other than Darwin arm64 before running Swift', async () => {
  let runCount = 0;
  const fileSystem = {
    chmod: async () => {},
    copyFile: async () => {},
    mkdir: async () => {},
    readFile: async (path) => resourceContents(path),
    rm: async () => {},
  };

  await assert.rejects(
    buildAppleBridgeBundle({
      projectRoot: '/repo',
      platform: 'darwin',
      arch: 'x64',
      run: async () => {
        runCount += 1;
      },
      fileSystem,
    }),
    /requires Darwin arm64/,
  );
  await assert.rejects(
    buildAppleBridgeBundle({
      projectRoot: '/repo',
      platform: 'linux',
      arch: 'arm64',
      run: async () => {
        runCount += 1;
      },
      fileSystem,
    }),
    /requires Darwin arm64/,
  );
  assert.equal(runCount, 0);
});

test('copies the generated bundle only to the fixed Contents/Helpers destination', async () => {
  const writes = [];
  const result = await copyAppleBridgeBundle(
    '/tmp/Callie.app/Contents/Resources/app',
    '/repo/build/generated/apple-bridge/Callie Apple Bridge.app',
    {
      fileSystem: {
        cp: async (...args) => writes.push(['cp', ...args]),
        mkdir: async (...args) => writes.push(['mkdir', ...args]),
        rm: async (...args) => writes.push(['rm', ...args]),
      },
    },
  );

  assert.equal(
    result,
    '/tmp/Callie.app/Contents/Helpers/Callie Apple Bridge.app',
  );
  assert.deepEqual(writes, [
    [
      'rm',
      '/tmp/Callie.app/Contents/Helpers/Callie Apple Bridge.app',
      { recursive: true, force: true },
    ],
    [
      'mkdir',
      '/tmp/Callie.app/Contents/Helpers',
      { recursive: true, mode: 0o755 },
    ],
    [
      'cp',
      '/repo/build/generated/apple-bridge/Callie Apple Bridge.app',
      '/tmp/Callie.app/Contents/Helpers/Callie Apple Bridge.app',
      { recursive: true, force: true, dereference: false },
    ],
  ]);
});

test('refuses ambiguous relative or misnamed helper-copy inputs before filesystem changes', async () => {
  let writeCount = 0;
  const fileSystem = {
    cp: async () => {
      writeCount += 1;
    },
    mkdir: async () => {
      writeCount += 1;
    },
    rm: async () => {
      writeCount += 1;
    },
  };

  await assert.rejects(
    copyAppleBridgeBundle(
      'relative/build/path',
      '/repo/build/generated/apple-bridge/Callie Apple Bridge.app',
      { fileSystem },
    ),
    /absolute build path/,
  );
  await assert.rejects(
    copyAppleBridgeBundle(
      '/tmp/Callie.app/Contents/Resources/app',
      '/repo/build/generated/apple-bridge/Other.app',
      { fileSystem },
    ),
    /expected generated helper bundle/,
  );
  assert.equal(writeCount, 0);
});

test('rejects a helper plist version that differs from the native hello version', async () => {
  let runCount = 0;
  const fileSystem = {
    chmod: async () => {},
    copyFile: async () => {},
    mkdir: async () => {},
    readFile: async (path) =>
      path.endsWith('Helper-Info.plist')
        ? validInfoPlist.replace('1.0.0', '1.0.1')
        : resourceContents(path),
    rm: async () => {},
  };

  await assert.rejects(
    buildAppleBridgeBundle({
      projectRoot: '/repo',
      platform: 'darwin',
      arch: 'arm64',
      run: async () => {
        runCount += 1;
      },
      fileSystem,
    }),
    /must match native helper version 1\.0\.0/,
  );
  assert.equal(runCount, 0);
});

test('rejects helper entitlements with any capability beyond Apple Events automation', async () => {
  let runCount = 0;
  const fileSystem = {
    chmod: async () => {},
    copyFile: async () => {},
    mkdir: async () => {},
    readFile: async (path) =>
      path.endsWith('CallieAppleBridge.entitlements')
        ? validEntitlements.replace(
            '</dict>',
            '<key>com.apple.security.app-sandbox</key><true/></dict>',
          )
        : resourceContents(path),
    rm: async () => {},
  };

  await assert.rejects(
    buildAppleBridgeBundle({
      projectRoot: '/repo',
      platform: 'darwin',
      arch: 'arm64',
      run: async () => {
        runCount += 1;
      },
      fileSystem,
    }),
    /exactly the Apple Events automation entitlement/,
  );
  assert.equal(runCount, 0);
});

test('repository helper resources satisfy the bundle and native-version contract', async () => {
  let runCount = 0;

  await buildAppleBridgeBundle({
    projectRoot,
    platform: 'darwin',
    arch: 'arm64',
    run: async () => {
      runCount += 1;
    },
    fileSystem: {
      chmod: async () => {},
      copyFile: async () => {},
      mkdir: async () => {},
      readFile,
      rm: async () => {},
    },
  });

  assert.equal(runCount, 1);
});

test('copies before ad-hoc signing the nested helper executable', async () => {
  const calls = [];

  const destination = await prepareAppleBridgePackage({
    projectRoot: '/repo',
    buildPath: '/tmp/Callie.app/Contents/Resources/app',
    platform: 'darwin',
    arch: 'arm64',
    hasConfiguredMacSigning: false,
    copyBundle: async (...args) => {
      calls.push(['copy', ...args]);
      return '/tmp/Callie.app/Contents/Helpers/Callie Apple Bridge.app';
    },
    runCommand: async (...args) => {
      calls.push(['run', ...args]);
    },
  });

  assert.equal(
    destination,
    '/tmp/Callie.app/Contents/Helpers/Callie Apple Bridge.app',
  );
  assert.deepEqual(calls, [
    [
      'copy',
      '/tmp/Callie.app/Contents/Resources/app',
      '/repo/build/generated/apple-bridge/Callie Apple Bridge.app',
    ],
    [
      'run',
      '/usr/bin/codesign',
      [
        '--force',
        '--sign',
        '-',
        '--entitlements',
        '/repo/native/apple-bridge/Resources/CallieAppleBridge.entitlements',
        '/tmp/Callie.app/Contents/Helpers/Callie Apple Bridge.app/Contents/MacOS/CallieAppleBridge',
      ],
    ],
  ]);
});

test('leaves the copied helper unsigned for Forge stable signing', async () => {
  const calls = [];

  const destination = await prepareAppleBridgePackage({
    projectRoot: '/repo',
    buildPath: '/tmp/Callie.app/Contents/Resources/app',
    platform: 'darwin',
    arch: 'arm64',
    hasConfiguredMacSigning: true,
    copyBundle: async (...args) => {
      calls.push(['copy', ...args]);
      return '/tmp/Callie.app/Contents/Helpers/Callie Apple Bridge.app';
    },
    runCommand: async (...args) => {
      calls.push(['run', ...args]);
    },
  });

  assert.equal(
    destination,
    '/tmp/Callie.app/Contents/Helpers/Callie Apple Bridge.app',
  );
  assert.deepEqual(calls, [
    [
      'copy',
      '/tmp/Callie.app/Contents/Resources/app',
      '/repo/build/generated/apple-bridge/Callie Apple Bridge.app',
    ],
  ]);
});

test('does not copy or sign the macOS helper for unsupported package targets', async () => {
  let operationCount = 0;
  const result = await prepareAppleBridgePackage({
    projectRoot: '/repo',
    buildPath: '/tmp/Callie/Resources/app',
    platform: 'linux',
    arch: 'arm64',
    hasConfiguredMacSigning: false,
    copyBundle: async () => {
      operationCount += 1;
      return '/unexpected';
    },
    runCommand: async () => {
      operationCount += 1;
    },
  });

  assert.equal(result, undefined);
  assert.equal(operationCount, 0);
});
