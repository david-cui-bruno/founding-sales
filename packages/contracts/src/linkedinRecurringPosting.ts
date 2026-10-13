import {z} from 'zod';
import {uuid} from './foundationRows.ts';
export const linkedinRecurringViewSchema=z.strictObject({
 holds:z.array(z.string()),
 items:z.array(z.strictObject({id:uuid,targetAt:z.string().datetime(),accountId:uuid,accountRevision:z.number().int().positive(),policyRevision:z.number().int().positive(),state:z.enum(['draft','review','skipped','queued','receipt','unknown_paused','revoked']),reason:z.string().nullable(),approvalKind:z.literal('standing_policy').nullable(),postId:uuid.nullable(),draftRequestId:uuid.nullable(),receiptId:z.string().nullable(),submissionId:uuid.nullable(),spendCents:z.number().int().nonnegative()})),
});
export type LinkedinRecurringView=z.infer<typeof linkedinRecurringViewSchema>;
