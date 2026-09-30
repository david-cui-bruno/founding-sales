import { z } from 'zod';
import { commandIdSchema } from './auth.ts';
import { semanticVersionSchema } from './clientVersion.ts';
import { instant, uuid } from './foundationRows.ts';

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
 *   * `caller_id_mismatch` — the calling identity is not the caller id the Twilio
 *     configuration names, so Twilio would refuse or misrepresent the call.
 */
export const CALL_SESSION_REFUSAL_CODES = [
  'call_attempts_exhausted',
  'call_attempt_today',
  'call_attempt_too_soon',
  'telephony_budget_disabled',
  'telephony_budget_exhausted',
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
