import { z } from 'zod';

import {
  leadPriorityContextSchema,
  lifecycleStageSchema,
  personIdSchema,
  primaryActionSchema,
  salesCycleIdSchema,
} from './commonContract';

export const todayLaneIdSchema = z.enum([
  'onboarding', 'fresh_inbound', 'overdue', 'post_interview_offer', 'due_cadence', 'new_p0', 'p1', 'exploration', 'later',
]);
export const todayItemSchema = z.object({
  id: z.string().min(1), lane: todayLaneIdSchema, personId: personIdSchema, salesCycleId: salesCycleIdSchema,
  personName: z.string().min(1), contextLabel: z.string().nullable(), stage: lifecycleStageSchema,
  priorityContext: leadPriorityContextSchema.nullable(), action: primaryActionSchema, reason: z.string().min(1),
  activeTriggers: z.array(z.object({ label: z.string(), expiresAt: z.string().datetime({ offset: true }).nullable() }).strict()),
  verifyFirst: z.boolean(), pinned: z.boolean(), consentRequirement: z.string().nullable(),
}).strict();
export const todaySnapshotSchema = z.object({
  lanes: z.array(z.object({ id: todayLaneIdSchema, items: z.array(todayItemSchema) }).strict()),
  dialBudget: z.number().int().nonnegative(), scheduledDials: z.number().int().nonnegative(),
  conversationTarget: z.number().int().nonnegative(), reviewErrorCount: z.number().int().nonnegative(), revision: z.number().int().nonnegative(),
}).strict();

export const completeActionRequestSchema = z.object({
  salesCycleId: salesCycleIdSchema,
  actionId: z.string().min(1),
  outcome: z.enum([
    'answered', 'no_answer', 'voicemail_left', 'accepted', 'failed', 'replied',
    'opted_out', 'channel_unavailable', 'marked_impossible', 'resolved',
  ]),
  activityId: z.string().min(1).nullable(),
}).strict();

export const snoozeActionRequestSchema = z.object({
  salesCycleId: salesCycleIdSchema,
  reason: z.string().min(1),
  expiresAt: z.string().datetime({ offset: true }),
  comparedSalesCycleId: salesCycleIdSchema,
}).strict();

export const pinActionRequestSchema = z.object({
  salesCycleId: salesCycleIdSchema,
  reason: z.string().min(1),
  expiresAt: z.string().datetime({ offset: true }),
  comparedSalesCycleId: salesCycleIdSchema,
}).strict();

export const logPastActivityRequestSchema = z.object({
  personId: personIdSchema,
  salesCycleId: salesCycleIdSchema.nullable(),
  kind: z.enum(['call', 'voicemail', 'text', 'email', 'note']),
  direction: z.enum(['inbound', 'outbound', 'internal']),
  occurredAt: z.string().datetime({ offset: true }),
  summary: z.string().min(1).max(2000),
  outcome: z.string().max(200).nullable(),
}).strict();

export type TodayLaneId = z.infer<typeof todayLaneIdSchema>;
export type TodayItem = z.infer<typeof todayItemSchema>;
export type TodaySnapshot = z.infer<typeof todaySnapshotSchema>;
export type CompleteActionRequest = z.infer<typeof completeActionRequestSchema>;
export type SnoozeActionRequest = z.infer<typeof snoozeActionRequestSchema>;
export type PinActionRequest = z.infer<typeof pinActionRequestSchema>;
export type LogPastActivityRequest = z.infer<typeof logPastActivityRequestSchema>;
