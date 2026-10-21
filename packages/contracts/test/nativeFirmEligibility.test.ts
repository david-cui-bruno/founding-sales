import { describe, expect, it } from 'vitest';
import { nativeFirmEligibilitySchema } from '../src/nativeFirmEligibility.ts';
import { qualificationViewSchema } from '../src/sourcingQualification.ts';
const id = '243703e0-726f-453e-a5a8-eae645b43b2d';
const verified = () => ({
  status: 'verified', policyVersion: 'native-firm-eligibility-v1',
  promotionId: id, discoveryCandidateId: id, discoveryRevision: 1,
  candidateId: id, candidateRevision: 2, runId: id, firmId: id, ownerUserId: id,
  checkedAt: '2026-10-21T14:00:00Z', validUntil: '2026-10-22T14:00:00Z',
  citations: ['firm_identity', 'service_area', 'residential_management'].map(kind => ({
    kind, observationId: id, blockId: 'b1',
  })), channelAuthority: 'not_granted',
});
describe('current native Firm evidence, not channel authority', () => {
  it('requires all native evidence roles and exact current identities', () => {
    expect(nativeFirmEligibilitySchema.parse(verified())).toEqual(verified());
    expect(nativeFirmEligibilitySchema.safeParse({ ...verified(), candidateRevision: 0 }).success).toBe(false);
    expect(nativeFirmEligibilitySchema.safeParse({ ...verified(), citations: verified().citations.slice(0, 2) }).success).toBe(false);
  });
  it('refuses duplicate roles masquerading as complete evidence', () => {
    const citation = verified().citations[0];
    expect(nativeFirmEligibilitySchema.safeParse({ ...verified(), citations: [citation, citation, citation] }).success).toBe(false);
  });
  it('requires an unexpired result relative to its check', () => {
    for (const validUntil of ['2026-10-21T14:00:00Z', '2026-10-20T14:00:00Z'])
      expect(nativeFirmEligibilitySchema.safeParse({ ...verified(), validUntil }).success).toBe(false);
  });
  it('never accepts channel grants, copied content or unknown fields', () => {
    for (const extra of [{ channelAuthority: 'granted' }, { runtimeCallable: true }, { sourceText: 'copied' }])
      expect(nativeFirmEligibilitySchema.safeParse({ ...verified(), ...extra }).success).toBe(false);
  });
  it('bounds unavailable reasons without retaining old citations or IDs', () => {
    const pending = { status: 'pending', reason: 'latest_run_pending', channelAuthority: 'not_granted' };
    expect(nativeFirmEligibilitySchema.safeParse(pending).success).toBe(true);
    expect(nativeFirmEligibilitySchema.safeParse({ ...pending, reason: 'raw provider exception' }).success).toBe(false);
    expect(nativeFirmEligibilitySchema.safeParse({ ...pending, citations: verified().citations }).success).toBe(false);
  });
  it('preserves old qualification response compatibility and carries the optional online summary', () => {
    const view = { candidateId: id, runId: id, candidateRevision: 2, status: 'review', reason: null,
      requestedAt: '2026-10-21T14:00:00Z', deadlineAt: '2026-10-21T15:00:00Z',
      observations: [], facts: [], verdict: null, openingQuestion: null, admission: null, history: [] };
    expect(qualificationViewSchema.safeParse(view).success).toBe(true);
    expect(qualificationViewSchema.parse({ ...view, nativeEligibility: verified() }).nativeEligibility).toEqual(verified());
  });
});
