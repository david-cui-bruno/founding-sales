import { z } from 'zod';
import { instant, uuid } from './foundationRows.ts';
export const MEETING_TRANSCRIPTION_LIMITS = Object.freeze({
    maxDurationMs: 14400000, maxUtterances: 20000, maxTextBytes: 4 * 1024 * 1024,
    maxProviderBytes: 16 * 1024 * 1024, pageSize: 200, maxDailyCents: 500,
});
export const recordingSourceKindSchema = z.enum(['participant', 'mixed', 'unknown']);
export type RecordingSourceKind = z.infer<typeof recordingSourceKindSchema>;
export const meetingProcessingStatusSchema = z.enum(['disabled', 'funding_unverified', 'budget_held', 'queued',
    'preparing', 'transcribing', 'ready', 'needs_reupload', 'failed']);
export type MeetingProcessingStatus = z.infer<typeof meetingProcessingStatusSchema>;
export const meetingTranscriptionSettingSchema = z.strictObject({
    enabled: z.boolean(), dailyCeilingCents: z.number().int().min(0).max(500),
    creditCoverage: z.strictObject({
        accountId: z.string().regex(/^\d{12}$/u), service: z.literal('transcribe'),
        evidenceRef: z.string().trim().min(1).max(300), verifiedAt: instant, validUntil: instant,
        status: z.enum(['verified', 'revoked']),
    }).refine(value => Date.parse(value.validUntil) > Date.parse(value.verifiedAt), 'coverage must expire after verification').nullable(),
});
export type MeetingTranscriptionSetting = z.infer<typeof meetingTranscriptionSettingSchema>;
export const DEFAULT_MEETING_TRANSCRIPTION: MeetingTranscriptionSetting = { enabled: false, dailyCeilingCents: 0, creditCoverage: null };
export const meetingSpeechSchema = z.strictObject({
    startMs: z.number().int().min(0).max(14400000), endMs: z.number().int().min(0).max(14400000),
    text: z.string().min(1).max(4000), speaker: z.string().max(200).nullable(),
    attribution: z.enum(['source_label', 'provider_label', 'unknown']),
}).refine(value => value.endMs >= value.startMs, 'speech ends after it starts');
export type MeetingSpeech = z.infer<typeof meetingSpeechSchema>;
export const meetingUtteranceSchema = meetingSpeechSchema.safeExtend({
    id: z.string().max(80), recordingId: uuid, transcriptId: uuid, transcriptVersion: z.number().int().positive(),
});
export type MeetingUtterance = z.infer<typeof meetingUtteranceSchema>;
export const recordingProcessingViewSchema = z.strictObject({
    recordingId: uuid, meetingId: uuid, participantLabel: z.string().max(200), segment: z.number().int().positive(),
    sourceKind: recordingSourceKindSchema, status: meetingProcessingStatusSchema, reason: z.string().max(80).nullable(),
    transcriptId: uuid.nullable(), transcriptVersion: z.number().int().positive().nullable(),
    durationMs: z.number().int().min(0).max(14400000).nullable(),
});
export type RecordingProcessingView = z.infer<typeof recordingProcessingViewSchema>;
const count = z.number().int().nonnegative();
export const meetingCoverageSchema = z.strictObject({ sourceRevision: count, total: count, ready: count, held: count, pending: count, failed: count, unavailable: count });
export type MeetingCoverage = z.infer<typeof meetingCoverageSchema>;
export const meetingTranscriptPageSchema = z.strictObject({
    meetingId: uuid, coverage: meetingCoverageSchema, recordings: z.array(recordingProcessingViewSchema).max(200),
    recordingsTruncated: z.boolean(), utterances: z.array(meetingUtteranceSchema).max(200),
    nextCursor: z.string().max(500).nullable(), timing: z.literal('file_relative'),
});
export type MeetingTranscriptPage = z.infer<typeof meetingTranscriptPageSchema>;
