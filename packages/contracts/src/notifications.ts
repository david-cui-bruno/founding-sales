import { z } from 'zod';
import { commandIdSchema } from './auth.ts';
import { instant, uuid } from './foundationRows.ts';
import { semanticVersionSchema } from './clientVersion.ts';
import { todayActionSchema, todayActionTargetSchema } from './today.ts';

export const notificationPhaseSchema = z.enum(['attention', 'reply_overdue', 'pre_call']);
export const notificationReceiptSchema = z.strictObject({
  attemptId: uuid,
  deviceId: uuid,
  status: z.enum(['attempting', 'native_shown', 'acknowledged', 'failed', 'unknown']),
  attemptedAt: instant,
  nativeShownAt: instant.nullable(),
  acknowledgedAt: instant.nullable(),
  failedAt: instant.nullable(),
  unknownAt: instant.nullable(),
});
export const notificationCandidateSchema = todayActionSchema.extend({ eventKey: z.string().min(1).max(240), phase: notificationPhaseSchema });
export const notificationItemSchema = notificationCandidateSchema.extend({ receipt: notificationReceiptSchema.nullable() });
export const actionableNotificationsResponseSchema = z.strictObject({
  version: z.literal(1), workspaceId: uuid, userId: uuid, asOf: instant,
  items: z.array(notificationItemSchema),
  recoveries: z.array(z.strictObject({
    eventKey: z.string().min(1).max(240), actionId: z.string().min(1).max(180), target: todayActionTargetSchema,
    current: z.boolean(), receipt: notificationReceiptSchema,
  })),
});
const envelope = { commandId: commandIdSchema, clientVersion: semanticVersionSchema };
export const claimNotificationCommandSchema = z.strictObject({ ...envelope, eventKey: z.string().min(1).max(240) });
export const claimNotificationResultSchema = z.strictObject({ version: z.literal(1), item: notificationItemSchema.nullable() });
export const observeNotificationCommandSchema = z.strictObject({
  ...envelope, attemptId: uuid, observation: z.enum(['native_shown', 'failed', 'unknown']),
});
export const observeNotificationResultSchema = z.strictObject({ version: z.literal(1), recorded: z.boolean() });
export const acknowledgeNotificationCommandSchema = z.strictObject({ ...envelope, attemptId: uuid });
export const acknowledgeNotificationResultSchema = z.strictObject({ version: z.literal(1), target: todayActionTargetSchema.nullable() });
export const notificationRuntimeStatusSchema = z.strictObject({
  state: z.enum(['ready', 'offline', 'unavailable', 'unsupported', 'stopped']),
  lastCheckedAt: instant.nullable(),
});
export type NotificationPhase = z.infer<typeof notificationPhaseSchema>;
export type NotificationReceipt = z.infer<typeof notificationReceiptSchema>;
export type NotificationCandidate = z.infer<typeof notificationCandidateSchema>;
export type NotificationItem = z.infer<typeof notificationItemSchema>;
export type ActionableNotificationsResponse = z.infer<typeof actionableNotificationsResponseSchema>;
export type NotificationRuntimeStatus = z.infer<typeof notificationRuntimeStatusSchema>;
