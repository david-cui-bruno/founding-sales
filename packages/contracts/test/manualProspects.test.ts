import { describe, expect, it } from 'vitest';
import { manualPhoneChoiceSchema, manualProspectFeedbackInputSchema, manualProspectListInputSchema, manualProspectSchema } from '../src/manualProspects.ts';

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
  it('lets a standalone number be its own label but no other overlapping span form', () => {
    const choice = {runId: prospect.candidateId, observationId: prospect.candidateId, blockId: 'b1', contentHash: 'a'.repeat(64), relevantTextHash: 'b'.repeat(64)};
    expect(manualPhoneChoiceSchema.safeParse({...choice, labelStart: 0, labelEnd: 7, start: 9, end: 21}).success).toBe(true);
    expect(manualPhoneChoiceSchema.safeParse({...choice, labelStart: 2, labelEnd: 14, start: 2, end: 14}).success).toBe(true);
    for (const span of [{labelStart: 2, labelEnd: 13, start: 2, end: 14}, {labelStart: 3, labelEnd: 14, start: 2, end: 14}, {labelStart: 0, labelEnd: 10, start: 5, end: 14}])
      expect(manualPhoneChoiceSchema.safeParse({...choice, ...span}).success).toBe(false);
  });
  it('allows partial coverage to select a phone only for prepared own-site pages', () => {
    const literal = (authority: unknown) => ({method: 'retained_original_literal', runId: prospect.candidateId, observationId: prospect.candidateId, blockId: 'b1',
      url: 'https://example.test/contact', retrievedAt: prospect.retainedAt, contentHash: 'a'.repeat(64), relevantTextHash: 'b'.repeat(64), parser: 'manual-literal-phone-v2',
      literal: '212-555-0123', start: 7, end: 19, label: 'Phone:', labelStart: 0, labelEnd: 6, normalizedValue: '+12125550123',
      normalization: 'existing-canonicalize-phone-v1', normalizationBasis: 'default_us', authority, lineage: {kind: 'provider_original'}});
    const evidence = (authority: unknown, state: string) => ({state: 'observed', value: '+12125550123', sources: [literal(authority)],
      coverage: {parser: 'manual-literal-phone-v2', state, observations: 1, blocks: 2}});
    const observed = (phoneEvidence: unknown) => ({...prospect, observedPhone: '+12125550123', phoneBasis: 'retained_observation', phoneEvidence});
    const prepared = {kind: 'prepared_capture', sourceUrl: 'https://example.test/contact', expiresAt: '2026-11-07T01:00:00.000Z'};
    expect(manualProspectSchema.safeParse(observed(evidence(prepared, 'partial'))).success).toBe(true);
    expect(manualProspectSchema.safeParse(observed(evidence(prepared, 'complete'))).success).toBe(true);
    expect(manualProspectSchema.safeParse(observed(evidence({kind: 'candidate_source', sourceUrl: 'https://example.test/contact'}, 'partial'))).success).toBe(false);
    expect(manualProspectSchema.safeParse(observed(evidence(prepared, 'bounded'))).success).toBe(false);
    expect(manualProspectSchema.safeParse(observed(evidence({...prepared, extra: true}, 'partial'))).success).toBe(false);
  });
});
