import { enqueueJob } from '../jobs/jobStore.ts';
import { jobIdempotencyKey } from '../jobs/jobKinds.ts';
import { mergeRecordingIdentity } from './recordingIdentity.ts';
import type { FirmRecording, MeetingRecordingRefusalCode, RecordingCandidate, RecordingFile, RecordingsRegistered } from '@fss/contracts';
import { MEETING_RECORDING_LIMITS } from '@fss/contracts';
import type { QueryResultRowLike } from '../db/queryable.ts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
import { decideFirmMutation, decideFirmRead } from '../crm/authorization.ts';
import { loadFirmForUpdate, readFirm } from '../crm/firms.ts';

/**
 * A demo's recorded audio, as the server holds it (lane M4, migration 0041).
 *
 * The Mac decides which folder belongs to which meeting (it alone can see the folders); the
 * server answers three questions and records one fact:
 *
 *   * which meetings a folder could belong to (`listRecordingCandidates`) — an administrator
 *     sees the workspace's, anybody else only the meetings on firms assigned to them (review
 *     M4R, finding 3); cancelled meetings are never candidates; every name goes through
 *     `minimiseName`, so an address is only ever answered as its local part;
 *   * may this person attach a file to this meeting (`authorizeRecording`) — an administrator,
 *     or the assignee of the meeting's firm (`decideFirmMutation`); a meeting with no firm yet
 *     is an administrator's. Lock order, as every meeting writer keeps it: the firm row, then
 *     the meeting row (shared: a recording does not change the meeting, but a deletion or a
 *     fold must wait for it);
 *   * is this file already recorded (`recordedDigests`) — the upload URL answers `registered`
 *     and the Mac uploads nothing;
 *   * the files that arrived (`registerMeetingRecordings`): each new file is checked by
 *     `verify` (the route's S3 HEAD: present, the declared size, the declared digest) before
 *     any row is written, so the command is all or nothing; one already recorded is
 *     `existing` and not checked again. Idempotent by (meeting, sha256): a duplicate discovery
 *     or a restart records nothing twice, whatever the command id.
 *
 * M5 enqueues a `meeting.transcribe` job for each new row in this same transaction.
 * The worker rechecks configuration and eligibility before preparing or buying work.
 */

type Refusal = { readonly ok: false; readonly reason: MeetingRecordingRefusalCode };
const refuse = (reason: MeetingRecordingRefusalCode): Refusal => ({ ok: false, reason });

interface CandidateRow extends QueryResultRowLike {
  readonly id: string;
  readonly starts_at: Date;
  readonly ends_at: Date;
  readonly firm_id: string | null;
  readonly firm_name: string | null;
  readonly contact_name: string | null;
  readonly attendee_email: string | null;
  readonly attendee_name: string | null;
  readonly event_title: string | null;
}

/**
 * The one minimiser every name a candidate carries goes through (M4 reset, R5): a value with
 * an `@` is an address — a contact the match created is named by its address until somebody
 * types a name — and is answered as its local part only; anything else is the name, trimmed.
 * Blank is null.
 */
export function minimiseName(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  if (trimmed === '') return null;
  if (!trimmed.includes('@')) return trimmed;
  const local = trimmed.slice(0, trimmed.indexOf('@')).trim();
  return local === '' ? null : local;
}

/**
 * A text that may carry addresses among its words (a booking's title, "Demo with
 * jordan@example.test"): every word through `minimiseName`, so an address is its local part.
 */
export function minimiseText(value: string | null | undefined): string | null {
  const words = (value ?? '')
    .split(/\s+/u)
    .map(word => minimiseName(word))
    .filter((word): word is string => word !== null);
  return words.length === 0 ? null : words.join(' ');
}

/**
 * The non-cancelled meetings starting in [from, to] that this person may attach a recording
 * to, soonest first, at most `maxCandidates`; `truncated` when there were more (review M4R,
 * finding 10). An administrator: every meeting of the workspace. Anybody else: only meetings
 * on a firm assigned to them — an unmatched meeting is an administrator's (finding 3).
 */
