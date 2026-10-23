import { z } from 'zod';
import { instant, uuid } from './foundationRows.ts';

/** A current metadata observation, never a qualification, paid-work or channel grant. */
export const candidateAuthorityReadSchema = z.strictObject({
  candidateId: uuid,
  expectedRevision: z.number().int().positive(),
});
export const candidateAuthorityViewSchema = z.strictObject({
  candidateId: uuid,
  candidateRevision: z.number().int().positive(),
  checkedAt: instant,
  source: z.discriminatedUnion('status', [
    z.strictObject({
      status: z.literal('matched'),
      kind: z.enum(['search_hit', 'apollo_organization']),
      attemptId: uuid,
    }),
    z.strictObject({ status: z.literal('unavailable') }),
  ]),
  owner: z.enum(['current_admin', 'unavailable']),
  researchEnabled: z.boolean(),
  holds: z.enum(['clear', 'held', 'unknown']),
  authority: z.literal('not_granted'),
});
export type CandidateAuthorityRead = z.infer<typeof candidateAuthorityReadSchema>;
export type CandidateAuthorityView = z.infer<typeof candidateAuthorityViewSchema>;
