import { describe, expect, it } from 'vitest';
import {legacyCandidateInputSchema} from '../src/sourcing.ts';
import { discoveryPromotionCommandSchema, discoveryPromotionInputSchema, discoveryPromotionSavedSchema,
  discoveryResearchFirmLinkCommandSchema, discoveryResearchFirmLinkSavedSchema } from '../src/discoveryPromotion.ts';
const id = '243703e0-726f-453e-a5a8-eae645b43b2d';
const input = () => ({
  discoveryCandidateId: id, expectedRevision: 1,
  source: { provider: 'overture_places', release: '2026-09-23.1', recordId: 'record-1' },
  candidate: { firmName: 'Example Management', website: 'https://example.org/', locality: 'Austin', region: 'TX',
    signal: 'fit_only', evidence: 'Human-entered service seed, awaiting source verification.',
    sourceUrl: 'https://example.org/', observedOn: '2026-10-21', preparedBy: 'Owner review' },
});
describe('discovery preparation, not qualification authority', () => {
  it('links an explicit ordinary Firm using IDs without requiring phone or zone', () => {
    expect(discoveryResearchFirmLinkCommandSchema.safeParse({ discoveryCandidateId: id, expectedRevision: 1,
      qualificationCandidateId: id, firmId: id, commandId: id, clientVersion: '1.0.56' }).success).toBe(true);
  });
  it('cannot label research draft linkage qualified or runtime authorized', () => {
    const value = { discoveryCandidateId: id, qualificationCandidateId: id, firmId: id, alreadyLinked: false,
      nextAction: 'review_firm_research', qualified: false, admissionAuthorized: false, runtimeCallable: false };
    expect(discoveryResearchFirmLinkSavedSchema.safeParse(value).success).toBe(true);
    for (const key of ['qualified', 'admissionAuthorized', 'runtimeCallable']) {
      expect(discoveryResearchFirmLinkSavedSchema.safeParse({ ...value, [key]: true }).success).toBe(false);
    }
  });
  it('accepts explicit normal seed and revision-bound exact source identity', () => {
    expect(discoveryPromotionInputSchema.parse(input())).toEqual(input());
    expect(discoveryPromotionCommandSchema.safeParse({ ...input(), commandId: id, clientVersion: '1.0.56' }).success).toBe(true);
  });
  it.each([null, 'http://example.org/', 'example.org'])('does not coerce missing or unsupported website %s', website => {
    const value = input();
    expect(discoveryPromotionInputSchema.safeParse({ ...value, candidate: { ...value.candidate, website } }).success).toBe(false);
  });
  it('accepts current US ordinary preparation while the strict legacy schema stays closed', () => {
    const value=input(),current={...value,candidate:{...value.candidate,locality:'Sacramento',region:'CA'}};
    expect(discoveryPromotionInputSchema.safeParse(current).success).toBe(true);
    expect(legacyCandidateInputSchema.safeParse(current.candidate).success).toBe(false);
    expect(legacyCandidateInputSchema.safeParse(value.candidate).success).toBe(true);
  });
  it('refuses unsupported geography and missing locality', () => {
    const value = input();
    for (const replacement of [{ region: 'ON' }, { locality: null }, {locality:''}]) {
      expect(discoveryPromotionInputSchema.safeParse({ ...value, candidate: { ...value.candidate, ...replacement } }).success).toBe(false);
    }
  });
  it('refuses zero revisions, invented native evidence and permission fields', () => {
    expect(discoveryPromotionInputSchema.safeParse({ ...input(), expectedRevision: 0 }).success).toBe(false);
    expect(discoveryPromotionInputSchema.safeParse({ ...input(), nativeObservation: {} }).success).toBe(false);
    expect(discoveryPromotionInputSchema.safeParse({ ...input(), admissionAuthorized: true }).success).toBe(false);
  });
  it('requires ordinary command envelope', () => {
    expect(discoveryPromotionCommandSchema.safeParse(input()).success).toBe(false);
  });
  it('cannot return preparation as requested qualification, admission or runtime authority', () => {
    const result = { discoveryCandidateId: id, discoveryRevision: 1, qualificationCandidateId: id,
      alreadyPrepared: false, nextAction: 'review_source_and_request_qualification',
      qualificationRequested: false, admissionAuthorized: false, runtimeCallable: false };
    expect(discoveryPromotionSavedSchema.safeParse(result).success).toBe(true);
    for (const key of ['qualificationRequested', 'admissionAuthorized', 'runtimeCallable']) {
      expect(discoveryPromotionSavedSchema.safeParse({ ...result, [key]: true }).success).toBe(false);
    }
  });
});
