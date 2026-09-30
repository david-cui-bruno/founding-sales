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
 *   * `call_attempt_limit` — the firm already had `CALL_SESSION_DAILY_ATTEMPT_LIMIT`
 *     sessions placed in the last 24 hours.
 *   * `telephony_budget_disabled` — the workspace's telephony ceiling is 0 (the default).
 *   * `telephony_budget_exhausted` — this call's reservation would pass today's ceiling.
 *   * `caller_id_mismatch` — the calling identity is not the caller id the Twilio
 *     configuration names, so Twilio would refuse or misrepresent the call.
 */
export const CALL_SESSION_REFUSAL_CODES = [
  'call_attempt_limit',
  'telephony_budget_disabled',
  'telephony_budget_exhausted',
  'caller_id_mismatch',
] as const;
export type CallSessionRefusalCode = (typeof CALL_SESSION_REFUSAL_CODES)[number];

/** How many sessions one firm may have placed in a rolling 24 hours. */
export const CALL_SESSION_DAILY_ATTEMPT_LIMIT = 3;

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
