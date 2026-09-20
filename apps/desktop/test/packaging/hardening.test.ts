import { describe, expect, it } from 'vitest';
import {
  compareEntitlements,
  DESKTOP_ENTITLEMENTS,
  FORBIDDEN_ENTITLEMENTS,
  parseEntitlementsPlist,
  renderEntitlementsPlist,
} from '../../scripts/entitlements.ts';
import { DESKTOP_FUSES } from '../../scripts/fuses.ts';
import { RELEASE_STAMP_FILE, validateReleaseStamp } from '../../scripts/releaseStamp.ts';

/**
 * The three things the verifier compares a packaged app against: the entitlements the
 * app asks for, the fuses it was built with, and the stamp that says which commit it
 * came from. All three are declared here, in code, once — so that the build and the
 * verifier cannot drift, and so that adding an entitlement is a diff somebody reads.
 */

describe('the app asks for one entitlement and no more', () => {
  it('asks only for the JIT the renderer needs', () => {
    // A Developer ID app is not sandboxed, so the sandbox entitlements would be
    // decoration; hardened runtime is what it is signed with, and V8 is the only
    // part of it that needs an exception.
    expect(DESKTOP_ENTITLEMENTS).toEqual({ 'com.apple.security.cs.allow-jit': true });
  });

  it('names the exceptions that would undo the hardened runtime', () => {
    expect([...FORBIDDEN_ENTITLEMENTS]).toEqual([
      'com.apple.security.cs.allow-dyld-environment-variables',
      'com.apple.security.cs.allow-unsigned-executable-memory',
      'com.apple.security.cs.debugger',
      'com.apple.security.cs.disable-executable-page-protection',
      'com.apple.security.cs.disable-library-validation',
      'com.apple.security.get-task-allow',
    ]);
  });

  it('round-trips the plist it hands to codesign', () => {
    expect(parseEntitlementsPlist(renderEntitlementsPlist(DESKTOP_ENTITLEMENTS))).toEqual(DESKTOP_ENTITLEMENTS);
  });

  it('accepts exactly the declared set and nothing else', () => {
    expect(compareEntitlements(DESKTOP_ENTITLEMENTS)).toEqual({ ok: true });
  });

  it('refuses an app that gained an entitlement nobody declared', () => {
    expect(compareEntitlements({ ...DESKTOP_ENTITLEMENTS, 'com.apple.security.device.camera': true })).toEqual({
      ok: false,
      unexpected: ['com.apple.security.device.camera'],
      missing: [],
      forbidden: [],
    });
  });

  it('refuses an app that disabled library validation', () => {
    expect(
      compareEntitlements({ ...DESKTOP_ENTITLEMENTS, 'com.apple.security.cs.disable-library-validation': true }),
    ).toEqual({
      ok: false,
      unexpected: [],
      missing: [],
      forbidden: ['com.apple.security.cs.disable-library-validation'],
    });
  });

  it('refuses an app that lost the entitlement it needs', () => {
    expect(compareEntitlements({})).toEqual({
      ok: false,
      unexpected: [],
      missing: ['com.apple.security.cs.allow-jit'],
      forbidden: [],
    });
  });

  it('treats an entitlement present but false as absent', () => {
    expect(compareEntitlements({ 'com.apple.security.cs.allow-jit': false })).toEqual({
      ok: false,
      unexpected: [],
      missing: ['com.apple.security.cs.allow-jit'],
      forbidden: [],
    });
  });
});

describe('the fuses the build burns are the fuses the verifier reads', () => {
  it('turns off every way of running the bundle as plain Node', () => {
    expect(DESKTOP_FUSES).toEqual({
      RunAsNode: false,
      EnableCookieEncryption: true,
      EnableNodeOptionsEnvironmentVariable: false,
      EnableNodeCliInspectArguments: false,
      EnableEmbeddedAsarIntegrityValidation: true,
      OnlyLoadAppFromAsar: true,
      LoadBrowserProcessSpecificV8Snapshot: false,
      GrantFileProtocolExtraPrivileges: false,
    });
  });
});

describe('the release stamp says which commit is in the bundle', () => {
  const stamp = {
    format: 'fss-desktop-release',
    version: 1,
    channel: 'release',
    commitSha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    dirty: false,
    appVersion: '1.5.0',
    electronVersion: '44.0.0',
    updatePublicKey: 'MCowBQYDK2VwAyEAdGhpcyBpcyBub3QgYSByZWFsIHB1YmxpYyBrZXk=',
    builtAt: '2026-09-20T09:00:00.000Z',
  };

  it('is a file inside the bundle, not a build argument', () => {
    expect(RELEASE_STAMP_FILE).toBe('release-stamp.json');
  });

  it('accepts a well-formed release stamp', () => {
    expect(validateReleaseStamp(stamp)).toEqual(stamp);
  });

  it('refuses a stamp with a field the contract does not name', () => {
    expect(() => validateReleaseStamp({ ...stamp, note: 'shipped in a hurry' })).toThrow();
  });

  it('refuses an abbreviated commit', () => {
    expect(() => validateReleaseStamp({ ...stamp, commitSha: 'a1b2c3d' })).toThrow();
  });

  it('refuses a release stamp made from a dirty tree', () => {
    expect(() => validateReleaseStamp({ ...stamp, dirty: true })).toThrow();
  });

  it('allows a local smoke stamp from a dirty tree, and marks it', () => {
    expect(validateReleaseStamp({ ...stamp, channel: 'local-smoke', dirty: true, updatePublicKey: '' })).toEqual({
      ...stamp,
      channel: 'local-smoke',
      dirty: true,
      updatePublicKey: '',
    });
  });

  it('refuses a release stamp with no embedded update key', () => {
    expect(() => validateReleaseStamp({ ...stamp, updatePublicKey: '' })).toThrow();
  });
});
