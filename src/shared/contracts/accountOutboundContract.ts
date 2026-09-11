import { z } from 'zod';
import { accountIdSchema, accountInstantSchema } from './accountContract';

export const accountOutboundRequestSchema = z.object({
  commandId: accountIdSchema, accountId: accountIdSchema, routeId: accountIdSchema,
  expectedRouteVersion: z.number().int().positive(), expectedEvidenceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  channel: z.enum(['call', 'email']),
}).strict();
export type AccountOutboundRequest = z.infer<typeof accountOutboundRequestSchema>;
export type AccountRouteAuthorization = { kind: 'allowed'; canonicalTarget: string; contextRevision: string } | { kind: 'blocked'; reason: string };
export const accountOutboundReceiptSchema = z.object({
  commandId: accountIdSchema, accountId: accountIdSchema, attemptId: accountIdSchema.nullable(),
  status: z.enum(['refused', 'unavailable', 'unknown', 'handoff_accepted']), reason: z.string().min(1).max(200).nullable(),
}).strict();
export type AccountOutboundReceipt = { commandId: string; accountId: string; attemptId: string | null;
  status: 'refused' | 'unavailable' | 'unknown' | 'handoff_accepted'; reason: string | null };
export const actualAccountCallOutcomes = ['connected', 'no_answer', 'voicemail', 'busy', 'wrong_number'] as const;
export const accountCallOutcomeSchema = z.enum([...actualAccountCallOutcomes, 'cancelled', 'not_called']);
export const accountCallReportSchema = z.object({ commandId: accountIdSchema, attemptId: accountIdSchema,
  outcome: accountCallOutcomeSchema, notes: z.string().max(4000).nullable() }).strict();
export type AccountCallReport = { commandId: string; attemptId: string; outcome: z.infer<typeof accountCallOutcomeSchema>; notes: string | null };
export type AccountCallReportReceipt = AccountCallReport & { accountId: string; reportedAt: string };
export const accountCallRangeSchema = z.object({ from: accountInstantSchema, to: accountInstantSchema }).strict().refine(v => v.from < v.to);
export type AccountCallRange = z.infer<typeof accountCallRangeSchema>;
export type ActualAccountCallAttempt = { accountId: string; commandId: string; attemptId: string;
  outcome: typeof actualAccountCallOutcomes[number]; reportedAt: string };
export const accountCallEvidenceSchema = z.object({ version: z.literal(1), source: z.literal('user_report'),
  outcome: accountCallOutcomeSchema, notes: z.string().max(4000).nullable() }).strict();
