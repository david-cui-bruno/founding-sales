import { z } from 'zod';
import { commandIdSchema } from './auth.ts';
import { semanticVersionSchema } from './clientVersion.ts';
import { instant, uuid } from './foundationRows.ts';
import { callSummaryDtoSchema } from './callSummaries.ts';

/**
 * The call-session wire contract (call-to-booking slice W, migration 0028).
 *
 * The Mac asks for a session with `POST /calls/session`, naming the firm and the route
 * the card showed; the server resolves the number, runs `authorizeDial` in full, holds a
 * telephony reservation, and answers `{ sessionId, expiresAt }`. **The dialled number
 * never crosses to the renderer**: the Voice SDK connects with the session id as its only
 * parameter, and the TwiML route puts the server-resolved number into `<Dial>`.
 *
 * `POST /calls/access-token` mints the Twilio Voice access token the SDK connects with:
 * identity = the user id, outgoing application only, no incoming grant, one hour at most.
 *
 * Both routes answer 404 unless the workspace's `calling_provider` is `twilio`.
 */

const commandEnvelope = { commandId: commandIdSchema, clientVersion: semanticVersionSchema };

/** `POST /calls/session`. */
export const createCallSessionCommandSchema = z.strictObject({
  ...commandEnvelope,
  firmId: uuid,
  contactId: uuid.optional(),
  /** The route the card displayed, at the version it displayed. The server resolves the number. */
  routeId: uuid,
  routeVersion: z.number().int().min(1),
  /** The actor's own verified calling identity: the caller id Twilio presents. */
  callingIdentityId: uuid,
});
export type CreateCallSessionCommand = z.infer<typeof createCallSessionCommandSchema>;

/** What an accepted `POST /calls/session` carries as its `result`. No number, ever. */
export const callSessionCreatedSchema = z.strictObject({
  sessionId: uuid,
  expiresAt: instant,
});
export type CallSessionCreated = z.infer<typeof callSessionCreatedSchema>;

/**
 * The refusals a call session adds to the dial refusals `authorizeDial` answers with.
 *
 *   * `call_attempts_exhausted` — the firm already had `CALL_CADENCE.unansweredLimit`
 *     unanswered attempts in the last `CALL_CADENCE.windowDays` days (since the last
 *     conversation, callback request or review). The firm is parked for review: a
 *     firm-scoped `scoped_pause` hold is opened, and "Resume calling" releases it (slice C1).
 *   * `call_attempt_today` — an unanswered attempt was already made on the firm's local
 *     date: at most one a business day.
 *   * `call_attempt_too_soon` — the previous unanswered attempt was at nearly the same
 *     time of day: the next one is at least `CALL_CADENCE.spacingMinutes` from it.
 *   * `telephony_budget_disabled` — the workspace's telephony ceiling is 0 (the default).
 *   * `telephony_budget_exhausted` — this call's reservation would pass today's ceiling.
 *   * `monthly_cash_ceiling` — this call's reservation would pass the workspace's
 *     month-to-date cash ceiling (`monthly_cash_ceiling_cents`, slice P1).
 *   * `caller_id_mismatch` — the calling identity is not the caller id the Twilio
 *     configuration names, so Twilio would refuse or misrepresent the call.
 */
export const CALL_SESSION_REFUSAL_CODES = [
  'call_attempts_exhausted',
  'call_attempt_today',
  'call_attempt_too_soon',
  'telephony_budget_disabled',
  'telephony_budget_exhausted',
  'monthly_cash_ceiling',
  'caller_id_mismatch',
] as const;
export type CallSessionRefusalCode = (typeof CALL_SESSION_REFUSAL_CODES)[number];

/**
 * The calling cadence (slice C1), decided server-side in `createCallSession`.
 *
 * An *unanswered attempt* is a placed session that ended as no answer or busy, or whose
 * recorded outcome is no answer, busy or a voicemail left. At most `unansweredLimit` of
 * them in `windowDays` days, at most one a business day (the firm's local date), each at
 * least `spacingMinutes` of the clock from the previous one's time of day. A conversation
 * or a callback request recorded for the firm starts the count again, and so does
 * resuming a firm the cadence parked.
 */