export async function listRecordingCandidates(
  context: RepositoryContext,
  window: { readonly from: string; readonly to: string },
): Promise<{ readonly meetings: readonly RecordingCandidate[]; readonly truncated: boolean }> {
  const actor = context.scope.actor;
  if (actor.kind !== 'user') return { meetings: [], truncated: false };
  const admin = actor.role === 'admin';
  const { rows } = await context.db.query<CandidateRow>(
    `SELECT m.id, m.starts_at, m.ends_at, m.firm_id, f.name AS firm_name, c.full_name AS contact_name, m.attendee_email,
            m.attendee_name, m.event_title
       FROM meetings m
       LEFT JOIN firms f ON f.workspace_id = m.workspace_id AND f.id = m.firm_id
       LEFT JOIN contacts c ON c.workspace_id = m.workspace_id AND c.id = m.contact_id
      WHERE m.workspace_id = $1 AND m.state <> 'cancelled'
        AND m.starts_at >= $2::timestamptz AND m.starts_at <= $3::timestamptz
        AND ($5::boolean OR (f.assigned_user_id = $6::uuid AND f.status <> 'merged'))
      ORDER BY m.starts_at, m.id
      LIMIT $4`,
    [context.scope.workspaceId, window.from, window.to, MEETING_RECORDING_LIMITS.maxCandidates + 1, admin, actor.userId],
  );
  const kept = rows.slice(0, MEETING_RECORDING_LIMITS.maxCandidates);
  return {
    truncated: rows.length > kept.length,
    meetings: kept.map(row => ({
      meetingId: row.id,
      startsAt: row.starts_at.toISOString(),
      endsAt: row.ends_at.toISOString(),
      firmId: row.firm_id,
      // Every name through the one minimiser: never a whole address (R5; M4F finding 5).
      firmName: minimiseName(row.firm_name),
      attendeeName: minimiseName(row.contact_name),
      attendeeLocalPart: minimiseName(row.attendee_email),
      // Lane M2's booking details, for corroboration: the same minimiser.
      bookingAttendeeName: minimiseName(row.attendee_name),
      eventTitle: minimiseText(row.event_title),
    })),
  };
}

/** May this person attach recordings to this meeting? Takes the firm's and the meeting's locks. */
export async function authorizeRecording(
  context: RepositoryContext,
  meetingId: string,
): Promise<{ readonly ok: true } | Refusal> {
  const actor = context.scope.actor;
  if (actor.kind !== 'user') return refuse('invalid_input');
  const workspaceId = context.scope.workspaceId;
  const { rows: located } = await context.db.query<{ firm_id: string | null }>(
    'SELECT firm_id FROM meetings WHERE workspace_id = $1 AND id = $2',
    [workspaceId, meetingId],
  );
  const where = located[0];
  if (where === undefined) return refuse('meeting_unknown');
  if (where.firm_id === null) {
    if (actor.role !== 'admin') return refuse('not_assigned');
  } else {
    const firm = await loadFirmForUpdate(context, where.firm_id);
    if (firm === null) return refuse('firm_unknown');
    const decision = decideFirmMutation(context, firm);
    if (!decision.permitted) return refuse(decision.reason === 'firm_merged' ? 'firm_merged' : decision.reason === 'not_assigned' ? 'not_assigned' : 'firm_unknown');
  }
  const { rows: locked } = await context.db.query<{ firm_id: string | null; state: string }>(
    'SELECT firm_id, state FROM meetings WHERE workspace_id = $1 AND id = $2 FOR UPDATE',
    [workspaceId, meetingId],
  );
  const meeting = locked[0];
  if (meeting === undefined) return refuse('meeting_unknown');
  // The firm moved under the lock (a merge or a match): its permission was not the one asked.
  if (meeting.firm_id !== where.firm_id) return refuse('meeting_unknown');
  if (meeting.state === 'cancelled') return refuse('meeting_cancelled');
  return { ok: true };
}

/** The digests among `sha256s` the meeting already has a row for. */
export async function recordedDigests(context: RepositoryContext, meetingId: string, sha256s: readonly string[]): Promise<ReadonlySet<string>> {
  const { rows } = await context.db.query<{ sha256: string }>(
    'SELECT sha256 FROM meeting_recordings WHERE workspace_id = $1 AND meeting_id = $2 AND sha256 = ANY ($3::text[])',
    [context.scope.workspaceId, meetingId, [...sha256s]],
  );
  return new Set(rows.map(row => row.sha256));
}

/** The object key a file is uploaded to. A row keeps it when a fold moves the row (0041). */
export function meetingRecordingKey(meetingId: string, sha256: string): string {
  return `meetings/${meetingId}/${sha256}.m4a`;
}

export type RecordingVerdict = 'ok' | 'recording_missing' | 'recording_size_mismatch' | 'recording_checksum_mismatch';

/** What the HEAD said of one staged object: the verdict, and the upload id its PUT wrote. */
export interface RecordingCheck {
  readonly verdict: RecordingVerdict;
  /** The `x-amz-meta-callie-upload` the presigned PUT wrote, or null: which upload URL wrote it. */
  readonly uploadId: string | null;
}

