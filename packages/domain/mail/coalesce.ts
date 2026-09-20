import type { Queryable } from '../db/queryable.ts';
import { jobIdempotencyKey } from '../jobs/jobKinds.ts';

/**
 * The coalescing `mail.sync` enqueue (Appendix C: "Mail sync | `mail-sync:{mailbox}`
 * single-flight with merged high-water ID"; 12.3: push "enqueues a coalescing
 * `mail.sync`").
 *
 * The key has no time in it. That is the point — every notification for one mailbox
 * lands on the same row, so a hundred pushes in a minute are one sync — and it is
 * also the problem, because `UNIQUE (workspace_id, kind, idempotency_key)` means the
 * row outlives the run. `enqueueJob`'s `ON CONFLICT DO NOTHING` would therefore
 * enqueue a mailbox's first sync and never its second.
 *
 * So this is an upsert with three rules.
 *
 * **Merge the high-water history id.** A notification that arrives while the job is
 * queued or running raises the payload's `historyId` to the larger of the two, so the
 * run that eventually happens covers everything anybody asked for. It never lowers
 * it: a late notification carrying an older id must not undo a newer one.
 *
 * **Re-arm a finished job.** `done` goes back to `queued` with a fresh attempt
 * budget. That is what makes the single-flight row reusable.
 *
 * **Never re-arm a dead job.** 13.2: an exhausted job is "requeueable only by an
 * audited admin command". A notification is not an admin, so a dead sync stays dead,
 * the notification is still recorded, and the dead-job alarm is what gets somebody's
 * attention. Silently reviving it would make a mailbox that fails every time look
 * healthy for exactly as long as the pushes kept coming.
 *
 * This lives in `packages/domain/mail` rather than in `jobs/jobStore.ts` because the
 * three rules above are mail's contract with Appendix C, not the queue's; the queue
 * offers `enqueueJob` and it is right about the kinds whose keys carry an instant.
 */

export type CoalesceOutcome = 'enqueued' | 'merged' | 'rearmed' | 'dead';

export interface CoalesceResult {
  readonly jobId: string;
  readonly outcome: CoalesceOutcome;
  /** The high-water history id the run will start from, after the merge. */
  readonly historyId: string | null;
}

export interface CoalesceMailSyncInput {
  readonly workspaceId: string;
  readonly mailboxId: string;
  /** The notification's history id, or null when the caller has no hint (reconciliation). */
  readonly historyId?: string | null | undefined;
  readonly maxAttempts?: number | undefined;
}

export async function coalesceMailSync(
  db: Queryable,
  input: CoalesceMailSyncInput,
): Promise<CoalesceResult> {
  const key = jobIdempotencyKey.mailSync(input.mailboxId);
  const historyId = input.historyId ?? null;
  const payload = JSON.stringify({ mailboxId: input.mailboxId, historyId });

  const { rows } = await db.query<{
    id: string;
    state: string;
    history_id: string | null;
    was_present: boolean;
    previous_state: string | null;
  }>(
    `WITH existing AS (
       SELECT id, state FROM jobs
        WHERE workspace_id = $1 AND kind = 'mail.sync' AND idempotency_key = $2
     ),
     upserted AS (
       INSERT INTO jobs (workspace_id, kind, payload, idempotency_key, run_at, not_before, max_attempts)
       VALUES ($1, 'mail.sync', $3::jsonb, $2, now(), now(), coalesce($4::integer, 4))
       ON CONFLICT (workspace_id, kind, idempotency_key) DO UPDATE
          SET payload = jsonb_set(
                jobs.payload,
                '{historyId}',
                CASE
                  WHEN $5::text IS NULL THEN jobs.payload -> 'historyId'
                  WHEN jobs.payload ->> 'historyId' IS NULL THEN to_jsonb($5::text)
                  WHEN (jobs.payload ->> 'historyId')::numeric >= ($5::text)::numeric
                    THEN jobs.payload -> 'historyId'
                  ELSE to_jsonb($5::text)
                END,
                true
              ),
              -- Only a finished job is re-armed. A dead one is left exactly as it is.
              state = CASE WHEN jobs.state = 'done' THEN 'queued' ELSE jobs.state END,
              attempt_count = CASE WHEN jobs.state = 'done' THEN 0 ELSE jobs.attempt_count END,
              run_at = CASE WHEN jobs.state = 'done' THEN now() ELSE jobs.run_at END,
              not_before = CASE WHEN jobs.state = 'done' THEN now() ELSE jobs.not_before END,
              completed_at = CASE WHEN jobs.state = 'done' THEN NULL ELSE jobs.completed_at END,
              error_code = CASE WHEN jobs.state = 'done' THEN NULL ELSE jobs.error_code END,
              error_detail = CASE WHEN jobs.state = 'done' THEN NULL ELSE jobs.error_detail END,
              payload_archived_at = CASE WHEN jobs.state = 'done' THEN NULL ELSE jobs.payload_archived_at END,
              updated_at = now()
       RETURNING id, state, payload ->> 'historyId' AS history_id
     )
     SELECT u.id,
            u.state,
            u.history_id,
            (e.id IS NOT NULL) AS was_present,
            e.state AS previous_state
       FROM upserted AS u
       LEFT JOIN existing AS e ON e.id = u.id`,
    [input.workspaceId, key, payload, input.maxAttempts ?? null, historyId],
  );

  const row = rows[0];
  if (row === undefined) throw new Error('the coalescing enqueue returned no row');

  const outcome: CoalesceOutcome = !row.was_present
    ? 'enqueued'
    : row.previous_state === 'dead'
      ? 'dead'
      : row.previous_state === 'done'
        ? 'rearmed'
        : 'merged';

  return { jobId: row.id, outcome, historyId: row.history_id };
}

/** The history id a claimed `mail.sync` payload names, or null. */
export function payloadHistoryId(payload: Readonly<Record<string, unknown>>): string | null {
  const value = payload['historyId'];
  return typeof value === 'string' && /^[0-9]{1,20}$/.test(value) ? value : null;
}

/** The mailbox a claimed `mail.sync`, `mail.recover` or `mail.watch_renew` payload names. */
export function payloadMailboxId(payload: Readonly<Record<string, unknown>>): string {
  const value = payload['mailboxId'];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('a mail job payload names the mailbox it is about');
  }
  return value;
}
