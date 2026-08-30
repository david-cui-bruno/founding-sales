import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  applyElectronFuses,
  electron44FuseConfig,
  resetPackagedAdHocSignature,
} from '../build/electronFuses';

describe('Electron packaging fuses', () => {
  it('requires the exact Electron 44 V1 fuse policy', () => {
    expect(electron44FuseConfig).toEqual({
      version: '1',
      strictlyRequireAllFuses: true,
      0: false,
      1: true,
      2: false,
      3: false,
      4: true,
      5: true,
      6: false,
      7: false,
      8: true,
    });
  });

  it('flips the extracted Electron binary before signing and resets an unsigned arm64 ad-hoc signature', async () => {
    const flipCalls: unknown[][] = [];
    const flipFuses = async (...args: unknown[]) => {
      flipCalls.push(args);
    };
    const buildPath = '/private/tmp/Electron.app/Contents/Resources/app';

    await applyElectronFuses(
      buildPath,
      'darwin',
      'arm64',
      false,
      flipFuses,
    );

    expect(flipCalls).toEqual([[
      resolve(buildPath, '../..', 'MacOS', 'Electron'),
      {
        ...electron44FuseConfig,
        resetAdHocDarwinSignature: true,
      },
    ]]);
  });

  it('preserves the binary for configured signing and non-arm64 targets', async () => {
    const flipCalls: unknown[][] = [];
    const flipFuses = async (...args: unknown[]) => {
      flipCalls.push(args);
    };

    await applyElectronFuses(
      '/tmp/resources/app',
      'darwin',
      'arm64',
      true,
      flipFuses,
    );
    await applyElectronFuses(
      '/tmp/resources/app',
      'linux',
      'x64',
      false,
      flipFuses,
    );

    expect(flipCalls[0]?.[1]).toMatchObject({
      resetAdHocDarwinSignature: false,
    });
    expect(flipCalls[1]?.[1]).toMatchObject({
      resetAdHocDarwinSignature: false,
    });
  });

  it('resets the final unsigned arm64 app signature after Packager metadata changes', async () => {
    const codesignCalls: unknown[][] = [];
    const runCodesign = async (...args: unknown[]) => {
      codesignCalls.push(args);
    };
    const outputPath = await mkdtemp(join(tmpdir(), 'callie-fuse-package-'));
    const appPath = join(outputPath, 'Callie.app');
    await mkdir(appPath);

    try {
      await resetPackagedAdHocSignature(
        [outputPath],
        'darwin',
        'arm64',
        false,
        runCodesign,
      );

      expect(codesignCalls).toEqual([
        [
          'codesign',
          [
            '--sign',
            '-',
            '--force',
            '--preserve-metadata=entitlements,requirements,flags,runtime',
            '--deep',
            appPath,
          ],
        ],
      ]);
    } finally {
      await rm(outputPath, { recursive: true, force: true });
    }
  });
});
