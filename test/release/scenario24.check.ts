import { describe, expect, it } from 'vitest';
import { AUTH_REFUSAL_CODES } from '@fss/contracts';
import { mustCover, readRepositoryFile } from './support/coverage.ts';

/**
 * Appendix G 24: "A stolen device, a revoked membership and the offline cache honour
 * expiry and the next-check wipe."
 *
 * Two suites divide it. The API auth suite presents an already-rotated refresh
 * credential, revokes a device and deactivates a membership, and asserts the three
 * refusals; the desktop suite writes a real encrypted cache, advances its clock past
 * twenty-four hours, and asserts nothing is shown — then, separately, has the API
 * answer `device_revoked` and asserts the cache file, its key and both credentials
 * are gone. This check adds the vocabulary those three conditions are reported in,
 * and the ordering inside the desktop test that makes its wipe assertion mean
 * something.
 *
 * ## The vacuous-pass trap
 *
 * A cache that was empty expires correctly and proves nothing: "no cards are shown"
 * is true of a client that never cached anything, and it is the easy thing to write.
 * The desktop test closes it by signing in, refreshing Today, and asserting the vault
 * has entries *before* the revocation — so the later `toBe(0)` is a wipe rather than
 * an absence. That ordering is what this file pins, because it is exactly the line a
 * later tidy-up would remove as redundant.
 */

describe('Appendix G 24: the stolen device loses its session and its cache', () => {
  mustCover(24, ['device_revoked', 'credential_reuse']);

  it('reports reuse, revocation and deactivation as three different things', () => {
    // A rotated credential presented twice is a theft signal, not an expiry; a
    // revoked device is an admin decision; a deactivated membership is neither. One
    // code for all three would make the Mac unable to say anything useful.
    for (const code of [
      'credential_reuse',
      'device_revoked',
      'membership_inactive',
      'session_expired',
      'reauthentication_required',
    ] as const) {
      expect(AUTH_REFUSAL_CODES).toContain(code);
    }
  });

  it('writes a cache before it asserts the cache is gone', () => {
    const desktop = readRepositoryFile('apps/desktop/test/desktop.test.ts');
    const wipe = desktop.slice(desktop.indexOf('is wiped, with its key, the moment the API says the device is revoked'));
    expect(wipe.length).toBeGreaterThan(0);
    const filled = wipe.indexOf('expect(mac.vault.entries.size).toBeGreaterThan(0)');
    const revoked = wipe.indexOf("mac.script.refuse('/today', 'device_revoked')");
    const emptied = wipe.indexOf('expect(mac.vault.entries.size).toBe(0)');
    expect(filled).toBeGreaterThan(-1);
    expect(revoked).toBeGreaterThan(filled);
    expect(emptied).toBeGreaterThan(revoked);
    // And the wipe reaches the disk, not only the in-memory vault.
    expect(wipe.slice(0, 2000)).toContain('CACHE_FILE');
    expect(wipe.slice(0, 2000)).toContain('DEVICE_FILE');
  });
});
