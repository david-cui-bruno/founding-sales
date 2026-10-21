import {describe, expect, it} from 'vitest';
import {discoveryReviewCommandSchema, discoveryReviewInputSchema, discoveryUsefulListInputSchema} from '../src/discoveryReview.ts';

const input = () => ({
  candidateId: '243703e0-726f-453e-a5a8-eae645b43b2d', expectedRevision: 1,
  reviewVersion: 'discovery-review-v1',
  evidence: [{source: {provider: 'overture_places', release: '2026-09-23.1', recordId: 'branch-1'},
    url: 'https://example.org/services', contentHash: 'a'.repeat(64), retrievedAt: '2026-10-21T03:00:00Z',
    completeness: 'partial', association: 'unknown', basis: 'retained_excerpt',
    blocks: [{blockId: 'b1', kind: 'paragraph', text: 'We provide residential property management services.'}]}],
  assessment: {serviceSignal: 'paragraph_supported', websiteAssociation: 'unknown', unknowns: ['firm_identity', 'office_phone']},
});
describe('human-reviewed discovery prioritization, not qualification', () => {
  it('preserves partial service signals and unknown identity without contact prerequisites', () => {
    expect(discoveryReviewInputSchema.parse(input())).toEqual(input());
  });
  it('refuses heading-only paragraph claims and evidence-free interpretations', () => {
    const value = input();
    value.evidence[0]!.blocks[0]!.kind = 'heading';
    expect(discoveryReviewInputSchema.safeParse(value).success).toBe(false);
    expect(discoveryReviewInputSchema.safeParse({...input(), evidence: []}).success).toBe(false);
  });
  it('refuses arbitrary body/contact fields and duplicate block identities', () => {
    const value = input();
    expect(discoveryReviewInputSchema.safeParse({...value, email: 'unrelated@example.org'}).success).toBe(false);
    value.evidence[0]!.blocks.push({...value.evidence[0]!.blocks[0]!});
    expect(discoveryReviewInputSchema.safeParse(value).success).toBe(false);
  });
  it('bounds UTF-8 excerpts and preserves normal command identity', () => {
    const value = input();
    value.evidence[0]!.blocks = Array.from({length: 20}, (_, index) => ({blockId: `b${index}`, kind: 'paragraph', text: '界'.repeat(1900)}));
    expect(discoveryReviewInputSchema.safeParse(value).success).toBe(false);
    const good = input();
    expect(discoveryReviewCommandSchema.safeParse({...good, commandId: good.candidateId, clientVersion: '1.0.56'}).success).toBe(true);
  });
  it('allows nationwide useful-list paging without qualification or contact gating', () => {
    expect(discoveryUsefulListInputSchema.parse({status: 'needs_review', offset: 0, band: 'unreviewed'})).toBeDefined();
  });
});
