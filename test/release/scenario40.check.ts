import { describe, expect, it } from 'vitest';
import { clientCompatibility, clientVersionRangeSchema, mayMutate } from '@fss/contracts';
import { mustCover } from './support/coverage.ts';

/**
 * Appendix G 40: "A minimum-client-version increase blocks old Electron mutation
 * while preserving the upgrade path."
 *
 * Three suites hold it. The API auth suite refuses a command from an outdated client
 * and proves the command id was not spent, so it is still usable after the upgrade;
 * the desktop packaging suite shows the old build the upgrade screen and proves the
 * only way out is a signed build at or above the new minimum; the contracts suite
 * covers the range arithmetic. This check states the property those three share, as
 * a pair of calls: below the minimum a client may not mutate, and the refusal itself
 * carries the minimum it must reach.
 *
 * ## The vacuous-pass trap
 *
 * Blocking everything would also block the upgrade instruction, and a client that
 * cannot read what it needs is bricked rather than outdated — which is the failure
 * this scenario exists to prevent. The lane tests close it by asserting the upgrade
 * read still succeeds for the blocked client and that no command receipt was
 * written. Closed here by asserting the refusal is *informative*: `upgrade_required`
 * carries the minimum, so the answer to "you may not" is also the answer to "what
 * would let me".
 */

describe('Appendix G 40: blocked for mutation, never blocked from the way out', () => {
  mustCover(40, ['client_upgrade_required', 'clientVersionNotice', 'mayMutate']);

  it('refuses a below-minimum client and names the version it must reach', () => {
    const range = clientVersionRangeSchema.parse({ minimum: '1.2.0', maximum: '1.4.0' });

    expect(clientCompatibility(range, '1.1.9')).toEqual({
      kind: 'upgrade_required',
      version: '1.1.9',
      minimum: '1.2.0',
    });
    expect(mayMutate(range, '1.1.9')).toBe(false);

    // The upgrade read is the same range object the refusal quotes, so a blocked Mac
    // learns where to go from the refusal itself rather than from a second endpoint
    // it may also be blocked from.
    const refusal = clientCompatibility(range, '1.1.9');
    expect(refusal.kind === 'upgrade_required' ? refusal.minimum : '').toBe(range.minimum);
  });

  it('still lets a supported client through, and fails closed on nonsense', () => {
    const range = clientVersionRangeSchema.parse({ minimum: '1.2.0', maximum: '1.4.0' });

    // A gate that refused everything would satisfy the assertion above and be
    // useless; the boundary itself is supported.
    expect(mayMutate(range, '1.2.0')).toBe(true);
    expect(mayMutate(range, '1.4.0')).toBe(true);
    // Newer than the API is its own answer, not an upgrade instruction the Mac
    // cannot act on.
    expect(clientCompatibility(range, '2.0.0').kind).toBe('api_behind_client');
    // And an unparseable announcement is never "probably new enough".
    for (const announced of ['', 'v1.2.0', '1.2', '1.2.0-beta', 'latest']) {
      expect(clientCompatibility(range, announced), announced).toEqual({ kind: 'unreadable_version' });
      expect(mayMutate(range, announced), announced).toBe(false);
    }
  });
});
