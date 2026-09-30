import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DESKTOP_ENTITLEMENTS, parseEntitlementsPlist, renderEntitlementsPlist } from '../../scripts/entitlements.ts';
import {
  ALLOWED_USAGE_DESCRIPTIONS,
  MICROPHONE_USAGE_DESCRIPTION,
  trimInfoPlist,
  usageDescriptionKeys,
  usageDescriptionsToRemove,
} from '../../scripts/package.ts';

/**
 * The packaged app may use the microphone, and nothing else Electron's stock plist
 * promises (slice C1): calls placed from Callie are spoken through the Mac.
 */

const ELECTRON_STOCK = [
  'NSAudioCaptureUsageDescription',
  'NSBluetoothAlwaysUsageDescription',
  'NSCameraUsageDescription',
  'NSDownloadsFolderUsageDescription',
  'NSMicrophoneUsageDescription',
];

describe('the microphone in the packaged app', () => {
  it('keeps the microphone’s usage description and deletes the camera’s and the rest', () => {
    expect(ALLOWED_USAGE_DESCRIPTIONS).toContain('NSMicrophoneUsageDescription');
    expect(usageDescriptionsToRemove(ELECTRON_STOCK)).toEqual([
      'NSAudioCaptureUsageDescription',
      'NSBluetoothAlwaysUsageDescription',
      'NSCameraUsageDescription',
    ]);
    expect(MICROPHONE_USAGE_DESCRIPTION).toBe('Callie uses the microphone for calls you place from Callie.');
  });

  it('signs with the audio-input entitlement, and the plist handed to codesign carries it', () => {
    expect(DESKTOP_ENTITLEMENTS['com.apple.security.device.audio-input']).toBe(true);
    expect(DESKTOP_ENTITLEMENTS['com.apple.security.device.camera']).toBeUndefined();
    expect(parseEntitlementsPlist(renderEntitlementsPlist(DESKTOP_ENTITLEMENTS))).toMatchObject({
      'com.apple.security.device.audio-input': true,
    });
  });

  // `trimInfoPlist` runs Apple's plutil; only a Mac has it.
  it.skipIf(process.platform !== 'darwin')('trimInfoPlist keeps NSMicrophoneUsageDescription in a real Info.plist', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fss-plist-'));
    try {
      const app = join(directory, 'Callie.app');
      await mkdir(join(app, 'Contents'), { recursive: true });
      const plist = join(app, 'Contents', 'Info.plist');
      await writeFile(
        plist,
        JSON.stringify(Object.fromEntries([...ELECTRON_STOCK.map(key => [key, 'stock']), ['CFBundleName', 'Callie']])),
      );
      execFileSync('/usr/bin/plutil', ['-convert', 'xml1', plist]);
      trimInfoPlist(app);
      expect(usageDescriptionKeys(plist)).toEqual(['NSDownloadsFolderUsageDescription', 'NSMicrophoneUsageDescription']);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
