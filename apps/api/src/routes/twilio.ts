import { withTransaction, type SessionQueryable } from '@fss/domain/db/queryable.ts';
import {
  consumeCallSession,
  recordCallRecording,
  recordCallStatus,
  workspaceOfCallSession,
} from '@fss/domain/calls/sessions.ts';
import { workspacesWithIntegration } from '@fss/domain/settings/integrations.ts';
import { REFUSAL_STATUS, redactError } from '../limits.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * The Twilio Voice webhooks (call-to-booking slice W, migration 0028).
 *
 *   * `POST /integrations/twilio/voice` — the TwiML application's voice URL. The Voice
 *     SDK connects with the session id as its one parameter; this answers `<Dial>` with
 *     the server-resolved number and the actor's verified caller id, or refuses.
 *   * `POST /integrations/twilio/status` — the `<Number>` status callback and the
 *     `<Dial action>`: the session's progress and its end, which settles the money.
 *   * `POST /integrations/twilio/recording` — the recording status callback.
 *
 * The order of the checks is the order in which a request can do damage:
 *
 *   1. no workspace has `calling_provider = twilio` → 404, exactly as with the defaults;
 *   2. the `twilio-voice` secret or the public origin is not configured → 503, logged;
 *   3. the Twilio signature over the pinned external URL and the sorted form parameters
 *      does not verify, or the account is not ours → 401, and nothing is read;
 *   4. only then is the session looked up.
 *
 * **A refused voice request answers `<Say>` and `<Hangup/>`**, never `<Reject/>`: the
 * caller is David's own Mac, and a sentence tells him the call was not placed and why in
 * general terms, without naming the firm, the number or the reason code. Replays, a
 * second use, an expired session, a mismatched identity and a suppression that landed
 * after authorization all answer this. The TwiML is 200 because Twilio executes only
 * a 200.
 */

export const TWILIO_PATHS: readonly string[] = [
  '/integrations/twilio/voice',
  '/integrations/twilio/status',
  '/integrations/twilio/recording',
];

const TWIML = 'text/xml; charset=utf-8';

