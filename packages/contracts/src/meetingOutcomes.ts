import { z } from 'zod';
import { instant, uuid } from './foundationRows.ts';
import { commandIdSchema } from './auth.ts';
import { semanticVersionSchema } from './clientVersion.ts';
const zone = z.string().max(100).refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } }, 'Unknown time zone');
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).refine(value => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, 'Invalid calendar date');
export const meetingDeadlineSchema = z.discriminatedUnion('precision', [
  z.strictObject({ precision: z.literal('date'), localDate, zone }),
  z.strictObject({ precision: z.literal('instant'), at: instant, zone }),
]);
export type MeetingDeadline = z.infer<typeof meetingDeadlineSchema>;
export const meetingEvidenceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('transcript'), recordingId: uuid, transcriptId: uuid, transcriptVersion: z.number().int().positive(),
    utteranceId: z.string().min(1).max(80), quote: z.string().min(1).max(4000), startMs: z.number().int().nonnegative(), endMs: z.number().int().nonnegative() }).refine(v => v.endMs >= v.startMs),
  z.strictObject({ kind: z.literal('debrief'), revision: z.number().int().positive(), quote: z.string().min(1).max(4000),
    startOffset: z.number().int().nonnegative(), endOffset: z.number().int().nonnegative() }).refine(v => v.endOffset > v.startOffset),
]);
export type MeetingEvidence = z.infer<typeof meetingEvidenceSchema>;
export const meetingOwnerSchema = z.enum(['you', 'prospect', 'unknown']);
export const meetingNoteItemSchema = z.strictObject({
  id: z.string().min(1).max(100), kind: z.enum(['need', 'workflow', 'objection', 'material', 'commitment', 'next_step']),
  text: z.string().min(1).max(2000), provenance: z.enum(['stated', 'inferred']), evidence: z.array(meetingEvidenceSchema).min(1).max(20),
  owner: meetingOwnerSchema, deadline: meetingDeadlineSchema.nullable(), deadlineText: z.string().max(500).nullable(),
  reviewReasons: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,79}$/u)).max(20),
});
export type MeetingNoteItem = z.infer<typeof meetingNoteItemSchema>;
export const meetingSpeakerMappingSchema = z.strictObject({ recordingId: uuid, speaker: z.string().max(200).nullable(),
  owner: meetingOwnerSchema, label: z.string().min(1).max(200), zone: zone.nullable() });
export const meetingItemOverrideSchema = z.strictObject({ itemId: z.string().min(1).max(100), decision: z.enum(['confirmed', 'dismissed']),
  text: z.string().min(1).max(2000), owner: meetingOwnerSchema, deadline: meetingDeadlineSchema.nullable() });
export const saveMeetingNotesSchema = z.strictObject({
  meetingId: uuid, expectedRevision: z.number().int().nonnegative(),
  debrief: z.string().max(32768).refine(v => new TextEncoder().encode(v).length <= 32768, 'Debrief exceeds 32 KiB'),
  speakerMappings: z.array(meetingSpeakerMappingSchema).max(200), itemOverrides: z.array(meetingItemOverrideSchema).max(100), sufficient: z.boolean(),
}).refine(v => new Set(v.speakerMappings.map(m => `${m.recordingId}:${m.speaker ?? ''}`)).size === v.speakerMappings.length, 'Duplicate speaker mapping')
  .refine(v => new Set(v.itemOverrides.map(m => m.itemId)).size === v.itemOverrides.length, 'Duplicate item correction');
export type SaveMeetingNotes = z.infer<typeof saveMeetingNotesSchema>;
export const meetingNotesRevisionSchema = z.strictObject({ meetingId: uuid, revision: z.number().int().nonnegative(), debrief: z.string(),
  speakerMappings: z.array(meetingSpeakerMappingSchema).max(200), itemOverrides: z.array(meetingItemOverrideSchema).max(100), sufficient: z.boolean(), savedAt: instant.nullable() });
export type MeetingNotesRevision = z.infer<typeof meetingNotesRevisionSchema>;
export const meetingTaskViewSchema = z.strictObject({ id: uuid, meetingId: uuid, firmId: uuid,
  source: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('promise'), commitmentId: z.string().min(1).max(100) }), z.strictObject({ kind: z.literal('follow_through'), planId: uuid })]),
  label: z.string().min(1).max(2000), ownerUserId: uuid, deadline: meetingDeadlineSchema, status: z.enum(['open', 'done', 'cancelled']),
  version: z.number().int().positive(), userEdited: z.boolean(), evidence: z.array(meetingEvidenceSchema).max(20),
});
export type MeetingTaskView = z.infer<typeof meetingTaskViewSchema>;
export const changeMeetingTaskSchema = z.discriminatedUnion('action', [
  z.strictObject({ taskId: uuid, expectedVersion: z.number().int().positive(), action: z.literal('complete') }),
  z.strictObject({ taskId: uuid, expectedVersion: z.number().int().positive(), action: z.literal('cancel') }),
  z.strictObject({ taskId: uuid, expectedVersion: z.number().int().positive(), action: z.literal('edit'), label: z.string().min(1).max(2000), deadline: meetingDeadlineSchema }),
]);
export type ChangeMeetingTask = z.infer<typeof changeMeetingTaskSchema>;
export const meetingOutcomesViewSchema = z.strictObject({ meetingId: uuid, firmId: uuid, notes: meetingNotesRevisionSchema,
  analysisId: uuid.nullable(), sourceHash: z.string().regex(/^[a-f0-9]{64}$/u), state: z.enum(['empty', 'pending', 'current', 'stale', 'partial']),
  attendance: z.enum(['attended', 'no_show', 'cancelled', 'unconfirmed']), overview: z.string().max(6000),
  items: z.array(meetingNoteItemSchema).max(100), tasks: z.array(meetingTaskViewSchema).max(200), holds: z.array(z.string().max(80)).max(30),
});
export type MeetingOutcomesView = z.infer<typeof meetingOutcomesViewSchema>;
export const MEETING_OUTCOME_REFUSALS = ['invalid_input', 'meeting_unknown', 'meeting_unmatched', 'firm_unknown', 'firm_merged', 'not_assigned',
  'notes_changed', 'source_changed', 'source_invalid', 'analysis_unknown', 'task_unknown', 'task_changed', 'owner_unknown', 'deadline_unclear', 'notes_incomplete'] as const;
export const meetingOutcomeRefusalSchema = z.enum(MEETING_OUTCOME_REFUSALS);
export const saveMeetingNotesCommandSchema = saveMeetingNotesSchema.safeExtend({ commandId: commandIdSchema, clientVersion: semanticVersionSchema });
export const changeMeetingTaskCommandSchema = z.intersection(changeMeetingTaskSchema, z.object({ commandId: commandIdSchema, clientVersion: semanticVersionSchema }));
