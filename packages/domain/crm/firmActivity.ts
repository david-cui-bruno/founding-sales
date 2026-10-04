import type { FirmTaskDto, FirmTimeline, FirmTimelineEvent } from '@fss/contracts';
import { CALL_OUTCOME_CORRECTED_ACTION } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';

/**
 * The firm page's two read-only lists (S4F): the open work and the activity timeline.
 *
 * Both are called only after `readFirmPage` has decided the caller is the firm's assignee or
 * an admin, the same decision that gates the stage history and the holds: a colleague's page
 * is the narrow one and never reaches here. Neither writes anything or adds a table; they
 * read what the call log, callbacks, call tasks, sequences, mail, stage history, stops and
 * the audit log already hold.
 */

export const TIMELINE_PAGE = 50;
/** An e-mail's one line is its direction and its subject, cut here; never a body or a snippet. */
const SUBJECT_MAX = 80;

// ---------------------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------------------

/**
 * Open callbacks, open call tasks and pending or held call and LinkedIn steps, soonest due
 * first. A step that is an e-mail is the sequence's, not a task a person does.
 */
export async function readFirmTasks(context: RepositoryContext, firmId: string, includeMeetingTasks = false): Promise<readonly FirmTaskDto[]> {
  const { rows } = await context.db.query<{ key: string; kind: FirmTaskDto['kind']; label: string; due_at: Date; status: 'open' | 'held'; deadline: FirmTaskDto['deadline'] }>(
    `SELECT * FROM (
       SELECT 'callback:' || id::text AS key, 'callback' AS kind, 'callback' AS label, due_at, 'open' AS status, NULL::jsonb AS deadline
         FROM callbacks
        WHERE workspace_id = $1 AND firm_id = $2 AND status = 'open'
       UNION ALL
       SELECT 'call_task:' || id::text, 'call_task', text, due_at, 'open', NULL::jsonb
         FROM call_tasks
        WHERE workspace_id = $1 AND firm_id = $2 AND status = 'open'
       UNION ALL
       SELECT 'step:' || id::text, 'step', channel, due_at, CASE WHEN state = 'held' THEN 'held' ELSE 'open' END, NULL::jsonb
         FROM step_executions
        WHERE workspace_id = $1 AND firm_id = $2 AND state IN ('pending', 'held')
          AND channel IN ('call_task', 'linkedin_task')
       UNION ALL
       SELECT 'meeting_task:' || id::text, 'meeting_task', left(label,300), due_at, 'open', deadline
         FROM meeting_tasks WHERE workspace_id=$1 AND firm_id=$2 AND status='open' AND $3::boolean
     ) tasks
     ORDER BY due_at, key
     LIMIT 100`,
    [context.scope.workspaceId, firmId, includeMeetingTasks],
  );
  return rows.map(row => ({ ...(row.deadline == null ? {} : { deadline: row.deadline }), key: row.key, kind: row.kind, label: row.label, dueAt: row.due_at.toISOString(), status: row.status }));
}

// ---------------------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------------------

/** The cursor: the last row's instant at microsecond precision, its kind and its id. */
interface Cursor {
  readonly at: string;
  readonly kind: string;
  readonly id: string;
}

const encodeCursor = (cursor: Cursor): string => `${cursor.at}|${cursor.kind}|${cursor.id}`;

function decodeCursor(text: string | undefined): Cursor | null | 'invalid' {
  if (text === undefined) return null;
  const parts = text.split('|');
  const [at, kind, ...rest] = parts;
  if (at === undefined || kind === undefined || rest.length === 0) return 'invalid';
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/u.test(at)) return 'invalid';
  return { at, kind, id: rest.join('|') };
}

interface TimelineRow {
  readonly at: Date;
  readonly at_text: string;
  readonly kind: FirmTimelineEvent['kind'];
  readonly id: string;
  readonly code: string | null;
  readonly detail: string | null;
  readonly [column: string]: unknown;
}

/**
 * One page of the timeline, newest first. The order is (instant, kind, id), all descending,
 * and the cursor is that same triple, so two events sharing an instant are neither skipped
 * nor repeated across a page boundary. `before` is a cursor from an earlier answer; an
 * unreadable one is the first page again rather than a refusal.
 */