function xmlAttribute(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/"/gu, '&quot;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}

/** The one refusal a caller hears. */
export const TWIML_REFUSAL =
  '<?xml version="1.0" encoding="UTF-8"?><Response><Say>This call was not authorized, and it has not been placed.</Say><Hangup/></Response>';

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response/>';

export function dialTwiml(input: {
  readonly origin: string;
  readonly callerIdE164: string;
  readonly e164: string;
  readonly maxSeconds: number;
}): string {
  const origin = input.origin.replace(/\/+$/u, '');
  const status = xmlAttribute(`${origin}/integrations/twilio/status`);
  const recording = xmlAttribute(`${origin}/integrations/twilio/recording`);
  return (
    '<?xml version="1.0" encoding="UTF-8"?><Response>' +
    `<Dial callerId="${xmlAttribute(input.callerIdE164)}" record="record-from-answer-dual" timeLimit="${String(Math.trunc(input.maxSeconds))}"` +
    ` action="${status}" recordingStatusCallback="${recording}" recordingStatusCallbackEvent="completed"` +
    // Slice C1: the Mac's call stays "ringing" until the prospect answers, so the call
    // view's connected state and timer start at the answer, not when TwiML runs.
    ' answerOnBridge="true">' +
    `<Number statusCallback="${status}" statusCallbackEvent="initiated ringing answered completed">${xmlAttribute(input.e164)}</Number>` +
    '</Dial></Response>'
  );
}

const numberOf = (value: string | undefined): number | undefined => {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

export async function routeTwilio(request: ApiRequest, options: RoutingOptions): Promise<RouteResult | null> {
  if (!TWILIO_PATHS.includes(request.path)) return null;
  const notFound = { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
  if (request.method !== 'POST') {
    return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
  }
  const session: SessionQueryable = options.session;

  // 1. The switch. Off everywhere is the default, and the default is 404.
  const enabled = await workspacesWithIntegration(session, { key: 'calling_provider', value: 'twilio' });
  if (enabled.length === 0) return notFound;

  // 2. The configuration.
  const twilio = options.integrations?.twilio ?? null;
  const origin = options.integrations?.publicOrigin ?? null;
  const integration = request.integration;
  if (twilio === null || origin === null || integration === undefined || integration.externalUrl === null) {
    options.log?.log('error', 'integration_unconfigured', {
      integration: 'twilio',
      secret_configured: twilio !== null,
      origin_configured: origin !== null,
    });
    return { status: 503, body: { error: 'integration_unconfigured', message: 'Calling is not configured.' } };
  }

  // 3. The signature, over what Twilio signed.
  const params = integration.form ?? {};
  if (
    !twilio.verifySignature(integration.externalUrl, params, request.headers['x-twilio-signature']) ||
    params['AccountSid'] !== twilio.accountSid
  ) {
    options.log?.log('info', 'refusal', { reason: 'twilio_signature_invalid', path: request.path });
    return { status: REFUSAL_STATUS.unauthenticated, body: { error: 'signature_invalid', message: 'The request was refused.' } };
  }

  if (request.path === '/integrations/twilio/voice') {
    const refuse = (code: string): RouteResult => {
      options.log?.log('info', 'refusal', { reason: 'twilio_voice_refused', code, path: request.path });
      return { status: 200, body: TWIML_REFUSAL, contentType: TWIML };
    };
    if (params['ApplicationSid'] !== undefined && params['ApplicationSid'] !== twilio.twimlAppSid) return refuse('application_mismatch');
    const sessionId = params['sessionId'] ?? '';
    const callSid = params['CallSid'] ?? '';
    const identity = params['From'] ?? params['Caller'] ?? '';
    const workspaceId = await workspaceOfCallSession(session, sessionId);
    if (workspaceId === null) return refuse('session_unknown');
    if (!enabled.includes(workspaceId)) return notFound;
    const at = options.integrations?.decisionAt?.();
    const consumed = await withTransaction(session, async () =>
      await consumeCallSession(session, { workspaceId, sessionId, callSid, identity, ...(at === undefined ? {} : { at }) }),
    );
    if (!consumed.ok) return refuse(consumed.reason);
    return {
      status: 200,
      body: dialTwiml({
        origin,
        callerIdE164: consumed.value.callerIdE164,
        e164: consumed.value.e164,
        maxSeconds: consumed.value.maxSeconds,
      }),
      contentType: TWIML,
    };
  }

  if (request.path === '/integrations/twilio/status') {
    // Two shapes arrive here. The `<Number>` status callback describes the dialled
    // (child) leg: `CallSid` is the child and `ParentCallSid` the session's own. The
    // `<Dial action>` describes the dial as a whole: `CallSid` is the session's leg and
    // `DialCallStatus`/`DialCallDuration`/`DialCallSid` the outcome.
    const dialAction = params['DialCallStatus'] !== undefined;
    const parent = params['ParentCallSid'];
    const callSid = dialAction ? (params['CallSid'] ?? '') : (parent ?? params['CallSid'] ?? '');
    const dialCallSid = dialAction ? params['DialCallSid'] : parent === undefined ? undefined : params['CallSid'];
    const providerStatus = (dialAction ? params['DialCallStatus'] : params['CallStatus']) ?? '';
    const durationSeconds = numberOf(dialAction ? params['DialCallDuration'] : params['CallDuration']);
    const priceDollars = numberOf(params['Price']);
    const outcome = await withTransaction(session, async () =>
      await recordCallStatus(session, {
        callSid,
        ...(dialCallSid === undefined || !/^CA[0-9a-f]{32}$/u.test(dialCallSid) ? {} : { dialCallSid }),
        providerStatus,
        ...(durationSeconds === undefined ? {} : { durationSeconds }),
        ...(priceDollars === undefined ? {} : { priceDollars }),
      }),
    );
    if (!outcome.known) options.log?.log('info', 'twilio_callback_unknown_sid', { path: request.path });
    return { status: 200, body: EMPTY_TWIML, contentType: TWIML };
  }

  // The recording callback. `recordingStatusCallbackEvent="completed"` asks Twilio for the
  // final one only; a `RecordingStatus` other than `completed` (`absent`, `failed`) is a
  // recording with no audio, and is never transcribed.
  const recordingDuration = numberOf(params['RecordingDuration']);
  const recordingStatus = params['RecordingStatus'];
  // Slice C2: the transcription is queued in the same transaction, when the workspace turned
  // it on, a worker with the key is up, the call was answered and the recording lasts at least
  // twenty seconds (`calls/transcription.ts`). Since S3T the domain callback does it (and the
  // status callback too, for an answer that arrives after the recording), together with the
  // pending-review hold (`admitToAnalysisPath`).
  const outcome = await withTransaction(session, async () =>
    await recordCallRecording(session, {
      callSid: params['CallSid'] ?? '',
      recordingSid: params['RecordingSid'] ?? '',
      recordingUrl: params['RecordingUrl'] ?? '',
      ...(recordingDuration === undefined ? {} : { durationSeconds: recordingDuration }),
      final: recordingStatus === undefined || recordingStatus === 'completed',
    }),
  );
  const queued = outcome.transcription;
  if (queued !== undefined && !queued.enqueued && queued.reason !== 'transcription_off') {
    options.log?.log('info', 'call_transcription_not_queued', { reason: queued.reason });
  }
  if (!outcome.known) options.log?.log('info', 'twilio_callback_unknown_sid', { path: request.path });
  return { status: 200, body: EMPTY_TWIML, contentType: TWIML };
}
