import { withTransaction } from '@fss/domain/db/queryable.ts';
import {
  RELEASE_DRAIN_DEFAULT_MINUTES,
  RELEASE_DRAIN_MAX_MINUTES,
  readReleaseDrain,
  setReleaseDrain,
} from '@fss/domain/release/drain.ts';
import type { AdminInvocation, AdminOutcome } from './admin.ts';

/**
 * `fss admin release idle-check`, `release drain on` and `release drain off` (slice A4).
 *
 * A schema release stops the API and the worker. `infra/scripts/stop.sh` asks this
 * command first, in production, and refuses to stop anything while it answers `idle:
 * false`. The check reads; the drain is the one write, and it is what closes the gap
 * between the read and the stop (`packages/domain/release/drain.ts`).
 *
 * The functions are in their own file so the two shared files (`admin.ts`,
 * `commands.ts`) carry registration only.
 */

const accept = (value: Readonly<Record<string, unknown>>): AdminOutcome => ({ ok: true, value });
const refuse = (reason: string, detail: string): AdminOutcome => ({ ok: false, reason, detail });

/** How recent an accepted API command must be to count as someone working. */
export const RECENT_COMMAND_WINDOW_SECONDS = 300;

/** A call session older than this and still "in progress" is a leftover row, not a call. */
export const CALL_IN_PROGRESS_WINDOW_HOURS = 4;

/** The `call_sessions.status` that means a call is live. Migration 0027 adds the table. */
export const CALL_SESSION_IN_PROGRESS_STATUS = 'in_progress';

/**
 * The job kinds whose handler is chunked (`JobHandler.chunked`): a running one commits
 * its cursor between chunks and requeues itself near its lease deadline, so a stop
 * loses at most the chunk in flight. A test holds this list to the handlers' own
 * declarations (`apps/worker/test/fssReleaseIdle.test.ts`).
 *
 * Declared by the handler in code and not recorded on the job row, which is why the
 * SQL below has to be given the list.
 */
export const CHUNKED_JOB_KINDS: readonly string[] = Object.freeze(['research.firm', 'call.transcribe', 'call.summarize', 'call.analyze']);

const iso = (value: unknown): string | null => {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
};

/**
 * `fss admin release idle-check [--report <path>]`. One READ ONLY transaction, rolled
 * back. `idle` means all three hold: no call in progress, no accepted API command in the
 * last five minutes, and no running job that cannot be interrupted safely.
 */
