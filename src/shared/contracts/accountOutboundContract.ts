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
/**
 * The one source of truth for call outcomes (design D13, David's decision of 17 Sep 2026).
 * `connected` stays for a reached call whose result David does not classify; `interested`,
 * `not_interested` and `gatekeeper` are the three classified connected results the sequence branches on.
 * None of these values authorize or record a call by themselves; they describe a human report.
 */
export const connectedCallOutcomes = ['connected', 'interested', 'not_interested', 'gatekeeper'] as const;
export type ConnectedCallOutcome = typeof connectedCallOutcomes[number];
/** Every outcome that reports an actual attempt. The three new connected results are appended, so stored order is stable. */
export const actualAccountCallOutcomes = ['connected', 'no_answer', 'voicemail', 'busy', 'wrong_number', 'interested', 'not_interested', 'gatekeeper'] as const;
/** The complete set a human may report for a consumed call handoff, actual attempts first. */
export const manualCallOutcomes = [...actualAccountCallOutcomes, 'cancelled', 'not_called', 'unknown', 'opt_out'] as const;
export type ManualCallOutcome = typeof manualCallOutcomes[number];
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
