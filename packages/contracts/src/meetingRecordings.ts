import { z } from 'zod';
import { commandIdSchema } from './auth.ts';
import { semanticVersionSchema } from './clientVersion.ts';
import { instant, uuid } from './foundationRows.ts';

/**
 * A demo's local Zoom recording, imported from the Mac (lane M4, migration 0041).
 *
 * The Mac watches the demo recordings folder, keeps every folder that overlaps no Callie
 * meeting out entirely (never uploaded, never shown, never read past the folder's name),
 * matches the rest to a meeting or asks, and uploads each per-participant AUDIO file to the
 * call-audio bucket through a presigned PUT (E4, E5). Three endpoints:
 *
 *   * `GET /meetings/recordings/candidates?from=&to=` — the meetings a folder may belong to;
 *   * `POST /meetings/recordings/upload-url` — one file's PUT URL, or "already registered";
 *   * `POST /meetings/recordings/register` — the uploaded files, checked by HEAD, recorded.
 *
 * Nothing here carries audio or transcript content. The participant label is the file's name,
 * kept as Zoom wrote it: metadata, as the brief says.
 */

export const MEETING_RECORDING_LIMITS = Object.freeze({
  /** 300 MB per file (the brief). The migration's CHECK holds the same bound. */
  maxFileBytes: 300 * 1024 * 1024,
  /** The files one register command may record. */
  maxFilesPerRegister: 50,
  /** A participant label is a file name; macOS allows 255 bytes, this allows 200 characters. */
  maxLabelCharacters: 200,
  maxSegment: 1000,
  /** The widest candidates read, in days, and the most meetings it answers. */
  maxCandidateSpanDays: 35,
  maxCandidates: 100,
});

export const MEETING_RECORDING_STATES = ['uploaded', 'transcribing', 'transcribed', 'failed'] as const;
export type MeetingRecordingState = (typeof MEETING_RECORDING_STATES)[number];

export const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/u);

/** A file name: 1–200 characters, no control characters. Kept as-is. */
export const participantLabelSchema = z
  .string()
  .min(1)
  .max(MEETING_RECORDING_LIMITS.maxLabelCharacters)
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\u0000-\u001f\u007f]+$/u);

export const recordingSegmentSchema = z.number().int().min(1).max(MEETING_RECORDING_LIMITS.maxSegment);
export const recordingSizeSchema = z.number().int().min(1).max(MEETING_RECORDING_LIMITS.maxFileBytes);

// ---------------------------------------------------------------------------
// The candidates read
// ---------------------------------------------------------------------------

/**
 * A meeting a recording could belong to: its time, and the names the Mac corroborates a
 * folder with (the firm, the attendee's name as the CRM holds it, the address they booked
 * with). Cancelled meetings are not candidates. Not strict: a later field is ignored.
 */
export const recordingCandidateSchema = z.object({
  meetingId: uuid,
  startsAt: instant,
  endsAt: instant,
  firmId: uuid.nullable(),
  firmName: z.string().max(300).nullable(),
  /** The linked contact's name; Cal.com's own attendee name is not stored (0028). */
  attendeeName: z.string().max(300).nullable(),
  attendeeEmail: z.string().max(320).nullable(),
});
export type RecordingCandidate = z.infer<typeof recordingCandidateSchema>;

export const recordingCandidatesResponseSchema = z.strictObject({ meetings: z.array(recordingCandidateSchema) });

// ---------------------------------------------------------------------------
// The upload URL
// ---------------------------------------------------------------------------

export const MEETING_RECORDING_REFUSAL_CODES = [
  'meeting_unknown',
  'meeting_cancelled',
  'firm_unknown',
  'firm_merged',
  'not_assigned',
  'invalid_input',
  'recording_missing',
  'recording_size_mismatch',
  'recording_checksum_mismatch',
] as const;
export type MeetingRecordingRefusalCode = (typeof MEETING_RECORDING_REFUSAL_CODES)[number];

export const recordingUploadUrlCommandSchema = z.strictObject({
  commandId: commandIdSchema,
  clientVersion: semanticVersionSchema,
  meetingId: uuid,
  fileSha256: sha256HexSchema,
  sizeBytes: recordingSizeSchema,
  participantLabel: participantLabelSchema,
  segment: recordingSegmentSchema,
});

/**
 * The answer: a PUT to make, or `registered` when the meeting already has a file with this
 * digest (a duplicate discovery or a restart uploads nothing). The URL is never stored: the
 * receipt keeps the key, and every answer, a replay's too, is signed afresh.
 */
export const recordingUploadUrlSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('upload'),
    key: z.string().max(200),
    url: z.url().max(4000),
    headers: z.strictObject({
      'content-type': z.literal('audio/mp4'),
      'content-length': z.string().regex(/^[1-9][0-9]{0,9}$/u),
      'x-amz-checksum-sha256': z.string().regex(/^[A-Za-z0-9+/]{43}=$/u),
    }),
    expiresAt: instant,
  }),
  z.strictObject({ status: z.literal('registered') }),
]);
export type RecordingUploadUrl = z.infer<typeof recordingUploadUrlSchema>;

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

export const recordingFileSchema = z.strictObject({
  sha256: sha256HexSchema,
  sizeBytes: recordingSizeSchema,
  participantLabel: participantLabelSchema,
  segment: recordingSegmentSchema,
});
export type RecordingFile = z.infer<typeof recordingFileSchema>;

export const recordingRegisterCommandSchema = z.strictObject({
  commandId: commandIdSchema,
  clientVersion: semanticVersionSchema,
  meetingId: uuid,
  files: z.array(recordingFileSchema).min(1).max(MEETING_RECORDING_LIMITS.maxFilesPerRegister),
});

export const registeredRecordingSchema = z.strictObject({
  recordingId: uuid,
  sha256: sha256HexSchema,
  state: z.string().regex(/^[a-z][a-z_]{0,31}$/u),
  /** `new` for a row this command wrote; `existing` for one an earlier command did. */
  outcome: z.enum(['new', 'existing']),
});

export const recordingsRegisteredSchema = z.strictObject({
  meetingId: uuid,
  files: z.array(registeredRecordingSchema),
});
export type RecordingsRegistered = z.infer<typeof recordingsRegisteredSchema>;
