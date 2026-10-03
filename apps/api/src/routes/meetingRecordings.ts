import { randomUUID } from 'node:crypto';
import {
  MEETING_RECORDING_LIMITS,
  firmRecordingsResponseSchema,
  instant,
  uuid,
  recordingCandidatesResponseSchema,
  recordingRegisterCommandSchema,
  recordingUploadUrlCommandSchema,
  recordingUploadUrlSchema,
  recordingsRegisteredSchema,
} from '@fss/contracts';
import {
  authorizeRecording,
  listFirmRecordings,
  listRecordingCandidates,
  meetingRecordingKey,
  recordedDigests,
  registerMeetingRecordings,
  RecordingObjectsMissingError,
  type RecordingCheck,
  type UploaderBinding,
} from '@fss/domain/meetings/recordings.ts';
import { withTransaction } from '@fss/domain/db/queryable.ts';
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
 * A demo's local Zoom recording, uploaded from the Mac (lane M4, migration 0041).
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
 *     back), so the same command id may be sent again. An object that is not there (HEAD 404,
 *     or 403: the role has no ListBucket) is 409 `object_missing` with the digests and no
 *     receipt, so the Mac uploads those files again (review M4R, finding 9). A wrong size or
 *     digest is a refusal the receipt keeps. A person who is not an administrator registers
 *     only objects whose upload URL was issued to them (`recording_not_issued`), and only an
 *     object written through one of their URLs: each URL's signed PUT writes its receipt's
 *     random upload id as the object's metadata, and HEAD reads it back (`not_your_upload`;
 *     M4 reset R6, by nonce). An administrator needs the object written through any URL
 *     issued for its key.
 *   * `GET /meetings/recordings?firmId=` — the registered recordings of the firm's meetings,
 *     from the rows (M4 reset, R4): a fold moves them, so they follow it. An administrator or
 *     the firm's assignee, as `/meetings/brief` (participant labels can carry names); anybody
 *     else, and an unknown firm, the same 404.
 *
 * The candidates read answers only the meetings this person may attach a recording to, the
 * attendee's address as its local part, and `truncated` (review M4R, findings 3 and 10). An
 * upload URL is signed only after the person is authorized again, a replay included (finding 8).
 *
 * Without the bucket (`meetingAudio` absent) the two commands are 404, as an integration that
 * is not configured is; the candidates read needs no bucket.
 */