export const CALL_CADENCE = Object.freeze({
  unansweredLimit: 4,
  windowDays: 14,
  spacingMinutes: 120,
  /** The attempts on which the call view shows the voicemail script. */
  voicemailAttempts: Object.freeze([1, 4]) as readonly number[],
});

/** The cadence as the Mac reads it (`GET /calls/calling`). */
export const callCadenceSchema = z.strictObject({
  /** Unanswered attempts since the count last started, within the window. */
  unansweredAttempts: z.number().int().min(0),
  /** The attempt the next call would be, 1..limit; null when the firm is parked. */
  nextAttempt: z.number().int().min(1).nullable(),
  limit: z.number().int().min(1),
  /** The limit is reached: calling waits for "Resume calling". */
  parked: z.boolean(),
  /** Why a call now would be refused by the cadence, or null. */
  refusal: z.enum(['call_attempts_exhausted', 'call_attempt_today', 'call_attempt_too_soon']).nullable(),
});
export type CallCadence = z.infer<typeof callCadenceSchema>;

/**
 * `GET /calls/calling?firmId=`: what the Mac needs to offer an in-app call for one firm.
 * 404 while `calling_provider` is not `twilio`, like every other call-session route, so a
 * Mac that is not told "twilio" keeps its `tel:` handoff.
 */
export const callingStatusResponseSchema = z.strictObject({
  provider: z.literal('twilio'),
  cadence: callCadenceSchema,
  /** The voicemail template, with its four placeholders (see `renderVoicemailScript`). */
  voicemailTemplate: z.string().min(1).max(2000),
  /** The signed-in person's name, for `{callerName}`. */
  callerName: z.string().max(200),
  /** The person's own verified calling number, for `{callbackNumber}`; null when none. */
  callbackNumber: z.string().max(20).nullable(),
});
export type CallingStatusResponse = z.infer<typeof callingStatusResponseSchema>;

/** `POST /calls/cadence/resume`: the review of a parked firm, which starts the count again. */
export const resumeCallCadenceCommandSchema = z.strictObject({ ...commandEnvelope, firmId: uuid });
export const callCadenceResumedSchema = z.strictObject({ firmId: uuid, releasedHoldId: uuid });

/**
 * `GET /calls/recording?sessionId=`: the recording, proxied from Twilio by the API with
 * the account's own key. Never a Twilio URL. Base64 inside JSON, because every route of
 * this API and every read of the Mac's client is JSON (see docs/greenfield/calling.md).
 */
export const callRecordingResponseSchema = z.strictObject({
  sessionId: uuid,
  contentType: z.enum(['audio/mpeg', 'audio/wav']),
  audioBase64: z.string().min(1),
});
export type CallRecordingResponse = z.infer<typeof callRecordingResponseSchema>;

/** The largest recording the proxy returns (a half-hour dual-channel MP3 is well under). */
export const CALL_RECORDING_MAX_BYTES = 40 * 1024 * 1024;

// ---------------------------------------------------------------------------
// The voicemail script
// ---------------------------------------------------------------------------

/** The default template (David, call-to-booking C1). Editable once its setting key lands. */
export const DEFAULT_VOICEMAIL_SCRIPT =
  "Hi {contactFirstName}, this is {callerName} from Callie. I'm calling about how {firmName} handles maintenance requests after hours. I'll try you again, or you can reach me at {callbackNumber}. Thanks.";

export const VOICEMAIL_PLACEHOLDERS = ['contactFirstName', 'firmName', 'callerName', 'callbackNumber'] as const;

/**
 * The template with its placeholders filled. A missing first name reads "there"; any
 * other missing value leaves the placeholder's words out rather than printing braces.
 */
