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
  it('keeps queue labels tentative and the original observation intact', () => {
    const presentation = {label: 'example.test', basis: 'site_label', kind: 'unresolved', reason: 'Retained site label, identity unverified'};
    const parsed = manualProspectSchema.parse({...prospect, presentation});
    expect(parsed.observedName).toBe(prospect.observedName);
    expect(parsed.presentation).toEqual(presentation);
    expect(manualProspectSchema.safeParse({...prospect, presentation: {...presentation, basis: 'verified_company'}}).success).toBe(false);
  });
  it('distinguishes absence, missing extraction and unresolved conflict without inventing a value', () => {
    const states = [
      {state: 'not_extracted', reason: 'no_retained_phone_field'},
      {state: 'absent', basis: 'retained_source_declares_absent'},
      {state: 'conflicting', reason: 'retained_source_ambiguous', sources: []},
    ];
    for (const phoneEvidence of states) {
      expect(manualProspectSchema.safeParse({...prospect, phoneEvidence}).success).toBe(true);
      expect(manualProspectSchema.safeParse({...prospect, phoneEvidence, observedPhone: '+12125550123'}).success).toBe(false);
    }
    expect(manualProspectSchema.safeParse({...prospect, observedPhone: '+12125550123', phoneBasis: 'retained_observation'}).success).toBe(false);
  });
  it('requires exact retained provenance for an observed phone without granting contact authority', () => {
    const source = {runId: prospect.candidateId, observationId: prospect.candidateId, blockId: 'b1',
      url: 'https://example.test/contact', retrievedAt: prospect.retainedAt};
    const phoneEvidence = {state: 'observed', value: '+12125550123', sources: [source]};
    const observed = {...prospect, observedPhone: '+12125550123', phoneBasis: 'retained_observation', phoneEvidence};
    expect(manualProspectSchema.parse(observed).contactAuthority).toBe('not_granted');
    expect(manualProspectSchema.safeParse({...observed, observedPhone: '+12125550124'}).success).toBe(false);
    expect(manualProspectSchema.safeParse({...observed, phoneEvidence: {...phoneEvidence, sources: []}}).success).toBe(false);
  });
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
