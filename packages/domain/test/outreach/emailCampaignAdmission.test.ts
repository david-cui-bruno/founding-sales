import { describe, expect, it } from 'vitest';
import { campaignExpiryAllowed } from '../../outreach/emailCampaignAuthority.ts';
import { campaignCapacityAvailable } from '../../outreach/emailCampaignAdmission.ts';

/** Pure policy boundary only. Real authorization, lineage, transaction and race
 * acceptance lives in the new HTTPS/OIDC/PG campaign browser lane. */
describe('campaign admission expiry uses the current instant and cannot revive an expired policy', () => {
  const now = '2026-10-22T17:00:00.000Z';
  it.each([
    ['equal to DB now', now, false],
    ['past by one millisecond', '2026-10-22T16:59:59.999Z', false],
    ['future by one millisecond', '2026-10-22T17:00:00.001Z', true],
    ['exactly thirty days', '2026-11-21T17:00:00.000Z', true],
    ['thirty days plus one millisecond', '2026-11-21T17:00:00.001Z', false],
    ['invalid date', 'not-an-instant', false],
  ])('%s', (_name, expiresAt, allowed) => {
    expect(campaignExpiryAllowed(expiresAt, now)).toBe(allowed);
  });
  it('re-evaluates at the current instant instead of approval time', () => {
    const expiresAt = '2026-10-23T17:00:00.000Z';
    expect(campaignExpiryAllowed(expiresAt, now)).toBe(true);
    expect(campaignExpiryAllowed(expiresAt, expiresAt)).toBe(false);
    expect(campaignExpiryAllowed(expiresAt, '2026-10-24T17:00:00.000Z')).toBe(false);
  });
  it('fails closed when the current instant is invalid', () => {
    expect(campaignExpiryAllowed('2026-10-23T17:00:00.000Z', 'unknown')).toBe(false);
  });
});

describe('campaign admission conserves both lifetime and daily remaining capacity', () => {
  const policy = { max_enrollments: 25, daily_admission_limit: 5 };
  it.each([
    [0, 0, true], [24, 4, true], [25, 0, false], [0, 5, false],
    [25, 5, false], [26, 6, false],
  ])('total %i and daily %i permit admission: %s', (total, daily, allowed) => {
    expect(campaignCapacityAvailable(policy, total, daily)).toBe(allowed);
  });
  it('honors lower explicit caps rather than the maximum allowed policy', () => {
    expect(campaignCapacityAvailable({ max_enrollments: 1, daily_admission_limit: 1 }, 0, 0)).toBe(true);
    expect(campaignCapacityAvailable({ max_enrollments: 1, daily_admission_limit: 1 }, 1, 0)).toBe(false);
    expect(campaignCapacityAvailable({ max_enrollments: 25, daily_admission_limit: 1 }, 0, 1)).toBe(false);
  });
});
