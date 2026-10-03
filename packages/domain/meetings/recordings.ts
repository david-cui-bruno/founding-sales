import type { MeetingRecordingRefusalCode, RecordingCandidate, RecordingFile, RecordingsRegistered } from '@fss/contracts';
import { MEETING_RECORDING_LIMITS } from '@fss/contracts';
import type { QueryResultRowLike } from '../db/queryable.ts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
import { decideFirmMutation } from '../crm/authorization.ts';
import { loadFirmForUpdate } from '../crm/firms.ts';

/**
 * A demo's recorded audio, as the server holds it (lane M4, migration 0041).
 *
 * The Mac decides which folder belongs to which meeting (it alone can see the folders); the
 * server answers three questions and records one fact:
 *
 *   * which meetings a folder could belong to (`listRecordingCandidates`) — any active member,
 *     as the firm page's meetings are; cancelled meetings are never candidates;
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
 * Nothing is enqueued. **M5's hook** is marked below: the `meeting.transcribe` job is
 * enqueued for each `new` row, in this same transaction.
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
}

/** The non-cancelled meetings starting in [from, to], soonest first, at most `maxCandidates`. */
export async function listRecordingCandidates(
  context: RepositoryContext,
  window: { readonly from: string; readonly to: string },
): Promise<readonly RecordingCandidate[]> {
  const { rows } = await context.db.query<CandidateRow>(
    `SELECT m.id, m.starts_at, m.ends_at, m.firm_id, f.name AS firm_name, c.full_name AS contact_name, m.attendee_email
       FROM meetings m
       LEFT JOIN firms f ON f.workspace_id = m.workspace_id AND f.id = m.firm_id
       LEFT JOIN contacts c ON c.workspace_id = m.workspace_id AND c.id = m.contact_id
      WHERE m.workspace_id = $1 AND m.state <> 'cancelled'
        AND m.starts_at >= $2::timestamptz AND m.starts_at <= $3::timestamptz
      ORDER BY m.starts_at, m.id
      LIMIT $4`,
    [context.scope.workspaceId, window.from, window.to, MEETING_RECORDING_LIMITS.maxCandidates],
  );
  return rows.map(row => ({
    meetingId: row.id,
    startsAt: row.starts_at.toISOString(),
    endsAt: row.ends_at.toISOString(),
    firmId: row.firm_id,
    firmName: row.firm_name,
    attendeeName: row.contact_name,
    attendeeEmail: row.attendee_email,
  }));
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
    'SELECT firm_id, state FROM meetings WHERE workspace_id = $1 AND id = $2 FOR SHARE',
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

interface RecordingRow extends QueryResultRowLike {
  readonly id: string;
  readonly sha256: string;
  readonly state: string;
}

export async function registerMeetingRecordings(
  context: RepositoryContext,
  input: { readonly meetingId: string; readonly files: readonly RecordingFile[] },
  verify: (key: string, file: RecordingFile) => Promise<RecordingVerdict>,
): Promise<{ readonly ok: true; readonly value: RecordingsRegistered } | Refusal> {
  const authorized = await authorizeRecording(context, input.meetingId);
  if (!authorized.ok) return authorized;
  const workspaceId = context.scope.workspaceId;

  // One entry per digest: the same bytes listed twice are one file.
  const files = [...new Map(input.files.map(file => [file.sha256, file] as const)).values()];
  const already = await recordedDigests(context, input.meetingId, files.map(file => file.sha256));
  const fresh = files.filter(file => !already.has(file.sha256));
  for (const file of fresh) {
    const verdict = await verify(meetingRecordingKey(input.meetingId, file.sha256), file);
    if (verdict !== 'ok') return refuse(verdict);
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
      // M5's hook: enqueue `meeting.transcribe` for this new row here, in this transaction.
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
  await context.db.query(
    `DELETE FROM meeting_recordings r
      WHERE r.workspace_id = $1 AND r.meeting_id = $2
        AND EXISTS (SELECT 1 FROM meeting_recordings s WHERE s.workspace_id = $1 AND s.meeting_id = $3 AND s.sha256 = r.sha256)`,
    [workspaceId, fromMeetingId, toMeetingId],
  );
  // The key stays: the object is where it was uploaded (0041's CHECK allows any meeting's prefix).
  await context.db.query(
    `UPDATE meeting_recordings SET meeting_id = $3 WHERE workspace_id = $1 AND meeting_id = $2`,
    [workspaceId, fromMeetingId, toMeetingId],
  );
}