/**
 * The uploader binding (review M4R; M4 reset R6, repaired after M4RR: by nonce, never by
 * clocks). Every upload URL is issued under a receipt with a fresh random upload id, which the
 * signed PUT must write as the object's metadata. `issued` — was an upload URL for this key ever
 * issued to this person (asked before any HEAD, of a person who is not an administrator);
 * `wrote` — is the object's upload id that of a receipt for this key issued to this person, or,
 * for an administrator (`anyIssuer`), to anybody. Absent: not checked (the domain's own tests).
 */
export interface UploaderBinding {
  issued(key: string): Promise<boolean>;
  wrote(key: string, uploadId: string, anyIssuer: boolean): Promise<boolean>;
}

/**
 * Some staged objects are not there (review M4R, finding 9): thrown, so the command's
 * transaction rolls back and no receipt is kept; the route answers `object_missing` with the
 * digests, and the Mac uploads those files again.
 */
export class RecordingObjectsMissingError extends Error {
  constructor(readonly missing: readonly string[]) {
    super('staged recording objects are missing');
    this.name = 'RecordingObjectsMissingError';
  }
}

interface RecordingRow extends QueryResultRowLike {
  readonly id: string;
  readonly sha256: string;
  readonly state: string;
}

export async function registerMeetingRecordings(
  context: RepositoryContext,
  input: { readonly meetingId: string; readonly files: readonly RecordingFile[] },
  verify: (key: string, file: RecordingFile) => Promise<RecordingCheck>,
  binding?: UploaderBinding,
): Promise<{ readonly ok: true; readonly value: RecordingsRegistered } | Refusal> {
  const authorized = await authorizeRecording(context, input.meetingId);
  if (!authorized.ok) return authorized;
  const workspaceId = context.scope.workspaceId;

  // One entry per digest: the same bytes listed twice are one file.
  const files = [...new Map(input.files.map(file => [file.sha256, file] as const)).values()];
  const already = await recordedDigests(context, input.meetingId, files.map(file => file.sha256));
  const fresh = files.filter(file => !already.has(file.sha256));
  const actor = context.scope.actor;
  const admin = actor.kind !== 'user' || actor.role === 'admin';
  const bound = binding ?? null;
  // Before any HEAD: a person never issued a URL for the key learns nothing about the object.
  if (bound !== null && !admin) {
    for (const file of fresh) {
      if (!(await bound.issued(meetingRecordingKey(input.meetingId, file.sha256)))) return refuse('recording_not_issued');
    }
  }
  const checks = new Map<string, RecordingCheck>();
  for (const file of fresh) checks.set(file.sha256, await verify(meetingRecordingKey(input.meetingId, file.sha256), file));
  const missing = fresh.filter(file => checks.get(file.sha256)?.verdict === 'recording_missing').map(file => file.sha256);
  if (missing.length > 0) throw new RecordingObjectsMissingError(missing);
  for (const check of checks.values()) if (check.verdict !== 'ok') return refuse(check.verdict);
  // R6: the object carries the upload id of the URL that wrote it. It must be one issued to this
  // person (an administrator: to anybody, for this key); an object somebody else wrote is not
  // theirs to claim, whenever it was written.
  if (bound !== null) {
    for (const file of fresh) {
      const uploadId = checks.get(file.sha256)?.uploadId ?? null;
      if (uploadId === null || !(await bound.wrote(meetingRecordingKey(input.meetingId, file.sha256), uploadId, admin))) return refuse('not_your_upload');
    }
  }

  const answered: RecordingsRegistered['files'][number][] = [];
  for (const file of files) {
    const { rows: inserted } = await context.db.query<RecordingRow>(
      `INSERT INTO meeting_recordings (workspace_id, meeting_id, segment, participant_label, sha256, size_bytes, s3_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (workspace_id, meeting_id, sha256) DO NOTHING
       RETURNING id, sha256, state`,
      [workspaceId, input.meetingId, file.segment, file.participantLabel, file.sha256, file.sizeBytes, meetingRecordingKey(input.meetingId, file.sha256)],
    );
    const row = inserted[0];
    if (row !== undefined) {
      await enqueueJob(context.db, { workspaceId, kind: 'meeting.transcribe',
        idempotencyKey: jobIdempotencyKey.meetingTranscribe(row.id, 0), payload: { recordingId: row.id }, maxAttempts: 3 });
      answered.push({ recordingId: row.id, sha256: row.sha256, state: row.state, outcome: 'new' });
      continue;
    }
    const { rows: existing } = await context.db.query<RecordingRow>(
      'SELECT id, sha256, state FROM meeting_recordings WHERE workspace_id = $1 AND meeting_id = $2 AND sha256 = $3',
      [workspaceId, input.meetingId, file.sha256],
    );
    const found = existing[0];
    if (found === undefined) throw new Error('a recording row conflicted and then could not be read');
    answered.push({ recordingId: found.id, sha256: found.sha256, state: found.state, outcome: 'existing' });
  }

  const added = answered.filter(file => file.outcome === 'new').length;
  if (added > 0) {
    await context.db.query('UPDATE meetings SET transcript_source_revision=transcript_source_revision+1 WHERE workspace_id=$1 AND id=$2', [workspaceId,input.meetingId]);
    // Counts only: a file name may carry a participant's name, and the audit is not where it belongs.
    await recordCrmAuditEvent(context, {
      action: 'meeting.recordings_registered',
      subjectKind: 'meeting',
      subjectId: input.meetingId,
      detail: { added, existing: answered.length - added },
    });
  }
  return { ok: true, value: { meetingId: input.meetingId, files: answered } };
}

