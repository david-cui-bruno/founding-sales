import { expect, it } from 'vitest';
import { openingSnapshotCurrent, openingSnapshotKey, prefixCampaignOpening, resolveCampaignOpening } from '../../outreach/campaignOpening.ts';
import { id, other, now, openingFixture } from './campaignOpeningFixture.ts';
const choice = { variantId: 'local', citationIds: [`${id}:native`] };
it('resolves only an approved variant from exact current source values and leaves baseline bytes untouched', () => {
  const opening = resolveCampaignOpening(openingFixture(), choice, now);
  expect(opening).toBe('I noticed Fictional Homes serves Dallas, TX.');
  const baseline = { subject: '  Original subject é  ', body: '\r\nOriginal offer\r\n\n$17, not another promise.\n CTA  \n\nSam\nCallie' };
  const result = prefixCampaignOpening(baseline, opening!);
  expect(result.subject).toBe(baseline.subject);
  expect(Buffer.from(result.body.slice(opening!.length + 2))).toEqual(Buffer.from(baseline.body));
});
it.each([
  { ...choice, text: 'Unapproved model prose' }, { ...choice, variantId: 'foreign' },
  { ...choice, citationIds: [`${other}:native`] }, { ...choice, citationIds: [] },
  { ...choice, citationIds: [`${id}:native`, `${id}:native`] },
])('rejects free-form output and foreign/missing/duplicate evidence: %j', output => {
  expect(resolveCampaignOpening(openingFixture(), output, now)).toBeNull();
});
it.each(['workspaceId', 'ownerUserId', 'campaignId', 'sequenceVersionId', 'templateVersionId', 'policyId'] as const)('binds exact %s, no name fallback', key => {
  const snapshot = openingFixture(); snapshot.binding[key] = other;
  expect(resolveCampaignOpening(snapshot, choice, now)).toBeNull();
});
it.each(['\nInjected', '<private>', '\u0000', '{{private_note}}', '\u202ehidden'])('refuses unsafe source substitution %j', value => {
  const snapshot = openingFixture(); snapshot.source.firmName = value;
  expect(resolveCampaignOpening(snapshot, choice, now)).toBeNull();
});
it('uses wall-time expiry and rejects policy/template revision drift', () => {
  const snapshot = openingFixture();
  expect(openingSnapshotCurrent(snapshot, snapshot.binding.validUntil)).toBe(false);
  expect(resolveCampaignOpening(snapshot, choice, '2026-10-26T11:00:00.000Z')).toBeNull();
  snapshot.binding.templateContentHash = 'c'.repeat(64);
  expect(resolveCampaignOpening(snapshot, choice, now)).toBeNull();
  snapshot.binding.templateContentHash = snapshot.policy.templateContentHash;
  snapshot.binding.campaignRevision += 1;
  expect(resolveCampaignOpening(snapshot, choice, now)).toBeNull();
});
it('snapshot identity includes source, current citation set, expiry and full immutable policy', () => {
  const baseline = openingFixture(), key = openingSnapshotKey(baseline);
  for (const change of [
    (s: typeof baseline) => { s.source.locality = 'Austin'; },
    (s: typeof baseline) => { s.binding.sourceFingerprint = 'c'.repeat(64); },
    (s: typeof baseline) => { s.binding.validUntil = '2026-10-27T13:00:00.000Z'; },
    (s: typeof baseline) => { s.policy.variants[0]!.text = 'Different approval'; },
  ]) { const snapshot = openingFixture(); change(snapshot); expect(openingSnapshotKey(snapshot)).not.toBe(key); }
});
