import {
  MEETING_RECORDING_LIMITS,
  instant,
  recordingCandidatesResponseSchema,
  recordingRegisterCommandSchema,
  recordingUploadUrlCommandSchema,
  recordingUploadUrlSchema,
  recordingsRegisteredSchema,
} from '@fss/contracts';
import {
  authorizeRecording,
  listRecordingCandidates,
  meetingRecordingKey,
  recordedDigests,
  registerMeetingRecordings,
  type RecordingVerdict,
} from '@fss/domain/meetings/recordings.ts';
import {
  MEETING_AUDIO_TOTAL_TIMEOUT_MS,
  MeetingAudioUnavailableError,
  sha256Base64,
  type MeetingAudioStore,
} from '../integrations/meetingAudio.ts';
import { REFUSAL_STATUS, redactError } from '../limits.ts';
import { contextForPrincipal, requirePrincipal, runRouteCommand } from './routeSupport.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * A demo's local Zoom recording, uploaded from the Mac (lane M4, migration 0040).
 *
 *   * `GET /meetings/recordings/candidates?from=&to=` — the non-cancelled meetings starting in
 *     the window (at most 35 days wide, at most 100), with the names the Mac corroborates a
 *     folder with. Any active member, as the firm page's meetings are.
 *   * `POST /meetings/recordings/upload-url { meetingId, fileSha256, sizeBytes, participantLabel,
 *     segment }` — an administrator or the meeting's firm assignee. `registered` when the
 *     meeting already has the digest; otherwise a presigned PUT to
 *     `meetings/<meeting>/<sha256>.m4a`, 15 minutes, binding `audio/mp4`, the size (≤ 300 MB)
 *     and the digest. The receipt keeps the key and never the URL: every answer, a replay's
 *     included, is signed afresh, so a URL is never stored anywhere.
 *   * `POST /meetings/recordings/register { meetingId, files }` — the same people. Each file
 *     not already recorded is checked by HEAD (present, the size, the digest) before any row is
 *     written; one row per (meeting, sha256), so a duplicate or a restart records nothing twice.
 *     S3 not answering is a 503 `storage_unavailable` with no receipt (the transaction rolls
 *     back), so the same command id may be sent again; a definite answer (missing, wrong size,
 *     wrong digest) is a refusal the receipt keeps.
 *
 * Without the bucket (`meetingAudio` absent) the two commands are 404, as an integration that
 * is not configured is; the candidates read needs no bucket.
 */

export const MEETING_RECORDING_PATHS: readonly string[] = [
  '/meetings/recordings/candidates',
  '/meetings/recordings/upload-url',
  '/meetings/recordings/register',
];

const DAY_MS = 24 * 60 * 60 * 1000;

const STORAGE_UNAVAILABLE: RouteResult = {
  status: 503,
  body: { error: 'storage_unavailable', message: 'The recording store did not answer. Try again in a minute.' },
};