export function renderVoicemailScript(
  template: string,
  values: {
    readonly contactFirstName: string | null;
    readonly firmName: string;
    readonly callerName: string;
    readonly callbackNumber: string | null;
  },
): string {
  const filled: Readonly<Record<(typeof VOICEMAIL_PLACEHOLDERS)[number], string>> = {
    contactFirstName: values.contactFirstName?.trim() || 'there',
    firmName: values.firmName.trim(),
    callerName: values.callerName.trim(),
    callbackNumber: values.callbackNumber?.trim() ?? '',
  };
  return template.replace(/\{(contactFirstName|firmName|callerName|callbackNumber)\}/gu, (_match, name: string) =>
    filled[name as keyof typeof filled],
  );
}

/** The first word of a contact's name, for `{contactFirstName}`. */
export function firstNameOf(fullName: string | null | undefined): string | null {
  const first = (fullName ?? '').trim().split(/\s+/u)[0] ?? '';
  return first === '' ? null : first;
}


/** A session's life: the dial ticket's sixty seconds. */
export const CALL_SESSION_SECONDS = 60;

export const CALL_SESSION_STATUSES = ['authorized', 'ringing', 'in_progress', 'completed', 'failed', 'canceled'] as const;
export type CallSessionStatus = (typeof CALL_SESSION_STATUSES)[number];

/** One session as a read shows it. No number and no recording URL. */
export const callSessionDtoSchema = z.object({
  sessionId: uuid,
  firmId: uuid,
  status: z.enum(CALL_SESSION_STATUSES),
  startedAt: instant.nullable(),
  answeredAt: instant.nullable(),
  endedAt: instant.nullable(),
  durationSeconds: z.number().int().min(0).nullable(),
  hasRecording: z.boolean(),
  callLogId: uuid.nullable(),
  /**
   * Slice C2: whether the call has a transcript (`GET /calls/transcript`). Optional, so a
   * Mac reading an API from before C2 still parses the history, and absent reads as no.
   */
  hasTranscript: z.boolean().optional(),
  /**
   * Slice C3b: the call's summary and suggested next steps, only when the read asked for
   * them (`include=summary`) and the call has one. An older Mac never asks.
   */
  summary: callSummaryDtoSchema.optional(),
});
export type CallSessionDto = z.infer<typeof callSessionDtoSchema>;

/** `GET /calls/history?firmId=`: the firm's placed calls, newest first. No number, no URL. */
export const callHistoryResponseSchema = z.strictObject({ calls: z.array(callSessionDtoSchema) });
export type CallHistoryResponse = z.infer<typeof callHistoryResponseSchema>;

/** `POST /calls/access-token`. */
export const voiceAccessTokenResponseSchema = z.strictObject({
  token: z.string().min(1),
  /** The Voice identity the token carries: the user id. */
  identity: uuid,
  expiresAt: instant,
});
export type VoiceAccessTokenResponse = z.infer<typeof voiceAccessTokenResponseSchema>;

/** The Voice access token's life, in seconds. Twilio's ceiling is 24 hours; ours is one. */
export const VOICE_ACCESS_TOKEN_SECONDS = 3600;

// ---------------------------------------------------------------------------
// Call transcripts (slice C2, migration 0030)
// ---------------------------------------------------------------------------

/** A call is transcribed only when it was answered and its recording lasts at least this long. */
export const TRANSCRIPTION_MINIMUM_SECONDS = 20;

/**
 * Which channel of a call recording is whose (slice C3a). Every call placed from Callie is
 * recorded by `<Dial record="record-from-answer-dual">` (`apps/api/src/routes/twilio.ts`,
 * `dialTwiml`), and Twilio documents that "the parent call will always be in the first
 * channel and the child call will always be in the second channel of a dual-channel
 * recording" (https://www.twilio.com/docs/voice/twiml/dial, read 1 October 2026). The
 * `<Dial>` is the answer to the Voice SDK client's own call — the Mac's leg, so the parent —
 * and the dialled `<Number>` is the child. So channel 0 is the caller (David, "you") and
 * channel 1 is the prospect ("them"). This is the one place that mapping is written; both
 * transcription adapters read it, and the first real test call verifies it.
 */
export const RECORDING_CHANNEL_ROLES = Object.freeze({ you: 0, them: 1 } as const);

