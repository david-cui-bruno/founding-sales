import { z } from 'zod';

import { personIdSchema } from './commonContract';

export const reviewItemSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unmatched_communication'), reviewId: z.string(), channel: z.enum(['call', 'text', 'email']), handle: z.string(), occurredAt: z.string().datetime({ offset: true }), summary: z.string() }).strict(),
  z.object({ kind: z.literal('ambiguous_identity'), reviewId: z.string(), candidatePersonIds: z.array(personIdSchema).min(2), summary: z.string() }).strict(),
  z.object({ kind: z.literal('transcript_suggestion'), reviewId: z.string(), personId: personIdSchema, suggestionType: z.enum(['pain', 'objection', 'authority', 'commitment', 'close_readiness', 'offered', 'identity']), evidence: z.array(z.string()).min(1), proposedValue: z.string() }).strict(),
  z.object({ kind: z.literal('import_problem'), reviewId: z.string(), rowNumber: z.number().int().positive(), summary: z.string() }).strict(),
  z.object({ kind: z.literal('adapter_failure'), reviewId: z.string(), adapter: z.string(), summary: z.string(), blocking: z.boolean() }).strict(),
  z.object({ kind: z.literal('system_error'), reviewId: z.string(), invariant: z.string(), summary: z.string(), personId: personIdSchema.nullable() }).strict(),
]);

export const reviewKindSchema = z.enum([
  'unmatched_communication', 'ambiguous_identity', 'transcript_suggestion',
  'import_problem', 'adapter_failure', 'system_error',
]);

export const reviewListRequestSchema = z.object({
  kinds: z.array(reviewKindSchema),
  limit: z.number().int().min(1).max(200),
}).strict();

export const reviewSnapshotSchema = z.object({
  items: z.array(reviewItemSchema),
  totalOpenCount: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
}).strict();

/** Only the valid resolution actions for each review kind. */
export const resolveReviewRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('unmatched_communication'), reviewId: z.string().min(1),
    expectedVersion: z.number().int().positive(),
    action: z.enum(['promote', 'link', 'mark_personal']),
    personId: personIdSchema.nullable(),
    sourceEventId: z.string().min(1).nullable(),
  }).strict(),
  z.object({
    kind: z.literal('ambiguous_identity'), reviewId: z.string().min(1),
    expectedVersion: z.number().int().positive(),
    action: z.literal('choose_identity'),
    personId: personIdSchema,
  }).strict(),
  z.object({
    kind: z.literal('transcript_suggestion'), reviewId: z.string().min(1),
    expectedVersion: z.number().int().positive(),
    action: z.enum(['accept', 'edit', 'dismiss']),
    editedValue: z.string().nullable(),
  }).strict(),
  z.object({
    kind: z.literal('import_problem'), reviewId: z.string().min(1),
    expectedVersion: z.number().int().positive(),
    action: z.enum(['retry', 'dismiss']),
  }).strict(),
  z.object({
    kind: z.literal('adapter_failure'), reviewId: z.string().min(1),
    expectedVersion: z.number().int().positive(),
    action: z.literal('retry'),
  }).strict(),
  z.object({
    kind: z.literal('system_error'), reviewId: z.string().min(1),
    expectedVersion: z.number().int().positive(),
    action: z.literal('repair_invariant'),
    repairCommand: z.string().min(1),
  }).strict(),
]);

export type ReviewItem = z.infer<typeof reviewItemSchema>;
export type ReviewKind = z.infer<typeof reviewKindSchema>;
export type ReviewListRequest = z.infer<typeof reviewListRequestSchema>;
export type ReviewSnapshot = z.infer<typeof reviewSnapshotSchema>;
export type ResolveReviewRequest = z.infer<typeof resolveReviewRequestSchema>;
