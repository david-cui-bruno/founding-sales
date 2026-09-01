import { z } from 'zod';

import {
  leadPriorityContextSchema,
  lifecycleStageSchema,
  personIdSchema,
  primaryActionSchema,
  prioritySchema,
  salesCycleIdSchema,
} from './commonContract';

export const leadSourceSchema = z.enum([
  'frbo', 'registry', 'rireig', 'referral', 'inbound_demo', 'community', 'custom',
  'parcel', 'deed', 'permit', 'violation',
]);
export const leadSegmentSchema = z.enum(['hot', 'cold', 'warm']);

/**
 * Cloud-computed axes chip (Task 5). Two separate 0-100 integers, NEVER
 * combined into one number; null until the scorer has emitted for this
 * prospect.
 */
export const cloudScoreChipSchema = z.object({
  fit: z.number().int().min(0).max(100),
  timing: z.number().int().min(0).max(100),
}).strict();

export const leadRowSchema = z.object({
  personId: personIdSchema, salesCycleId: salesCycleIdSchema, personName: z.string().min(1), initials: z.string().min(1).max(4),
  organization: z.string().nullable(), propertySummary: z.string().nullable(), stage: lifecycleStageSchema,
  source: leadSourceSchema,
  segment: leadSegmentSchema, priorityContext: leadPriorityContextSchema.nullable(),
  cloudScores: cloudScoreChipSchema.nullable(),
  nextAction: primaryActionSchema.nullable(), optedOut: z.boolean(), lastActivityAt: z.string().datetime({ offset: true }).nullable(),
}).strict();

export const leadsListRequestSchema = z.object({
  query: z.string().max(200), stages: z.array(lifecycleStageSchema), priorities: z.array(prioritySchema),
  sort: z.enum(['priority', 'due_at', 'person_name', 'last_contact']), cursor: z.string().nullable(),
  limit: z.number().int().min(1).max(200),
}).strict();

export const leadsListResponseSchema = z.object({
  rows: z.array(leadRowSchema), nextCursor: z.string().nullable(), total: z.number().int().nonnegative(), revision: z.number().int().nonnegative(),
}).strict();

export const leadFieldUpdateRequestSchema = z.discriminatedUnion('field', [
  z.object({ personId: personIdSchema, field: z.literal('person_name'), value: z.string().min(1).max(200) }).strict(),
  z.object({ personId: personIdSchema, field: z.literal('organization_label'), value: z.string().max(200).nullable() }).strict(),
]);

/**
 * Bulk update deliberately mirrors the single-field union instead of a
 * general patch object: the same two allowed fields applied to many people.
 */
export const leadBulkUpdateRequestSchema = z.discriminatedUnion('field', [
  z.object({
    personIds: z.array(personIdSchema).min(1).max(200),
    field: z.literal('person_name'),
    value: z.string().min(1).max(200),
  }).strict(),
  z.object({
    personIds: z.array(personIdSchema).min(1).max(200),
    field: z.literal('organization_label'),
    value: z.string().max(200).nullable(),
  }).strict(),
]);

export type LeadSource = z.infer<typeof leadSourceSchema>;
export type LeadSegment = z.infer<typeof leadSegmentSchema>;
export type CloudScoreChip = z.infer<typeof cloudScoreChipSchema>;
export type LeadRow = z.infer<typeof leadRowSchema>;
export type LeadsListRequest = z.infer<typeof leadsListRequestSchema>;
export type LeadsListResponse = z.infer<typeof leadsListResponseSchema>;
export type LeadFieldUpdateRequest = z.infer<typeof leadFieldUpdateRequestSchema>;
export type LeadBulkUpdateRequest = z.infer<typeof leadBulkUpdateRequestSchema>;
