import { z } from 'zod';
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const common = { version: z.literal(1), requestId: z.string().uuid(), workspaceId: z.string().min(1).max(255), pairingId: z.string().uuid(), mailboxSubject: z.string().min(1).max(255), expectedRevision: integer.positive().nullable() };
/** Automatic warm-up for the daily sender cap (David's decision of 17 September 2026:
 * start at 10 a day, add 2 per calendar day, ceiling 40). A ramp is arithmetic over
 * recorded facts, never a permission: it can only slow a sender down. */
export const senderRampSchema = z.strictObject({
  startPerDay: integer.positive().max(10000), stepPerDay: integer.max(10000), maxPerDay: integer.positive().max(10000),
}).refine(ramp => ramp.maxPerDay >= ramp.startPerDay, 'sender_ramp_ceiling_below_start');
export type SenderRamp = z.infer<typeof senderRampSchema>;
export const SENDER_RAMP_DEFAULT: SenderRamp = { startPerDay: 10, stepPerDay: 2, maxPerDay: 40 };
/** The ceiling may never exceed the flat limit, so today's cap is bounded by both. */
export const senderCapPolicySchema = z.strictObject({ sender: z.email(), dailyLimit: integer, ramp: senderRampSchema.optional() })
  .refine(policy => !policy.ramp || policy.ramp.maxPerDay <= policy.dailyLimit, 'sender_ramp_exceeds_daily_limit');
export type SenderCapPolicy = z.infer<typeof senderCapPolicySchema>;
/** The instant of the first recorded send for this sender, as the worker wrote it once. */
export const senderFirstSendSchema = z.strictObject({ sender: z.email(), firstSendAt: z.string().datetime() });
/** A read of arithmetic over recorded facts. Never a claim that a send is permitted. */
export const senderCapStatusSchema = z.strictObject({
  today: integer,
  position: z.strictObject({ day: integer.positive(), startPerDay: integer, stepPerDay: integer, maxPerDay: integer }).nullable(),
  firstSendAt: z.string().datetime().nullable(),
});
export type SenderCapStatus = z.infer<typeof senderCapStatusSchema>;
const utcDay = (instant: string) => Date.parse(`${instant.slice(0, 10)}T00:00:00.000Z`);
/** UTC calendar days since the recorded first send, so a step lands at midnight UTC and
 * never on an elapsed-hours boundary. A clock that moved backwards stays on day one. */
export function senderRampDays(firstSendAt: string | null, now: string): number {
  if (firstSendAt === null) return 0;
  const days = Math.floor((utcDay(now) - utcDay(firstSendAt)) / 86400000);
  return Number.isFinite(days) && days > 0 ? days : 0;
}
/** Absent ramp keeps today's behaviour exactly: the flat `dailyLimit` every day. */
export function senderCapForDay(policy: Pick<SenderCapPolicy, 'dailyLimit' | 'ramp'>, firstSendAt: string | null, now: string): SenderCapStatus {
  if (!policy.ramp) return { today: policy.dailyLimit, position: null, firstSendAt };
  const days = senderRampDays(firstSendAt, now);
  return { today: Math.min(policy.ramp.maxPerDay, policy.ramp.startPerDay + policy.ramp.stepPerDay * days),
    position: { day: days + 1, ...policy.ramp }, firstSendAt };
}
/** Only sender caps remain; the meeting-rules request went with calendar meetings on 18 September 2026. */
export const workerPolicyRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...common, kind: z.literal('sender-caps'), policy: senderCapPolicySchema }),
]);
export type WorkerPolicyRequest = z.infer<typeof workerPolicyRequestSchema>;
/** Historical applied receipt, not a claim about current settings or provider access. */
export const workerPolicyReceiptSchema = z.strictObject({ requestId: z.string().uuid(), kind: z.literal('sender-caps'), status: z.literal('applied'), revision: integer.positive(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) });
export type WorkerPolicyReceipt = z.infer<typeof workerPolicyReceiptSchema>;
