import { describe, expect, it } from 'vitest';
import { BUNDLE_ORIGIN } from '../src/main/bundleScheme.ts';
import { allowPermissionCheck, allowPermissionRequest } from '../src/main/mediaPermission.ts';

/** The window may have the microphone for its own page, and nothing else (slice C1). */
describe('the window’s permissions', () => {
  const own = `${BUNDLE_ORIGIN}/index.html`;

  it('allows audio for our own page', () => {
    expect(allowPermissionRequest({ permission: 'media', mediaTypes: ['audio'], requestingUrl: own, ownOrigin: BUNDLE_ORIGIN })).toBe(true);
    expect(allowPermissionCheck({ permission: 'media', mediaType: 'audio', requestingOrigin: BUNDLE_ORIGIN, ownOrigin: BUNDLE_ORIGIN })).toBe(true);
    // The development window loads a file.
    expect(
      allowPermissionRequest({ permission: 'media', mediaTypes: ['audio'], requestingUrl: 'file:///x/renderer/index.html', ownOrigin: 'file://' }),
    ).toBe(true);
  });

  it('denies video, audio with video, and a request that names no type', () => {
    for (const mediaTypes of [['video'], ['audio', 'video'], [], undefined]) {
      expect(allowPermissionRequest({ permission: 'media', mediaTypes, requestingUrl: own, ownOrigin: BUNDLE_ORIGIN })).toBe(false);
    }
    for (const mediaType of ['video', 'unknown', undefined]) {
      expect(allowPermissionCheck({ permission: 'media', mediaType, requestingOrigin: BUNDLE_ORIGIN, ownOrigin: BUNDLE_ORIGIN })).toBe(false);
    }
  });

  it('denies other origins', () => {
    for (const requestingUrl of ['https://sdk.twilio.com/x', 'https://evil.example/', 'callie-app://bundlex/index.html', 'file:///x']) {
      expect(allowPermissionRequest({ permission: 'media', mediaTypes: ['audio'], requestingUrl, ownOrigin: BUNDLE_ORIGIN })).toBe(false);
    }
    expect(
      allowPermissionCheck({ permission: 'media', mediaType: 'audio', requestingOrigin: 'https://evil.example', ownOrigin: BUNDLE_ORIGIN }),
    ).toBe(false);
  });

  it('denies every other permission, even for our own page', () => {
    for (const permission of ['notifications', 'geolocation', 'display-capture', 'clipboard-read', 'openExternal', 'midi']) {
      expect(allowPermissionRequest({ permission, mediaTypes: ['audio'], requestingUrl: own, ownOrigin: BUNDLE_ORIGIN })).toBe(false);
      expect(allowPermissionCheck({ permission, mediaType: 'audio', requestingOrigin: BUNDLE_ORIGIN, ownOrigin: BUNDLE_ORIGIN })).toBe(false);
    }
  });
});
