import { z } from 'zod';

import { personIdSchema } from './commonContract';

export const importSourceSchema = z.object({
  kind: z.enum(['csv', 'spreadsheet_paste']), sourceName: z.string().min(1).max(255), content: z.string().min(1).max(10_000_000),
}).strict();
export const importFieldSchema = z.enum([
  'ignore', 'person_name', 'phone', 'email', 'organization', 'property_address', 'doors', 'source', 'segment', 'notes',
]);
export const importMappingSchema = z.record(z.string(), importFieldSchema).refine(
  (mapping) => Object.values(mapping).filter((field) => field === 'person_name').length === 1,
  'Exactly one person-name column is required.',
);
export const importPreviewSchema = z.object({
  previewId: z.string().min(1), contentHash: z.string().regex(/^[a-f0-9]{64}$/), columns: z.array(z.string()),
  sampleRows: z.array(z.object({ rowNumber: z.number().int().positive(), cells: z.array(z.string()) }).strict()),
  suggestedMapping: importMappingSchema, rowCount: z.number().int().nonnegative(), validCount: z.number().int().nonnegative(),
  errors: z.array(z.object({ rowNumber: z.number().int().positive(), field: z.string().nullable(), code: z.string(), message: z.string() }).strict()),
  duplicateCandidates: z.array(z.object({ rowNumber: z.number().int().positive(), personIds: z.array(personIdSchema), reason: z.string() }).strict()),
  expiresAt: z.string().datetime({ offset: true }),
}).strict();
export const importCommitReceiptSchema = z.object({
  jobId: z.string().min(1), importedPersonIds: z.array(personIdSchema), importedRowCount: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
}).strict();
export const importStatusSchema = z.object({
  jobId: z.string().min(1), state: z.enum(['queued', 'running', 'succeeded', 'failed']),
  progressCurrent: z.number().int().nonnegative(), progressTotal: z.number().int().nonnegative().nullable(),
  safeErrorCode: z.string().nullable(),
}).strict();

export const importSourceChannelSchema = z.enum([
  'frbo', 'registry', 'rireig', 'referral', 'inbound_demo', 'community', 'custom',
]);

export const importDuplicateDecisionSchema = z.object({
  rowNumber: z.number().int().positive(),
  decision: z.enum(['merge', 'create', 'skip']),
  personId: personIdSchema.nullable(),
}).strict().refine(
  (value) => (value.decision === 'merge') === (value.personId !== null),
  'Merge decisions require the exact target person; create/skip forbid one.',
);

export const importRemapRequestSchema = z.object({
  previewId: z.string().min(1),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  mapping: importMappingSchema,
}).strict();

/**
 * Commit resends the preview identity plus decisions, never trusted
 * normalized rows from the renderer.
 */
export const importCommitRequestSchema = z.object({
  previewId: z.string().min(1),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  mapping: importMappingSchema,
  source: z.object({
    channel: importSourceChannelSchema,
    referredByPersonId: personIdSchema.nullable(),
  }).strict(),
  duplicateDecisions: z.array(importDuplicateDecisionSchema),
}).strict();

export const importStatusRequestSchema = z.object({
  jobId: z.string().min(1),
}).strict();

export type ImportSource = z.infer<typeof importSourceSchema>;
export type ImportField = z.infer<typeof importFieldSchema>;
export type ImportMapping = z.infer<typeof importMappingSchema>;
export type ImportPreview = z.infer<typeof importPreviewSchema>;
export type ImportDuplicateDecision = z.infer<typeof importDuplicateDecisionSchema>;
export type ImportRemapRequest = z.infer<typeof importRemapRequestSchema>;
export type ImportCommitRequest = z.infer<typeof importCommitRequestSchema>;
export type ImportCommitReceipt = z.infer<typeof importCommitReceiptSchema>;
export type ImportStatusRequest = z.infer<typeof importStatusRequestSchema>;
export type ImportStatus = z.infer<typeof importStatusSchema>;
