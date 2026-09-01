import { z } from 'zod';

import { personIdSchema, salesCycleIdSchema } from './commonContract';

export const conversationKindSchema = z.enum(['call', 'voicemail']);
export const conversationDirectionSchema = z.enum(['inbound', 'outbound']);
export const conversationsFilterSchema = z.enum([
  'all', 'with_recording', 'with_transcript', 'without_transcript',
]);
export const transcriptSpeakerSchema = z.enum(['founder', 'lead', 'unknown']);

export const conversationRowSchema = z.object({
  activityId: z.string().min(1),
  personId: personIdSchema,
  salesCycleId: salesCycleIdSchema.nullable(),
  personName: z.string().min(1),
  kind: conversationKindSchema,
  direction: conversationDirectionSchema,
  occurredAt: z.string().datetime({ offset: true }),
  durationSeconds: z.number().int().nonnegative().nullable(),
  recordingAvailable: z.boolean(),
  transcriptAvailable: z.boolean(),
  summary: z.string().nullable(),
}).strict();

export const conversationsListRequestSchema = z.object({
  query: z.string().max(200),
  filter: conversationsFilterSchema,
  limit: z.number().int().min(1).max(200),
  cursor: z.string().nullable(),
}).strict();

export const conversationsListResponseSchema = z.object({
  rows: z.array(conversationRowSchema),
  total: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
  revision: z.number().int().nonnegative(),
}).strict();

export const transcriptUtteranceSchema = z.object({
  id: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  speaker: transcriptSpeakerSchema,
  text: z.string().min(1),
}).strict();

export const conversationTranscriptSchema = z.object({
  transcriptId: z.string().min(1),
  source: z.literal('manual_paste'),
  createdAt: z.string().datetime({ offset: true }),
  utterances: z.array(transcriptUtteranceSchema).min(1),
}).strict();

export const conversationDetailSchema = conversationRowSchema.extend({
  transcript: conversationTranscriptSchema.nullable(),
}).strict();

export const conversationDetailRequestSchema = z.object({
  activityId: z.string().min(1),
}).strict();

export const attachTranscriptRequestSchema = z.object({
  activityId: z.string().min(1),
  personId: personIdSchema,
  rawText: z.string().min(1).max(200_000),
}).strict();

export type ConversationKind = z.infer<typeof conversationKindSchema>;
export type ConversationDirection = z.infer<typeof conversationDirectionSchema>;
export type ConversationsFilter = z.infer<typeof conversationsFilterSchema>;
export type TranscriptSpeaker = z.infer<typeof transcriptSpeakerSchema>;
export type ConversationRow = z.infer<typeof conversationRowSchema>;
export type ConversationsListRequest = z.infer<typeof conversationsListRequestSchema>;
export type ConversationsListResponse = z.infer<typeof conversationsListResponseSchema>;
export type TranscriptUtterance = z.infer<typeof transcriptUtteranceSchema>;
export type ConversationTranscript = z.infer<typeof conversationTranscriptSchema>;
export type ConversationDetail = z.infer<typeof conversationDetailSchema>;
export type ConversationDetailRequest = z.infer<typeof conversationDetailRequestSchema>;
export type AttachTranscriptRequest = z.infer<typeof attachTranscriptRequestSchema>;