export async function releaseIdleCheckCommand(invocation: AdminInvocation): Promise<AdminOutcome> {
  const { session } = invocation;
  await session.query('BEGIN TRANSACTION READ ONLY');
  try {
    const reasons: string[] = [];

    // (a) Telephony. The table does not exist before migration 0027; to_regclass answers
    // null for a missing relation instead of failing, so this works on both sides of it.
    const installed = await session.query<{ present: boolean }>(`SELECT to_regclass('public.call_sessions') IS NOT NULL AS present`);
    let telephony: Record<string, unknown>;
    if (installed.rows[0]?.present !== true) {
      telephony = { state: 'not_installed', inProgress: 0 };
    } else {
      const calls = await session.query<{ count: string; newest: Date | string | null }>(
        `SELECT count(*)::text AS count, max(started_at) AS newest
           FROM call_sessions
          WHERE status = $1 AND started_at > now() - make_interval(hours => $2::int)`,
        [CALL_SESSION_IN_PROGRESS_STATUS, CALL_IN_PROGRESS_WINDOW_HOURS],
      );
      const inProgress = Number(calls.rows[0]?.count ?? '0');
      telephony = { state: 'installed', inProgress, newestStartedAt: iso(calls.rows[0]?.newest) };
      if (inProgress > 0) {
        reasons.push(`${String(inProgress)} call${inProgress === 1 ? ' is' : 's are'} in progress; wait for ${inProgress === 1 ? 'it' : 'them'} to end`);
      }
    }

    // (b) Accepted API commands: `command_receipts` is the 5.3 envelope/idempotency table,
    // one row per command the API accepted or refused, written in the command's own
    // transaction. Any row in the window means someone used the product a moment ago.
    const commands = await session.query<{ count: string; newest: Date | string | null }>(
      `SELECT count(*)::text AS count, max(created_at) AS newest
         FROM command_receipts
        WHERE created_at > now() - make_interval(secs => $1::int)`,
      [RECENT_COMMAND_WINDOW_SECONDS],
    );
    const recentCommands = Number(commands.rows[0]?.count ?? '0');
    if (recentCommands > 0) {
      reasons.push(
        `${String(recentCommands)} API command${recentCommands === 1 ? ' was' : 's were'} accepted in the last ${String(RECENT_COMMAND_WINDOW_SECONDS / 60)} minutes; someone is working`,
      );
    }

    // (c) A running job, not chunked, whose lease has not expired. Queued and retryable
    // jobs never count (they resume whenever the worker returns); an expired lease is a
    // job nothing is running; a chunked job requeues at its next chunk boundary.
    const jobs = await session.query<{ kind: string; count: string; newest_expiry: Date | string | null }>(
      `SELECT kind, count(*)::text AS count, max(lease_expires_at) AS newest_expiry
         FROM jobs
        WHERE state = 'running' AND lease_expires_at > now() AND NOT (kind = ANY($1::text[]))
        GROUP BY kind
        ORDER BY kind`,
      [CHUNKED_JOB_KINDS],
    );
    const byKind = jobs.rows.map(row => ({ kind: row.kind, count: Number(row.count), newestLeaseExpiresAt: iso(row.newest_expiry) }));
    const uninterruptible = byKind.reduce((total, entry) => total + entry.count, 0);
    if (uninterruptible > 0) {
      reasons.push(
        `${String(uninterruptible)} running job${uninterruptible === 1 ? '' : 's'} cannot be interrupted safely (${byKind.map(entry => `${entry.kind} x${String(entry.count)}`).join(', ')}); wait for ${uninterruptible === 1 ? 'it' : 'them'} to finish`,
      );
    }

    const drain = await readReleaseDrain(session);
    const clock = await session.query<{ now: Date | string }>('SELECT now() AS now');
    return accept({
      idle: reasons.length === 0,
      reasons,
      observedAt: iso(clock.rows[0]?.now),
      details: {
        telephony,
        recentCommands: { windowSeconds: RECENT_COMMAND_WINDOW_SECONDS, count: recentCommands, newestAt: iso(commands.rows[0]?.newest) },
        uninterruptibleJobs: { count: uninterruptible, byKind },
        chunkedKindsIgnored: [...CHUNKED_JOB_KINDS],
        releaseDrain: drain,
      },
    });
  } finally {
    await session.query('ROLLBACK');
  }
}

function launchDetail(invocation: AdminInvocation): Record<string, unknown> {
  return {
    launchedBy: invocation.launch?.launchedBy ?? null,
    taskArn: invocation.launch?.taskArn ?? null,
    via: 'fss admin release drain',
  };
}

/** `fss admin release drain on [--minutes N]`: default 20, capped at 60. Audited. */
export async function releaseDrainOnCommand(invocation: AdminInvocation): Promise<AdminOutcome> {
  const raw = invocation.options['--minutes'];
  let minutes: number | undefined;
  if (raw !== undefined) {
    if (!/^[0-9]{1,6}$/u.test(raw)) {
      return refuse('minutes_invalid', `--minutes takes a whole number of minutes from 1 to ${String(RELEASE_DRAIN_MAX_MINUTES)}`);
    }
    minutes = Number(raw);
  }
  const result = await withTransaction(invocation.session, async () =>
    await setReleaseDrain(invocation.session, { on: true, minutes, detail: launchDetail(invocation) }),
  );
  if (!result.ok) return refuse(result.reason, result.detail);
  return accept({
    drain: 'on',
    minutes: result.minutes,
    capped: result.capped,
    defaultMinutes: RELEASE_DRAIN_DEFAULT_MINUTES,
    until: result.state.until,
    active: result.state.active,
  });
}

/** `fss admin release drain off`. Audited; turning it off when it is off is not an error. */
export async function releaseDrainOffCommand(invocation: AdminInvocation): Promise<AdminOutcome> {
  const result = await withTransaction(invocation.session, async () =>
    await setReleaseDrain(invocation.session, { on: false, detail: launchDetail(invocation) }),
  );
  if (!result.ok) return refuse(result.reason, result.detail);
  return accept({ drain: 'off', active: result.state.active });
}
