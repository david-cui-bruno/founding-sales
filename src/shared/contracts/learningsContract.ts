import { z } from 'zod';

import { personIdSchema } from './commonContract';

export const learningIdSchema = z.string().min(1);

export const learningCategorySchema = z.enum([
  'pain', 'objection', 'alternative', 'winning_language',
  'pricing_reaction', 'product_request', 'coaching',
  'invalidated_assumption',
]);

export const learningStatusSchema = z.enum(['active', 'contradicted', 'retired']);

export const learningConfidenceSchema = z.enum(['low', 'medium', 'high']);

export const learningEvidenceSchema = z.object({
  id: z.string().min(1),
  personId: personIdSchema.nullable(),
  personName: z.string().min(1).nullable(),
  activityId: z.string().min(1).nullable(),
  quote: z.string().min(1).max(2000),
  notedAt: z.string().datetime({ offset: true }),
}).strict();

export const learningRowSchema = z.object({
  learningId: learningIdSchema,
  category: learningCategorySchema,
  statement: z.string().min(1).max(500),
  status: learningStatusSchema,
  statusReason: z.string().max(500).nullable(),
  confidence: learningConfidenceSchema,
  sampleSize: z.number().int().min(1),
  firstObservedAt: z.string().datetime({ offset: true }),
  latestObservedAt: z.string().datetime({ offset: true }),
  evidence: z.array(learningEvidenceSchema).min(1),
  contradictionOf: learningIdSchema.nullable(),
  createdAt: z.string().datetime({ offset: true }),
  version: z.number().int().positive(),
}).strict();

export const learningsListRequestSchema = z.object({
  categories: z.array(learningCategorySchema),
  statuses: z.array(learningStatusSchema),
  query: z.string().max(200),
  limit: z.number().int().min(1).max(200),
}).strict();

export const learningsListResponseSchema = z.object({
  rows: z.array(learningRowSchema),
  totalActiveCount: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
}).strict();

/** Founder-entered evidence: derived fields such as personName stay out. */
export const captureEvidenceSchema = z.object({
  personId: personIdSchema.nullable(),
  activityId: z.string().min(1).nullable(),
  quote: z.string().min(1).max(2000),
  notedAt: z.string().datetime({ offset: true }),
}).strict();

export const captureLearningRequestSchema = z.object({
  category: learningCategorySchema,
  statement: z.string().min(1).max(500),
  confidence: learningConfidenceSchema,
  evidence: z.array(captureEvidenceSchema).min(1),
  contradictionOf: learningIdSchema.nullable(),
}).strict();

export const addEvidenceRequestSchema = z.object({
  learningId: learningIdSchema,
  expectedVersion: z.number().int().positive(),
  evidence: captureEvidenceSchema,
}).strict();

/** Marking a learning contradicted always records why; other moves may not. */
export const updateLearningStatusRequestSchema = z.discriminatedUnion('status', [
  z.object({
    learningId: learningIdSchema,
    expectedVersion: z.number().int().positive(),
    status: z.literal('contradicted'),
    reason: z.string().min(1).max(500),
  }).strict(),
  z.object({
    learningId: learningIdSchema,
    expectedVersion: z.number().int().positive(),
    status: z.literal('active'),
    reason: z.string().max(500).nullable(),
  }).strict(),
  z.object({
    learningId: learningIdSchema,
    expectedVersion: z.number().int().positive(),
    status: z.literal('retired'),
    reason: z.string().max(500).nullable(),
  }).strict(),
]);

export type LearningCategory = z.infer<typeof learningCategorySchema>;
export type LearningStatus = z.infer<typeof learningStatusSchema>;
export type LearningConfidence = z.infer<typeof learningConfidenceSchema>;
export type LearningEvidence = z.infer<typeof learningEvidenceSchema>;
export type LearningRow = z.infer<typeof learningRowSchema>;
export type LearningsListRequest = z.infer<typeof learningsListRequestSchema>;
export type LearningsListResponse = z.infer<typeof learningsListResponseSchema>;
export type CaptureEvidence = z.infer<typeof captureEvidenceSchema>;
export type CaptureLearningRequest = z.infer<typeof captureLearningRequestSchema>;
export type AddEvidenceRequest = z.infer<typeof addEvidenceRequestSchema>;
export type UpdateLearningStatusRequest = z.infer<typeof updateLearningStatusRequestSchema>;
