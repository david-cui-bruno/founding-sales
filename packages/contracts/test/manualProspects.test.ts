import { describe, expect, it } from 'vitest';
import { manualProspectFeedbackInputSchema, manualProspectListInputSchema, manualProspectSchema } from '../src/manualProspects.ts';

const prospect = {
  candidateId: 'b385612c-cac8-43a3-a72d-fc2dd7d8553d', revision: 1,
  observedName: 'Unverified retained property manager', website: null, locality: null, region: null,
  observedPhone: null, phoneBasis: 'unknown', sources: [{ label: 'Retained source', url: null, observedAt: null }],
  sourceNotices: [], retainedAt: '2026-10-24T17:00:00.000Z', state: 'new', unknowns: ['Phone unknown'],
  possibleDuplicateCount: 0, qualification: 'unverified', contactAuthority: 'not_granted',
};
describe('manual retained prospect boundary', () => {
  it('preserves all sixteen origins with sixteen licenses and notices each', () => {
    const sourceNotices = Array.from({ length: 512 }, (_, index) => ({ label: `Notice ${index}`, url: null }));
    expect(manualProspectSchema.safeParse({ ...prospect, sourceNotices }).success).toBe(true);
    expect(manualProspectSchema.safeParse({ ...prospect, sourceNotices: [...sourceNotices, { label: 'Overflow', url: null }] }).success).toBe(false);
  });
  it('accepts a raw observation without phone, qualification or automatic owner', () => {
    expect(manualProspectSchema.safeParse(prospect).success).toBe(true);
  });
  it('cannot describe a raw prospect as qualified or contact-authorized', () => {
    expect(manualProspectSchema.safeParse({ ...prospect, qualification: 'qualified' }).success).toBe(false);
    expect(manualProspectSchema.safeParse({ ...prospect, contactAuthority: 'granted' }).success).toBe(false);
    expect(manualProspectSchema.safeParse({ ...prospect, firmId: prospect.candidateId }).success).toBe(false);
  });
  it('bounds explicit paging and separates manual feedback from candidate admission', () => {
    expect(manualProspectListInputSchema.safeParse({ state: 'all', offset: 0 }).success).toBe(true);
    expect(manualProspectListInputSchema.safeParse({ state: 'all', offset: -1 }).success).toBe(false);
    for (const state of ['kept', 'skipped', 'wrong_number']) {
      expect(manualProspectFeedbackInputSchema.safeParse({ candidateId: prospect.candidateId, expectedRevision: 1, state }).success).toBe(true);
    }
    expect(manualProspectFeedbackInputSchema.safeParse({ candidateId: prospect.candidateId, expectedRevision: 1, state: 'admitted' }).success).toBe(false);
  });
});
