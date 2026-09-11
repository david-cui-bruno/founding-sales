import { describe, expect, it } from 'vitest';
import { localCompanyInputSchema, localCompanyCreateRequestSchema, localCompanyReviewSchema, localCompanyCreateResultSchema, localCompanyCreateStatusSchema, localCompanyCandidateSignals } from '../../src/shared/contracts/localCompanyIntakeContract';
const input = { name: 'Example PM', domain: 'example.invalid' };
const account = { id: 'a', ...input, version: 1 };
const commandId = '11111111-1111-4111-8111-111111111111';
const review = { scope: 'local_database', input, candidates: [{ account, signals: ['same_name', 'same_domain'] }], complete: true };
describe('local company intake contract', () => {
  it('uses the existing canonical create payload and forbids invented authority', () => {
    expect(localCompanyInputSchema.parse({ ...input, name: ' Example PM ' })).toEqual(input);
    expect(localCompanyCreateRequestSchema.parse({ ...input, commandId })).toEqual({ ...input, commandId });
    for (const invalid of [{ ...input, domain: 'EXAMPLE.INVALID' }, { ...input, domain: 'https://example.invalid' }, { ...input, name: '' }, { ...input, createAnyway: true }]) expect(localCompanyInputSchema.safeParse(invalid).success).toBe(false);
    expect(localCompanyCreateRequestSchema.safeParse({ ...input, commandId, confirmed: true }).success).toBe(false);
  });
  it('matches only ASCII folded trimmed names or the entire nonnull domain', () => {
    expect(localCompanyCandidateSignals(input, { ...account, name: ' example pm ' })).toEqual(['same_name', 'same_domain']);
    expect(localCompanyCandidateSignals(input, { ...account, name: 'Other' })).toEqual(['same_domain']);
    expect(localCompanyCandidateSignals(input, { ...account, domain: null })).toEqual(['same_name']);
    expect(localCompanyCandidateSignals({ name: 'É PM', domain: null }, { ...account, name: 'é pm', domain: null })).toEqual([]);
    expect(localCompanyCandidateSignals(input, { ...account, name: 'Example PM LLC', domain: 'www.example.invalid' })).toEqual([]);
  });
  it('rejects duplicate, unsorted, invented, inconsistent or truncated candidate envelopes', () => {
    expect(localCompanyReviewSchema.parse(review)).toEqual(review);
    for (const invalid of [
      { ...review, candidates: [review.candidates[0], review.candidates[0]] },
      { ...review, candidates: [{ account: { ...account, id: 'b' }, signals: ['same_name', 'same_domain'] }, review.candidates[0]] },
      { ...review, candidates: [{ account, signals: [] }] },
      { ...review, candidates: [{ account, signals: ['same_name', 'same_name'] }] },
      { ...review, candidates: [{ account, signals: ['same_name'] }] },
      { ...review, candidates: [{ account: { ...account, name: 'Other', domain: null }, signals: ['same_domain'] }] },
      { ...review, candidates: Array.from({ length: 51 }, (_, i) => ({ account: { ...account, id: String(i).padStart(3, '0') }, signals: ['same_name', 'same_domain'] })) },
      { ...review, trusted: true },
    ]) expect(localCompanyReviewSchema.safeParse(invalid).success).toBe(false);
  });
  it('keeps saved create and read-only status distinct and rejects unknown outcomes', () => {
    const saved = { status: 'saved', commandId, account };
    expect(localCompanyCreateResultSchema.safeParse({ ...saved, replayed: false }).success).toBe(true);
    expect(localCompanyCreateStatusSchema.safeParse(saved).success).toBe(true);
    expect(localCompanyCreateResultSchema.safeParse(saved).success).toBe(false);
    expect(localCompanyCreateStatusSchema.safeParse({ ...saved, replayed: false }).success).toBe(false);
    expect(localCompanyCreateResultSchema.safeParse({ status: 'not_recorded', commandId }).success).toBe(false);
    expect(localCompanyCreateStatusSchema.safeParse({ status: 'not_recorded', commandId }).success).toBe(true);
    expect(localCompanyCreateResultSchema.safeParse({ status: 'needs_review', commandId, review }).success).toBe(true);
    expect(localCompanyCreateResultSchema.safeParse({ status: 'needs_review', commandId, review: { ...review, candidates: [] } }).success).toBe(false);
    expect(localCompanyCreateStatusSchema.safeParse({ ...saved, account: { ...account, version: 2 } }).success).toBe(false);
    expect(localCompanyCreateResultSchema.safeParse({ ...saved, replayed: true, account: { ...account, version: 2 } }).success).toBe(false);
    for (const schema of [localCompanyCreateResultSchema, localCompanyCreateStatusSchema]) {
      expect(schema.safeParse({ status: 'command_conflict', commandId }).success).toBe(true);
      expect(schema.safeParse({ status: 'unknown', commandId }).success).toBe(false);
    }
  });
});

it('validates SQLite UTF8 BINARY order rather than UTF16 code-unit order', () => {
  const bmp = { ...review.candidates[0], account: { ...account, id: 'a-\uE000' } };
  const astral = { ...review.candidates[0], account: { ...account, id: 'a-\u{10000}' } };
  expect(localCompanyReviewSchema.safeParse({ ...review, candidates: [bmp, astral] }).success).toBe(true);
  expect(localCompanyReviewSchema.safeParse({ ...review, candidates: [astral, bmp] }).success).toBe(false);
  expect(localCompanyReviewSchema.safeParse({ ...review, candidates: [bmp, bmp] }).success).toBe(false);
});
