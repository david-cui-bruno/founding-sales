import {nativeProcessingReference} from '@fss/domain/crm/sourceResolver.ts';
import {createHash} from 'node:crypto';
import {callTranscriptUtteranceSchema} from '@fss/contracts';
import {
  CALL_HISTORY_INCLUDE_NOTES,
  CALL_HISTORY_INCLUDE_OUTCOME,
  CALL_HISTORY_INCLUDE_SUMMARY,
  callHistoryResponseSchema,
  callRecordingResponseSchema,
  callTranscriptResponseSchema,
  callingStatusResponseSchema,
  createCallSessionCommandSchema,
  resumeCallCadenceCommandSchema,
  uuid,
  voiceAccessTokenResponseSchema,
} from '@fss/contracts';
import {
  createCallSession,
  listFirmCallSessions,
  readCallLogNotes,
  readCallLogOutcomes,
  readCallingStatus,
  recordingPathOfSession,
  resumeCallCadence,
} from '@fss/domain/calls/sessions.ts';
import { readCallingProvider } from '@fss/domain/settings/integrations.ts';
import { readCallTranscript } from '@fss/domain/calls/transcription.ts';
import { readCallSummaries } from '@fss/domain/calls/summary.ts';
import { readAnalysisSummaries } from '@fss/domain/calls/analysisPaid.ts';
import { REFUSAL_STATUS, redactError } from '../limits.ts';
import { policyRouteDeps, runPolicyCommand } from './dialSupport.ts';
import { contextForPrincipal } from './routeSupport.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * The Mac's two call-session routes (call-to-booking slice W).
 *
 *   * `POST /calls/session` — a command with a receipt. Firm, route at its displayed
 *     version, calling identity; the server resolves the number, runs the whole
 *     authorization and the budget, and answers `{ sessionId, expiresAt }` — never the
 *     number (`calls/sessions.ts`).
 *   * `POST /calls/access-token` — the Twilio Voice access token for this user: identity
 *     = the user id, outgoing application only, no incoming grant, one hour.
 *
 * Slice C1 adds four, all with the same switch:
 *
 *   * `GET /calls/calling?firmId=` — the firm's calling cadence ("Attempt N of 4",
 *     parked) and the voicemail script's template and values;
 *   * `POST /calls/cadence/resume` — the review of a parked firm, which starts the count again;
 *   * `GET /calls/history?firmId=` — the firm's placed calls, with duration and whether
 *     there is a recording;
 *   * `GET /calls/recording?sessionId=` — the recording's audio, read from Twilio here
 *     with the account's API key and returned as bytes. Never a Twilio URL. Another
 *     firm's or workspace's session is 404, exactly like an unknown one.
 *
 * Slice C3b: `GET /calls/history?firmId=&include=summary` adds each call's summary and
 * suggested next steps (`summary`, absent when the call has none). Opt-in, so a Mac built
 * before C3b, which never asks, gets the answer its strict parser expects. Slice 3a: a call's
 * current analysis (David's notes, else the latest completed model version) is mapped to the
 * same shape and wins; a call with none falls back to its stored summary.
 *
 * Slice C2 adds one more read with the same switch:
 *
 *   * `GET /calls/transcript?callSessionId=` — the call's transcript (utterances by
 *     speaker, with their times), to the firm's assigned salesperson or an admin. A call
 *     with none, another firm's or another workspace's is 404, exactly like an unknown one.
 *
 * All are 404 unless the caller's workspace has `calling_provider = twilio`, so with the
 * defaults the Mac keeps its `tel:` handoff and nothing here is reachable; 503 when the
 * switch is on and the Twilio configuration is not.
 */

export const CALL_SESSION_PATHS: readonly string[] = [
  '/calls/session',
  '/calls/access-token',
  '/calls/calling',
  '/calls/cadence/resume',
  '/calls/history',
  '/calls/recording',
  '/calls/transcript',
];

/** The reads among them; every other path is a POST. */
const GET_PATHS: ReadonlySet<string> = new Set(['/calls/calling', '/calls/history', '/calls/recording', '/calls/transcript']);