export async function routeMeetingRecordings(request: ApiRequest, options: RoutingOptions): Promise<RouteResult | null> {
  if (!MEETING_RECORDING_PATHS.includes(request.path)) return null;
  const auth = options.auth;
  if (auth === undefined) return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
  const expected = request.path === '/meetings/recordings/candidates' ? 'GET' : 'POST';
  if (request.method !== expected) return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
  const store = options.meetingAudio;
  if (expected === 'POST' && store === undefined) return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
  const authenticated = await requirePrincipal(auth, request);
  if (!authenticated.ok) return authenticated.result;
  const deps = { auth, request, principal: authenticated.principal };

  if (request.path === '/meetings/recordings/candidates') {
    const from = instant.safeParse(request.query.get('from') ?? '');
    const to = instant.safeParse(request.query.get('to') ?? '');
    if (!from.success || !to.success) return { status: REFUSAL_STATUS.malformed_body, body: redactError('malformed_body') };
    const span = Date.parse(to.data) - Date.parse(from.data);
    if (span < 0 || span > MEETING_RECORDING_LIMITS.maxCandidateSpanDays * DAY_MS) {
      return { status: REFUSAL_STATUS.malformed_body, body: redactError('malformed_body') };
    }
    const scoped = contextForPrincipal(auth, authenticated.principal);
    if (!scoped.ok) return scoped.result;
    const meetings = await listRecordingCandidates(scoped.context, { from: from.data, to: to.data });
    return { status: 200, body: recordingCandidatesResponseSchema.parse({ meetings }) };
  }

  const audio = store as MeetingAudioStore;
  if (request.path === '/meetings/recordings/upload-url') {
    type Kept = { readonly status: 'registered' } | { readonly status: 'upload'; readonly key: string; readonly sizeBytes: number; readonly sha256: string };
    const answered = await runRouteCommand<typeof recordingUploadUrlCommandSchema, Kept>(deps, recordingUploadUrlCommandSchema, 'meeting_recording_upload_url', async (context, body) => {
      const authorized = await authorizeRecording(context, body.meetingId);
      if (!authorized.ok) return authorized;
      const recorded = await recordedDigests(context, body.meetingId, [body.fileSha256]);
      if (recorded.has(body.fileSha256)) return { ok: true, value: { status: 'registered' } };
      // Kept on the receipt: the key, the size and the digest. Never the URL.
      return {
        ok: true,
        value: { status: 'upload', key: meetingRecordingKey(body.meetingId, body.fileSha256), sizeBytes: body.sizeBytes, sha256: body.fileSha256 },
      };
    });
    return await withFreshUrl(answered, audio);
  }

  // register
  const verifyWithin = AbortSignal.timeout(MEETING_AUDIO_TOTAL_TIMEOUT_MS);
  const verify = async (key: string, file: { readonly sizeBytes: number; readonly sha256: string }): Promise<RecordingVerdict> => {
    const head = await audio.head(key, verifyWithin);
    if (!head.found) return 'recording_missing';
    if (head.sizeBytes !== file.sizeBytes) return 'recording_size_mismatch';
    // The PUT binds the digest, so S3 verified the bytes; an object without a stored checksum
    // could only come from somewhere other than our URL, and is refused.
    if (head.sha256Base64 !== sha256Base64(file.sha256)) return 'recording_checksum_mismatch';
    return 'ok';
  };
  try {
    return await runRouteCommand(deps, recordingRegisterCommandSchema, 'meeting_recording_register', async (context, body) => {
      const registered = await registerMeetingRecordings(context, { meetingId: body.meetingId, files: body.files }, verify);
      return registered.ok ? { ok: true, value: recordingsRegisteredSchema.parse(registered.value) } : registered;
    });
  } catch (error) {
    if (error instanceof MeetingAudioUnavailableError) {
      options.log?.log('warn', 'meeting_recording_head_unavailable', {});
      return STORAGE_UNAVAILABLE;
    }
    throw error;
  }
}

/** An accepted `upload` answer, original or replayed, gets a URL signed now. Nothing else changes. */
async function withFreshUrl(answered: RouteResult, store: MeetingAudioStore): Promise<RouteResult> {
  if (answered.status !== 200) return answered;
  const envelope = answered.body as { status: string; replayed: boolean; result: unknown };
  const result = envelope.result as { status?: unknown; key?: unknown; sizeBytes?: unknown; sha256?: unknown } | null;
  if (result?.status !== 'upload') {
    return { status: 200, body: { ...envelope, result: recordingUploadUrlSchema.parse({ status: 'registered' }) } };
  }
  const key = String(result.key);
  const sizeBytes = Number(result.sizeBytes);
  const sha256 = String(result.sha256);
  const put = await store.presignPut({ key, sizeBytes, sha256Hex: sha256 });
  const answer = recordingUploadUrlSchema.parse({ status: 'upload', key, url: put.url, headers: put.headers, expiresAt: put.expiresAt });
  return { status: 200, body: { ...envelope, result: answer } };
}
