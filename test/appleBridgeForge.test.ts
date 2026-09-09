import { describe, expect, it } from 'vitest';

import {
  createAppleBridgeForgeHooks,
  createAppleBridgeSigningOptions,
} from '../build/appleBridge';

describe('Apple helper Forge integration', () => {
  it('uses build-environment signing identity and scopes helper entitlements', () => {
    expect(createAppleBridgeSigningOptions(undefined)).toBeUndefined();

    const options = createAppleBridgeSigningOptions('Developer ID Example');
    expect(options).toMatchObject({
      identity: 'Developer ID Example',
      hardenedRuntime: true,
      continueOnError: false,
    });
    expect(options?.optionsForFile?.('/tmp/Callie.app/Contents/MacOS/Callie')).toEqual({});
    expect(
      options?.optionsForFile?.(
        '/tmp/Callie.app/Contents/Helpers/Callie Apple Bridge.app/Contents/MacOS/CallieAppleBridge',
      ),
    ).toEqual({
      entitlements:
        'native/apple-bridge/Resources/CallieAppleBridge.entitlements',
    });
  });

  it('builds assets only for Darwin arm64 and copies/signs before flipping fuses', async () => {
    const calls: unknown[][] = [];
    const hooks = createAppleBridgeForgeHooks({
      projectRoot: '/repo',
      generateAssets: async (...args) => {
        calls.push(['generate', ...args]);
        return '/repo/build/generated/apple-bridge/Callie Apple Bridge.app';
      },
      preparePackage: async (options) => {
        calls.push(['prepare', options]);
        return '/tmp/helper.app';
      },
      applyFuses: async (...args) => {
        calls.push(['fuses', ...args]);
      },
      resetAdHocSignature: async (...args) => {
        calls.push(['reset', ...args]);
      },
    });
    const unsignedConfig = { packagerConfig: {} } as never;

    await hooks.generateAssets?.(unsignedConfig, 'linux', 'arm64');
    await hooks.generateAssets?.(unsignedConfig, 'darwin', 'arm64');
    await hooks.packageAfterCopy?.(
      unsignedConfig,
      '/tmp/Callie.app/Contents/Resources/app',
      '44.0.0',
      'darwin',
      'arm64',
    );
    await hooks.postPackage?.(unsignedConfig, {
      platform: 'darwin',
      arch: 'arm64',
      outputPaths: ['/tmp/out'],
    });

    expect(calls).toEqual([
      ['generate', '/repo', 'darwin', 'arm64'],
      [
        'prepare',
        {
          projectRoot: '/repo',
          buildPath: '/tmp/Callie.app/Contents/Resources/app',
          platform: 'darwin',
          arch: 'arm64',
          hasConfiguredMacSigning: false,
        },
      ],
      [
        'fuses',
        '/tmp/Callie.app/Contents/Resources/app',
        'darwin',
        'arm64',
        false,
      ],
      ['reset', ['/tmp/out'], 'darwin', 'arm64', false],
    ]);
  });
});
