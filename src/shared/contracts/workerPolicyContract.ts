import { z } from 'zod';
import { schedulingRulesSchema } from './meetingContract';
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const policyRulesSchema = schedulingRulesSchema.refine(rules => {
  try { new Intl.DateTimeFormat('en-US', { timeZone: rules.timezone }).format(0); } catch { return false; }
  return new Set(rules.conflictCalendarIds).size === rules.conflictCalendarIds.length
    && rules.weeklyWindows.every(window => window.start < window.end)
    && new Set(rules.weeklyWindows.map(window => `${window.weekday}:${window.start}:${window.end}`)).size === rules.weeklyWindows.length;
}, 'policy_rules_invalid');
const common = { version: z.literal(1), requestId: z.string().uuid(), workspaceId: z.string().min(1).max(255), pairingId: z.string().uuid(), mailboxSubject: z.string().min(1).max(255), expectedRevision: integer.positive().nullable() };
export const workerPolicyRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...common, kind: z.literal('sender-caps'), policy: z.strictObject({ sender: z.email(), dailyLimit: integer }) }),
  z.strictObject({ ...common, kind: z.literal('meeting-rules'), rules: policyRulesSchema }),
]);
export type WorkerPolicyRequest = z.infer<typeof workerPolicyRequestSchema>;
/** Historical applied receipt, not a claim about current settings or provider access. */
export const workerPolicyReceiptSchema = z.strictObject({ requestId: z.string().uuid(), kind: z.enum(['sender-caps', 'meeting-rules']), status: z.literal('applied'), revision: integer.positive(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) });
export type WorkerPolicyReceipt = z.infer<typeof workerPolicyReceiptSchema>;