export async function readFirmTimeline(context: RepositoryContext, firmId: string, before?: string): Promise<FirmTimeline> {
  const cursor = decodeCursor(before);
  const where = cursor === null || cursor === 'invalid' ? '' : 'WHERE (at, kind, id) < ($3::timestamptz, $4::text, $5::text)';
  const params: unknown[] = [context.scope.workspaceId, firmId];
  if (cursor !== null && cursor !== 'invalid') params.push(cursor.at + 'Z', cursor.kind, cursor.id);
  const { rows } = await context.db.query<TimelineRow>(
    `SELECT at, to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS at_text, kind, id, code, detail
       FROM (
         SELECT c.occurred_at AS at, 'call' AS kind, c.id::text AS id, c.outcome AS code, NULL::text AS detail
           FROM call_logs c
          WHERE c.workspace_id = $1 AND c.firm_id = $2
         UNION ALL
         SELECT a.occurred_at, 'outcome_corrected', a.id::text, a.detail->>'to', a.detail->>'from'
           FROM audit_events a
           JOIN call_logs c ON c.workspace_id = a.workspace_id AND c.id::text = a.subject_id
          WHERE a.workspace_id = $1 AND c.firm_id = $2
            AND a.action = '${CALL_OUTCOME_CORRECTED_ACTION}' AND a.subject_kind = 'call_log'
         UNION ALL
         SELECT m.internal_date,
                CASE m.direction WHEN 'outgoing' THEN 'email_sent' ELSE 'email_received' END,
                m.id::text, NULL::text, left(coalesce(m.subject, ''), ${String(SUBJECT_MAX)})
           FROM mail_messages m
          WHERE m.workspace_id = $1
            AND EXISTS (SELECT 1 FROM mail_message_matches x
                         WHERE x.workspace_id = m.workspace_id AND x.mail_message_id = m.id AND x.firm_id = $2
                           AND x.selected IS NOT FALSE AND (NOT x.ambiguous OR x.selected IS TRUE))
         UNION ALL
         SELECT e.occurred_at, 'stage_change', e.id::text, becomes.key, was.key
           FROM opportunity_stage_events e
           JOIN pipeline_stages becomes ON becomes.workspace_id = e.workspace_id AND becomes.id = e.to_stage_id
           LEFT JOIN pipeline_stages was ON was.workspace_id = e.workspace_id AND was.id = e.from_stage_id
          WHERE e.workspace_id = $1 AND e.firm_id = $2
         UNION ALL
         SELECT s.recorded_at,
                CASE WHEN s.supersedes_event_id IS NULL THEN 'stop_recorded' ELSE 'stop_lifted' END,
                s.event_id, s.channel, s.scope
           FROM suppression_events s
          WHERE s.workspace_id = $1
            AND ((s.scope = 'firm' AND s.canonical_key = lower($2::text))
              OR (s.scope = 'handle' AND s.canonical_key IN (
                    SELECT a.address FROM email_addresses a
                     WHERE a.workspace_id = $1 AND a.firm_id = $2::uuid AND a.contact_id IS NOT NULL
                    UNION
                    SELECT p.e164 FROM phone_routes p
                     WHERE p.workspace_id = $1 AND p.firm_id = $2::uuid AND p.contact_id IS NOT NULL)))
       ) timeline
       ${where}
      ORDER BY at DESC, kind DESC, id DESC
      LIMIT ${String(TIMELINE_PAGE + 1)}`,
    params,
  );
  const page = rows.slice(0, TIMELINE_PAGE);
  const last = page[page.length - 1];
  return {
    events: page.map(row => ({
      key: `${row.kind}:${row.id}`,
      at: row.at.toISOString(),
      kind: row.kind,
      code: row.code,
      detail: row.detail === '' ? null : row.detail,
      cursor: encodeCursor({ at: row.at_text, kind: row.kind, id: row.id }),
    })),
    nextBefore: rows.length > TIMELINE_PAGE && last !== undefined ? encodeCursor({ at: last.at_text, kind: last.kind, id: last.id }) : null,
  };
}
