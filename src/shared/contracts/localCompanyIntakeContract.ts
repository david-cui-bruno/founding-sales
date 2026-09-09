import { z } from 'zod';
import { accountCreateSchema, accountSchema, type Account } from './accountContract';
export const localCompanyInputSchema = accountSchema.pick({ name: true, domain: true });
export const localCompanyCreateRequestSchema = accountCreateSchema;
export type LocalCompanyInput = z.infer<typeof localCompanyInputSchema>;
export type LocalCompanyCreateRequest = z.infer<typeof localCompanyCreateRequestSchema>;
/** Deliberately not Unicode folding, fuzzy identity, or registrable-domain matching. */
const comparisonName = (name: string) => name.trim().replace(/[A-Z]/g, letter => letter.toLowerCase());
export function localCompanyCandidateSignals(input: LocalCompanyInput, account: Account): ('same_name' | 'same_domain')[] {
  const signals: ('same_name' | 'same_domain')[] = [];
  if (comparisonName(input.name) === comparisonName(account.name)) signals.push('same_name');
  if (input.domain !== null && input.domain === account.domain) signals.push('same_domain');
  return signals;
}
/** Match SQLite's UTF8 BINARY collation, not JavaScript's UTF16 code-unit order.
 * Keep the database's global ordering intact, including across LIMIT boundaries. */
function compareAccountIds(left: string, right: string): number {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}
export const localCompanyReviewSchema = z.strictObject({
  scope: z.literal('local_database'), input: localCompanyInputSchema,
  candidates: z.array(z.strictObject({ account: accountSchema, signals: z.array(z.enum(['same_name', 'same_domain'])).min(1).max(2) })).max(50),
  complete: z.boolean(),
}).refine(review => review.candidates.every((candidate, index) => {
  const expected = localCompanyCandidateSignals(review.input, candidate.account);
  return (index === 0 || compareAccountIds(review.candidates[index - 1].account.id, candidate.account.id) < 0)
    && candidate.signals.length === expected.length
    && new Set(candidate.signals).size === candidate.signals.length
    && expected.every(signal => candidate.signals.includes(signal));
}), 'Invalid local company candidate identity or signals');
export type LocalCompanyReview = z.infer<typeof localCompanyReviewSchema>;
const commandId = z.uuid();
const conflict = z.strictObject({ status: z.literal('command_conflict'), commandId });
const saved = z.strictObject({ status: z.literal('saved'), commandId, account: accountSchema.refine(account => account.version === 1, 'Expected original creation receipt') });
export const localCompanyCreateResultSchema = z.discriminatedUnion('status', [saved.extend({ replayed: z.boolean() }), z.strictObject({ status: z.literal('needs_review'), commandId, review: localCompanyReviewSchema.refine(review => !review.complete || review.candidates.length > 0, 'Review hold requires candidates or incomplete lookup') }), conflict]);
export const localCompanyCreateStatusSchema = z.discriminatedUnion('status', [saved, z.strictObject({ status: z.literal('not_recorded'), commandId }), conflict]);
export type LocalCompanyCreateResult = z.infer<typeof localCompanyCreateResultSchema>;
export type LocalCompanyCreateStatus = z.infer<typeof localCompanyCreateStatusSchema>;