export const MEETING_RECORDING_PATHS: readonly string[] = [
  '/meetings/recordings',
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
  const reads = request.path === '/meetings/recordings/candidates' || request.path === '/meetings/recordings';
  const expected = reads ? 'GET' : 'POST';
  if (request.method !== expected) return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
  const store = options.meetingAudio;
  if (expected === 'POST' && store === undefined) return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
  const authenticated = await requirePrincipal(auth, request);
  if (!authenticated.ok) return authenticated.result;
  const deps = { auth, request, principal: authenticated.principal };

  if (request.path === '/meetings/recordings') {
    const firmId = uuid.safeParse(request.query.get('firmId') ?? '');
    if (!firmId.success) return { status: REFUSAL_STATUS.malformed_body, body: redactError('malformed_body') };
    const scoped = contextForPrincipal(auth, authenticated.principal);
    if (!scoped.ok) return scoped.result;
    const listed = await withTransaction(auth.db, async () => await listFirmRecordings(scoped.context, firmId.data));
    if (listed === null) return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
    return { status: 200, body: firmRecordingsResponseSchema.parse(listed) };
  }

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
    const listed = await listRecordingCandidates(scoped.context, { from: from.data, to: to.data });
    return { status: 200, body: recordingCandidatesResponseSchema.parse({ meetings: listed.meetings, truncated: listed.truncated }) };
  }

  const audio = store as MeetingAudioStore;
  if (request.path === '/meetings/recordings/upload-url') {
    type Kept =
      | { readonly status: 'registered' }
      | {
          readonly status: 'upload';
          readonly key: string;
          readonly sizeBytes: number;
          readonly sha256: string;
          readonly issuedTo: string;
          readonly uploadId: string;
        };
    const answered = await runRouteCommand<typeof recordingUploadUrlCommandSchema, Kept>(deps, recordingUploadUrlCommandSchema, 'meeting_recording_upload_url', async (context, body) => {
      const authorized = await authorizeRecording(context, body.meetingId);
      if (!authorized.ok) return authorized;
      const recorded = await recordedDigests(context, body.meetingId, [body.fileSha256]);
      if (recorded.has(body.fileSha256)) return { ok: true, value: { status: 'registered' } };
      // Kept on the receipt: the key, the size, the digest, who it was issued to and a fresh
      // random upload id the signed PUT writes as the object's metadata (the register's
      // uploader binding). Never the URL. A replay signs again with the same upload id.
      return {
        ok: true,
        value: {
          status: 'upload',
          key: meetingRecordingKey(body.meetingId, body.fileSha256),
          sizeBytes: body.sizeBytes,
          sha256: body.fileSha256,
          issuedTo: authenticated.principal.userId,
          uploadId: randomUUID(),
        },
      };
    });
    if (answered.status !== 200) return answered;
    // Review M4R, finding 8: a URL is a new bearer credential, so every one — a replay's too —
    // is signed only after the person is authorized again, now: the firm still theirs (or an
    // administrator), the meeting still there and not cancelled.
    const meetingId = (request.body as { meetingId?: unknown }).meetingId;
    const scoped = contextForPrincipal(auth, authenticated.principal);
    if (!scoped.ok) return scoped.result;
    const again = await withTransaction(auth.db, async () => await authorizeRecording(scoped.context, String(meetingId)));
    if (!again.ok) {
      const envelope = answered.body as { replayed?: unknown };
      return { status: 409, body: { status: 'refused', replayed: envelope.replayed === true, reason: again.reason } };
    }
    return await withFreshUrl(answered, audio);
  }

  // register
  const verifyWithin = AbortSignal.timeout(MEETING_AUDIO_TOTAL_TIMEOUT_MS);
  const verify = async (key: string, file: { readonly sizeBytes: number; readonly sha256: string }): Promise<RecordingCheck> => {
    const head = await audio.head(key, verifyWithin);
    if (!head.found) return { verdict: 'recording_missing', uploadId: null };
    if (head.sizeBytes !== file.sizeBytes) return { verdict: 'recording_size_mismatch', uploadId: head.uploadId };
    // The PUT binds the digest, so S3 verified the bytes; an object without a stored checksum
    // could only come from somewhere other than our URL, and is refused.
    if (head.sha256Base64 !== sha256Base64(file.sha256)) return { verdict: 'recording_checksum_mismatch', uploadId: head.uploadId };
    return { verdict: 'ok', uploadId: head.uploadId };
  };
  // The uploader binding (review M4R; M4 reset R6, by nonce after M4RR): the object's upload id
  // (metadata the signed PUT wrote) names the receipt whose URL wrote it. A person who is not an
  // administrator needs that receipt to be one issued to them; an administrator, any receipt
  // for this key. No clock is compared.
  const receiptsFor = `FROM command_receipts
        WHERE workspace_id = $1 AND command_kind = 'meeting_recording_upload_url' AND result_status = 'accepted'
          AND result ->> 'key' = $2`;
  const binding: UploaderBinding = {
    issued: async key => {
      const { rows } = await auth.db.query(`SELECT 1 ${receiptsFor} AND result ->> 'issuedTo' = $3 LIMIT 1`, [
        authenticated.principal.workspaceId,
        key,
        authenticated.principal.userId,
      ]);
      return rows.length > 0;
    },
    wrote: async (key, uploadId, anyIssuer) => {
      const { rows } = await auth.db.query(
        `SELECT 1 ${receiptsFor} AND result ->> 'uploadId' = $3 AND ($4::boolean OR result ->> 'issuedTo' = $5) LIMIT 1`,
        [authenticated.principal.workspaceId, key, uploadId, anyIssuer, authenticated.principal.userId],
      );
      return rows.length > 0;
    },
  };
  try {
    return await runRouteCommand(deps, recordingRegisterCommandSchema, 'meeting_recording_register', async (context, body) => {
      const registered = await registerMeetingRecordings(context, { meetingId: body.meetingId, files: body.files }, verify, binding);
      return registered.ok ? { ok: true, value: recordingsRegisteredSchema.parse(registered.value) } : registered;
    });
  } catch (error) {
    if (error instanceof MeetingAudioUnavailableError) {
      options.log?.log('warn', 'meeting_recording_head_unavailable', {});
      return STORAGE_UNAVAILABLE;
    }
    if (error instanceof RecordingObjectsMissingError) {
      // No receipt (the transaction rolled back): the Mac uploads these again, then registers.
      return { status: 409, body: { status: 'refused', replayed: false, reason: 'object_missing', missing: [...error.missing] } };
    }
    throw error;
  }
}

/** An accepted `upload` answer, original or replayed, gets a URL signed now. Nothing else changes. */
async function withFreshUrl(answered: RouteResult, store: MeetingAudioStore): Promise<RouteResult> {
  if (answered.status !== 200) return answered;
  const envelope = answered.body as { status: string; replayed: boolean; result: unknown };
  const result = envelope.result as { status?: unknown; key?: unknown; sizeBytes?: unknown; sha256?: unknown; uploadId?: unknown } | null;
  if (result?.status !== 'upload') {
    return { status: 200, body: { ...envelope, result: recordingUploadUrlSchema.parse({ status: 'registered' }) } };
  }
  const key = String(result.key);
  const sizeBytes = Number(result.sizeBytes);
  const sha256 = String(result.sha256);
  const put = await store.presignPut({ key, sizeBytes, sha256Hex: sha256, uploadId: String(result.uploadId) });
  const answer = recordingUploadUrlSchema.parse({ status: 'upload', key, url: put.url, headers: put.headers, expiresAt: put.expiresAt });
  return { status: 200, body: { ...envelope, result: answer } };
}
