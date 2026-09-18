import { z } from 'zod';

import {
  leadPriorityContextSchema,
  lifecycleStageSchema,
  personIdSchema,
  primaryActionSchema,
  salesCycleIdSchema,
} from './commonContract';
import { cloudScoreChipSchema } from './leadsContract';
import { REPLY_TEMPLATE_IDS } from './replyTemplateContract';

/**
 * Stable lane IDs for the dated playbook. Main owns due-time, warm-priority
 * and commitment ordering. Renderers preserve the supplied order.
 */
export const todayLaneIdSchema = z.enum([
  'onboarding', 'fresh_inbound', 'due_cadence', 'new_p0', 'p1', 'exploration', 'later',
]);
export const todayItemSchema = z.object({
  id: z.string().min(1), lane: todayLaneIdSchema, personId: personIdSchema, salesCycleId: salesCycleIdSchema,
  personName: z.string().min(1), contextLabel: z.string().nullable(), stage: lifecycleStageSchema,
  priorityContext: leadPriorityContextSchema.nullable(), action: primaryActionSchema, reason: z.string().min(1),
  activeTriggers: z.array(z.object({ label: z.string(), expiresAt: z.string().datetime({ offset: true }).nullable() }).strict()),
  verifyFirst: z.boolean(), pinned: z.boolean(), consentRequirement: z.string().nullable(),
  /** Cloud axes chip (display only, never blended); null until scored. */
  cloudScores: cloudScoreChipSchema.nullable(),
}).strict();
export const todaySnapshotSchema = z.object({
  lanes: z.array(z.object({
    id: todayLaneIdSchema,
    items: z.array(todayItemSchema),
    overflowCount: z.number().int().nonnegative(),
  }).strict()),
  /** Discretionary queue guide, not a claim about completed daily calls. */
  dialBudget: z.number().int().nonnegative(),
  /** Currently queued discretionary calls only. Warm/commitment work is exempt. */
  scheduledDials: z.number().int().nonnegative(),
  conversationTarget: z.number().int().nonnegative(), reviewErrorCount: z.number().int().nonnegative(), revision: z.number().int().nonnegative(),
  unreviewedBacklogCount: z.number().int().nonnegative(),
  /** How many unreviewed leads carry a cloud score (backlog card copy). */
  unreviewedCloudSignalCount: z.number().int().nonnegative(),
  /** Conversations held today (spoke or interview booked), for queue-done. */
  conversationsHeld: z.number().int().nonnegative(),
}).strict();

/**
 * One sequence email the worker's provider accepted for a firm (D13, lane 40). The template id comes from
 * the action id the worker minted for the step and never from the text that went out; `sentOn` is the local
 * date in the founder's own zone, because "Sent T4 on the 23rd" is what he reads, not an instant.
 */
export const sentTemplateEmailSchema = z.object({
  accountId: z.string().min(1),
  templateId: z.enum(REPLY_TEMPLATE_IDS),
  sentOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  actionId: z.string().min(1),
}).strict();

export const dailyAccountCallPlanSchema = z.object({
  accountIds: z.array(z.string().min(1)),
  workloadConflict: z.boolean(),
  /** Template sequence emails that went out to the listed firms. Absent when there are none, so a workspace
   *  that has never had one keeps the exact snapshot revision it had. */
  sentTemplateEmails: z.array(sentTemplateEmailSchema).max(2000).optional(),
}).strict();

export const dailyAccountCallPlanningInputSchema = z.object({
  due: z.array(z.string().min(1)),
  ranked: z.array(z.string().min(1)),
  newCallSlots: z.number().int().nonnegative(),
  completedAccountIds: z.array(z.string().min(1)),
  totalCallCapacity: z.number().int().nonnegative().nullable(),
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

/**
 * Snooze writes the founder-chosen `resurface_at` on the sales cycle. The
 * cycle leaves Today until that instant and re-enters with the reason
 * 'Snoozed until today'.
 */
export const snoozeActionRequestSchema = z.object({
  salesCycleId: salesCycleIdSchema,
  resurfaceAt: z.string().datetime({ offset: true }),
}).strict();

export const logPastActivityRequestSchema = z.object({
  outboundCommandId: z.string().uuid().optional(),
  personId: personIdSchema,
  salesCycleId: salesCycleIdSchema.nullable(),
  kind: z.enum(['call', 'voicemail', 'text', 'email', 'note']),
  direction: z.enum(['inbound', 'outbound', 'internal']),
  occurredAt: z.string().datetime({ offset: true }),
  summary: z.string().min(1).max(2000),
  outcome: z.string().max(200).nullable(),
}).strict();

/**
 * Founder note: THE one place prose is allowed. Stored locally in
 * activities.note_text, never uploaded anywhere.
 */
export const addLeadNoteRequestSchema = z.object({
  personId: personIdSchema,
  salesCycleId: salesCycleIdSchema.nullable(),
  text: z.string().min(1).max(10_000),
}).strict();

export const callOutcomeSchema = z.enum([
  'no_answer', 'voicemail', 'spoke', 'interview_booked', 'not_interested', 'opted_out',
]);

/**
 * Structured call outcome. A callback promise sets the cycle's
 * `resurface_at` ('Callback you promised for today' on re-entry);
 * `opted_out` routes through the existing person-wide opt-out closure.
 */
export const logCallOutcomeRequestSchema = z.object({
  outboundCommandId: z.string().uuid().optional(),
  personId: personIdSchema,
  salesCycleId: salesCycleIdSchema,
  outcome: callOutcomeSchema,
  callbackAt: z.string().datetime({ offset: true }).nullable(),
  occurredAt: z.string().datetime({ offset: true }),
}).strict();

/** Amendment event (audit 2.7): append-only strike-through, never deletion. */
export const markActivityInErrorRequestSchema = z.object({
  personId: personIdSchema,
  activityId: z.string().min(1),
  reason: z.string().min(1).max(500),
}).strict();

export type TodayLaneId = z.infer<typeof todayLaneIdSchema>;
export type TodayItem = z.infer<typeof todayItemSchema>;
export type TodaySnapshot = z.infer<typeof todaySnapshotSchema>;
export type DailyAccountCallPlan = z.infer<typeof dailyAccountCallPlanSchema>;
export type SentTemplateEmail = z.infer<typeof sentTemplateEmailSchema>;
export type DailyAccountCallPlanningInput = z.infer<typeof dailyAccountCallPlanningInputSchema>;
export type CompleteActionRequest = z.infer<typeof completeActionRequestSchema>;
export type SnoozeActionRequest = z.infer<typeof snoozeActionRequestSchema>;
export type LogPastActivityRequest = z.infer<typeof logPastActivityRequestSchema>;
export type AddLeadNoteRequest = z.infer<typeof addLeadNoteRequestSchema>;
export type CallOutcome = z.infer<typeof callOutcomeSchema>;
export type LogCallOutcomeRequest = z.infer<typeof logCallOutcomeRequestSchema>;
export type MarkActivityInErrorRequest = z.infer<typeof markActivityInErrorRequestSchema>;