/**
 * A Cal.com fold removes a meeting row after moving what hangs off it (`foldMeetings`):
 * its recordings move to the survivor too, except a digest the survivor already has, which
 * is the same file and goes with the folded row.
 */
export async function moveRecordingsToSurvivor(context: RepositoryContext, fromMeetingId: string, toMeetingId: string): Promise<void> {
  const workspaceId = context.scope.workspaceId;
  const duplicates = (await context.db.query<{from_id:string;to_id:string}>(
    `SELECT r.id AS from_id,s.id AS to_id FROM meeting_recordings r JOIN meeting_recordings s
      ON s.workspace_id=r.workspace_id AND s.sha256=r.sha256 AND s.meeting_id=$3
      WHERE r.workspace_id=$1 AND r.meeting_id=$2 ORDER BY r.id FOR UPDATE OF r,s`, [workspaceId,fromMeetingId,toMeetingId])).rows;
  for (const duplicate of duplicates) await mergeRecordingIdentity(context,duplicate.from_id,duplicate.to_id);
  await context.db.query('UPDATE meetings SET transcript_source_revision=transcript_source_revision+1 WHERE workspace_id=$1 AND id=ANY($2::uuid[])', [workspaceId,[fromMeetingId,toMeetingId]]);
  // The key stays: the object is where it was uploaded (0041's CHECK allows any meeting's prefix).
  await context.db.query(
    `UPDATE meeting_recordings SET meeting_id = $3 WHERE workspace_id = $1 AND meeting_id = $2`,
    [workspaceId, fromMeetingId, toMeetingId],
  );
}

interface FirmRecordingRow extends QueryResultRowLike {
  readonly id: string;
  readonly meeting_id: string;
  readonly segment: number;
  readonly participant_label: string;
  readonly state: FirmRecording['state'];
  readonly created_at: Date;
}

/**
 * The firm page's recordings (M4 reset, R4): the rows registered for the firm's meetings,
 * newest meeting first, at most `maxFirmRecordings`; `truncated` when there were more. Read
 * from the server's rows, so a fold (which moves the rows to the survivor) and another Mac's
 * upload both show. A participant label is a file name, which can carry a person's name, so
 * this is the firm page read in full — an administrator or the firm's assignee
 * (`decideFirmRead`), the rule `/meetings/brief` keeps. Anybody else, and a firm of another
 * workspace or none, is null: the route answers the same 404 for both.
 */
export async function listFirmRecordings(
  context: RepositoryContext,
  firmId: string,
): Promise<{ readonly recordings: readonly FirmRecording[]; readonly truncated: boolean } | null> {
  const workspaceId = context.scope.workspaceId;
  const firm = await readFirm(context, firmId);
  if (firm === null || decideFirmRead(context, firm) !== 'assigned_or_admin') return null;
  const { rows } = await context.db.query<FirmRecordingRow>(
    `SELECT r.id, r.meeting_id, r.segment, r.participant_label, r.state, r.created_at
       FROM meeting_recordings r
       JOIN meetings m ON m.workspace_id = r.workspace_id AND m.id = r.meeting_id
      WHERE r.workspace_id = $1 AND m.firm_id = $2
      ORDER BY m.starts_at DESC, r.meeting_id, r.participant_label, r.segment, r.id
      LIMIT $3`,
    [workspaceId, firmId, MEETING_RECORDING_LIMITS.maxFirmRecordings + 1],
  );
  const kept = rows.slice(0, MEETING_RECORDING_LIMITS.maxFirmRecordings);
  return {
    truncated: rows.length > kept.length,
    recordings: kept.map(row => ({
      recordingId: row.id,
      meetingId: row.meeting_id,
      segment: row.segment,
      participantLabel: row.participant_label,
      state: row.state,
      createdAt: row.created_at.toISOString(),
    })),
  };
}