/**
 * The transcripts whose `speaker` is the recording channel (`RECORDING_CHANNEL_ROLES`),
 * as `provider/model`. Every other transcript — C2's Deepgram rows, `deepgram/nova-3` — was
 * diarized: its speaker index says which voice, not whose.
 */
export const CHANNEL_LABELLED_TRANSCRIPTS: readonly string[] = Object.freeze(['aws_transcribe/standard', 'deepgram/nova-3-multichannel']);

export function transcriptIsChannelLabelled(transcript: { readonly provider: string; readonly model: string }): boolean {
  return CHANNEL_LABELLED_TRANSCRIPTS.includes(`${transcript.provider}/${transcript.model}`);
}

/**
 * One stretch of speech: who, when, what. `speaker` is the recording channel
 * (`RECORDING_CHANNEL_ROLES`: 0 you, 1 them) in a channel-labelled transcript, and a
 * diarizer's index (0 = whoever spoke first) in one written before slice C3a.
 */
export const callTranscriptUtteranceSchema = z.strictObject({
  speaker: z.number().int().min(0).max(31),
  /** Seconds from the start of the recording. */
  start: z.number().min(0),
  end: z.number().min(0),
  text: z.string().max(4_000),
});
export type CallTranscriptUtterance = z.infer<typeof callTranscriptUtteranceSchema>;

/** The most utterances one transcript keeps (a four-hour call is far below it). */
export const CALL_TRANSCRIPT_MAX_UTTERANCES = 5_000;

/**
 * `GET /calls/transcript?callSessionId=`: the transcript of one call, to the firm's
 * assigned salesperson or an admin. 404 (`not_found`) when the call has none, or is not
 * the caller's to read.
 */
export const callTranscriptResponseSchema = z.strictObject({
  callSessionId: uuid,
  provider: z.string().min(1).max(32),
  model: z.string().min(1).max(64),
  language: z.string().min(2).max(16),
  durationSeconds: z.number().int().min(0),
  createdAt: instant,
  utterances: z.array(callTranscriptUtteranceSchema).max(CALL_TRANSCRIPT_MAX_UTTERANCES),
});
export type CallTranscriptResponse = z.infer<typeof callTranscriptResponseSchema>;

/**
 * Why a call was not transcribed, or why its transcript could not be read. Each has a
 * sentence in `reasonText.ts` (its own block).
 */
export const TRANSCRIPTION_REFUSAL_CODES = [
  'transcription_off',
  'transcription_unconfigured',
  'transcription_budget_exhausted',
  // This call's reservation would pass the month-to-date cash ceiling (slice P1).
  'monthly_cash_ceiling',
  'transcription_not_eligible',
  'transcription_failed',
  'transcript_unavailable',
] as const;
export type TranscriptionRefusalCode = (typeof TRANSCRIPTION_REFUSAL_CODES)[number];

/**
 * The name each speaker index is shown under.
 *
 * A channel-labelled transcript (slice C3a) names the channels: "You" for channel 0 and
 * "Them" for channel 1, because the channel is the leg, not a guess about a voice.
 *
 * Any other transcript was diarized: "Speaker 1", "Speaker 2", … in the order the
 * diarizer numbers them, which is the order they first speak. Diarization tells voices
 * apart, not who is who — the caller often speaks first on a call placed from Callie, and
 * sometimes the prospect does — so no diarized voice is named "You" or "Them" (review
 * fold 1, P2).
 */
export function transcriptSpeakerLabels(
  utterances: readonly CallTranscriptUtterance[],
  options: { readonly channelLabelled?: boolean } = {},
): ReadonlyMap<number, string> {
  const speakers = [...new Set(utterances.map(utterance => utterance.speaker))].sort((left, right) => left - right);
  if (options.channelLabelled === true) {
    return new Map(
      speakers.map(speaker => [
        speaker,
        speaker === RECORDING_CHANNEL_ROLES.you ? 'You' : speaker === RECORDING_CHANNEL_ROLES.them ? 'Them' : `Channel ${String(speaker + 1)}`,
      ]),
    );
  }
  return new Map(speakers.map(speaker => [speaker, `Speaker ${String(speaker + 1)}`]));
}
