import { describe, expect, it } from 'vitest';
import { qualifiedResearchCreateCommandSchema, qualifiedResearchSelectionSchema } from '../src/qualifiedResearch.ts';

const selection = {
  discoveryCandidateId: '11111111-1111-4111-8111-111111111111',
  discoveryRevision: 1,
  candidateId: '22222222-2222-4222-8222-222222222222',
  candidateRevision: 2,
  runId: '33333333-3333-4333-8333-333333333333',
};
describe('qualified research identity-only command boundary', () => {
  it('retains exact candidate/run revisions with the standard command envelope', () => {
    const input = { ...selection, commandId: '44444444-4444-4444-8444-444444444444', clientVersion: '1.0.56' };
    expect(qualifiedResearchCreateCommandSchema.parse(input)).toEqual(input);
  });
  it('refuses caller-provided facts, invented permission and malformed revisions', () => {
    expect(qualifiedResearchSelectionSchema.safeParse({ ...selection, facts: [] }).success).toBe(false);
    expect(qualifiedResearchSelectionSchema.safeParse({ ...selection, channelAuthority: 'granted' }).success).toBe(false);
    expect(qualifiedResearchSelectionSchema.safeParse({ ...selection, candidateRevision: 0 }).success).toBe(false);
  });
});
