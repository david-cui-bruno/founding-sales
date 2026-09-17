import { describe, expect, it } from 'vitest';
import { researchSetupApproveInputSchema, researchReviewedCapabilitySchema } from '../../../../src/shared/contracts/researchSetupContract';
import { ownerResearchConfigurationSchema } from '../../../../src/shared/contracts/ownerCommandContract';

const descriptor = { capability: { model: 'fictional-reviewed-model', webSearch: true as const, searchCostMicros: 40, modelCostMicros: 40 }, reviewedAt: '2026-09-15T00:00:00.000Z', expiresAt: '2026-09-16T00:00:00.000Z', provenance: 'Fictional operator review. Not live access or invoice proof.', researchReservationMicros: 100, currency: 'USD' as const };
const base = { expectedRevision: 0 as const, descriptorFingerprint: 'a'.repeat(64), audience: { residential: true as const, regions: ['Providence, RI', 'Boston, MA'], terms: ['property management company'] },
  permittedSources: ['https://fictional.example/'], maxCompanies: 1, maxPages: 1, maxBytes: 10000, discoveryCeilingMicros: 80, researchCeilingMicros: 100, disclosureAcknowledged: true as const };
const limits = { maxCompanies: 20, maxPages: 1, maxBytes: 10000, maxCostMicros: 35000 };
const configuration = { workspaceId: 'ws', budgetId: 'guided-research-v1', audience: base.audience, audienceRevision: 1, sourceRevision: 1, budgetRevision: 1,
  discoveryLimits: limits, researchLimits: { ...limits, maxCostMicros: 100 }, capability: descriptor.capability, maxAccountBudgetMicros: 100, permittedSources: [], preparationCommandId: '00000000-0000-4000-a000-000000000001' };

describe('research setup approve schema with a discovery provider', () => {
  it('still rejects a cited configuration without permitted sources and never adds a provider key to it', () => {
    expect(researchSetupApproveInputSchema.safeParse({ ...base, permittedSources: [] }).success).toBe(false);
    expect(researchSetupApproveInputSchema.safeParse({ ...base, discoveryProvider: 'responses_cited', permittedSources: [] }).success).toBe(false);
    const parsed = researchSetupApproveInputSchema.parse(base);
    expect('discoveryProvider' in parsed).toBe(false);
    expect(parsed).toEqual(base);
  });
  it('accepts the Places territory shape without permitted sources and caps companies per batch at the page size', () => {
    const places = { ...base, discoveryProvider: 'places' as const, permittedSources: [], maxCompanies: 20, discoveryCeilingMicros: 3500000 };
    expect(researchSetupApproveInputSchema.parse(places)).toEqual(places);
    expect(researchSetupApproveInputSchema.safeParse({ ...places, maxCompanies: 21 }).success).toBe(false);
    expect(researchSetupApproveInputSchema.safeParse({ ...places, discoveryProvider: 'yellow_pages' }).success).toBe(false);
  });
  it('lets the reviewed descriptor carry an optional Enterprise SKU cost per Places call without changing cited descriptors', () => {
    expect(researchReviewedCapabilitySchema.parse({ ...descriptor, placesSearchCostMicros: 35000 }).placesSearchCostMicros).toBe(35000);
    expect(researchReviewedCapabilitySchema.parse(descriptor)).toEqual(descriptor);
    expect(researchReviewedCapabilitySchema.safeParse({ ...descriptor, placesSearchCostMicros: 34999 }).success).toBe(false);
  });
  it('stores a Places owner configuration only with an explicit provider and a page-sized batch', () => {
    expect(ownerResearchConfigurationSchema.parse({ ...configuration, discoveryProvider: 'places' }).discoveryProvider).toBe('places');
    expect('discoveryProvider' in ownerResearchConfigurationSchema.parse({ ...configuration, permittedSources: ['https://fictional.example/'] })).toBe(false);
    expect(ownerResearchConfigurationSchema.safeParse({ ...configuration, discoveryProvider: 'places', discoveryLimits: { ...limits, maxCompanies: 21 } }).success).toBe(false);
  });
});