export async function routeCallSessions(request: ApiRequest, options: RoutingOptions): Promise<RouteResult | null> {
  if (!CALL_SESSION_PATHS.includes(request.path)) return null;
  const prepared = await policyRouteDeps(request, options);
  if (!prepared.ok) return prepared.result;
  const deps = prepared.deps;
  if (request.method !== (GET_PATHS.has(request.path) ? 'GET' : 'POST')) {
    return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
  }
  const scoped = contextForPrincipal(deps.auth, deps.principal);
  if (!scoped.ok) return scoped.result;
  if ((await readCallingProvider(scoped.context)) !== 'twilio') {
    return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
  }
  const twilio = options.integrations?.twilio ?? null;
  if (twilio === null) {
    options.log?.log('error', 'integration_unconfigured', { integration: 'twilio', secret_configured: false });
    return { status: 503, body: { error: 'integration_unconfigured', message: 'Calling is not configured.' } };
  }

  const notFound: RouteResult = { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
  const idOf = (name: string): string | null => {
    const parsed = uuid.safeParse(request.query.get(name) ?? '');
    return parsed.success ? parsed.data : null;
  };

  if (request.path === '/calls/calling') {
    const firmId = idOf('firmId');
    if (firmId === null) return { status: REFUSAL_STATUS.malformed_body, body: redactError('malformed_body') };
    const status = await readCallingStatus(scoped.context, firmId);
    // Not `not_found`: that answer means "calling is off" to the Mac, which then hands the
    // number to the phone app. A firm that is not the caller's is a refusal of its own.
    if (status === null) {
      return { status: REFUSAL_STATUS.not_found, body: { error: 'firm_unknown', message: 'No such firm.' } };
    }
    return { status: 200, body: callingStatusResponseSchema.parse({ provider: 'twilio', ...status }) };
  }

  if (request.path === '/calls/history') {
    const firmId = idOf('firmId');
    if (firmId === null) return { status: REFUSAL_STATUS.malformed_body, body: redactError('malformed_body') };
    const calls = await listFirmCallSessions(scoped.context, firmId);
    if (calls === null) return notFound;
    // Each addition only when asked for (repeated or comma-separated), so an older Mac's
    // parser never meets a key it does not know.
    const includes = new Set(
      request.query
        .getAll('include')
        .flatMap(value => value.split(','))
        .map(value => value.trim()),
    );
    // The firm was already decided readable by `listFirmCallSessions`; these are its calls.
    const sessionIds = calls.map(call => call.sessionId);
    const withSummary = includes.has(CALL_HISTORY_INCLUDE_SUMMARY);
    const analyses = withSummary ? await readAnalysisSummaries(scoped.context, sessionIds) : null;
    const summaries = withSummary ? await readCallSummaries(scoped.context, sessionIds) : null;
    const outcomes = includes.has(CALL_HISTORY_INCLUDE_OUTCOME)
      ? await readCallLogOutcomes(
          scoped.context,
          calls.flatMap(call => (call.callLogId === null ? [] : [call.callLogId])),
        )
      : null;
    const notes = includes.has(CALL_HISTORY_INCLUDE_NOTES)
      ? await readCallLogNotes(
          scoped.context,
          calls.flatMap(call => (call.callLogId === null ? [] : [call.callLogId])),
        )
      : null;
    return {
      status: 200,
      body: callHistoryResponseSchema.parse({
        calls: calls.map(call => {
          const summary = analyses?.get(call.sessionId) ?? summaries?.get(call.sessionId);
          return {
            ...call,
            ...(summary === undefined ? {} : { summary }),
            ...(outcomes === null ? {} : { outcome: call.callLogId === null ? null : (outcomes.get(call.callLogId) ?? null) }),
            ...(notes === null ? {} : { note: call.callLogId === null ? null : (notes.get(call.callLogId) ?? null) }),
          };
        }),
      }),
    };
  }

  if (request.path === '/calls/recording') {
    const sessionId = idOf('sessionId');
    if (sessionId === null) return { status: REFUSAL_STATUS.malformed_body, body: redactError('malformed_body') };
    const path = await recordingPathOfSession(scoped.context, sessionId);
    if (path === null) return notFound;
    const fetched = await twilio.fetchRecording(path);
    if (!fetched.ok) {
      options.log?.log('info', 'twilio_recording_unavailable', { reason: fetched.reason });
      if (fetched.reason === 'not_found') return notFound;
      return {
        status: 503,
        body: { error: 'recording_unavailable', message: 'The recording could not be read just now.' },
      };
    }
    return {
      status: 200,
      body: callRecordingResponseSchema.parse({
        sessionId,
        contentType: fetched.contentType,
        audioBase64: fetched.bytes.toString('base64'),
      }),
    };
  }

  if (request.path === '/calls/transcript') {
    const callSessionId = idOf('callSessionId');
    if (callSessionId === null) return { status: REFUSAL_STATUS.malformed_body, body: redactError('malformed_body') };
    const transcript = await readCallTranscript(scoped.context, callSessionId);
    if (transcript === null) return notFound;
    if(request.query.getAll('include').includes('processing')){
      const reference=await nativeProcessingReference(scoped.context,'call_transcript',callSessionId);
      const parsed=callTranscriptUtteranceSchema.array().safeParse(transcript.utterances);
      if(reference===null||!parsed.success||reference.contentHash!==createHash('sha256').update(JSON.stringify(parsed.data)).digest('hex'))return notFound;
      transcript.processingSource=reference;
    }
    return { status: 200, body: callTranscriptResponseSchema.parse(transcript) };
  }

  if (request.path === '/calls/cadence/resume') {
    return await runPolicyCommand(deps, resumeCallCadenceCommandSchema, 'resume_call_cadence', async (context, body) =>
      await resumeCallCadence(context, { firmId: body.firmId }),
    );
  }

  if (request.path === '/calls/access-token') {
    const minted = twilio.mintAccessToken(deps.principal.userId, Math.floor(Date.now() / 1000));
    return {
      status: 200,
      body: voiceAccessTokenResponseSchema.parse({
        token: minted.token,
        identity: deps.principal.userId,
        expiresAt: new Date(minted.expiresAtSeconds * 1000).toISOString(),
      }),
    };
  }

  const at = options.integrations?.decisionAt?.();
  return await runPolicyCommand(deps, createCallSessionCommandSchema, 'create_call_session', async (context, body) =>
    await createCallSession(context, {
      firmId: body.firmId,
      ...(body.contactId === undefined ? {} : { contactId: body.contactId }),
      routeId: body.routeId,
      routeVersion: body.routeVersion,
      callingIdentityId: body.callingIdentityId,
      deviceId: deps.principal.deviceId,
      commandId: body.commandId,
      configuredCallerIdE164: twilio.callerIdE164,
      ...(at === undefined ? {} : { at }),
    }),
  );
}
