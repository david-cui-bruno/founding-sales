import type { Queryable } from '../db/queryable.ts';
import { heartbeatIsFresh } from '../jobs/heartbeats.ts';
import type { MetricDatum } from '../jobs/metrics.ts';
import { COVERAGE_FRESHNESS_SECONDS, coverageIsFresh } from './coverage.ts';
import { hoursToSoonestWatchExpiry } from './watch.ts';

/**
 * The mail metrics the infrastructure alarms on (13.3).
 *
 * `METRIC_OWNERS` in `packages/domain/jobs/metrics.ts` names this lane (`mail`) as the
 * owner of the first and the outbound lane as the owner of the second, which is the
 * collector the worker actually publishes it from (g72). They are collected here rather
 * than in `collectJobMetrics` so that the mail tables stay behind the mail package's
 * export, and the worker's metric loop publishes the two arrays together.
 *
 * **`GmailWatchHoursToExpiry`** is the alarm of "Gmail watch within two days of
 * expiry". It reports the *soonest* expiry across connected mailboxes, because an
 * alarm on an average would stay quiet while one mailbox went dark, and it reports
 * zero — not nothing — for a connected mailbox with no live watch at all, because no
 * watch is the state the alarm most needs to fire on.
 *
 * **`MailboxDisconnectedHours`** is 12.6's "a mailbox that sent in the last 30 days
 * and remains disconnected for 48 hours alarms". It belongs to G7-2, which is the
 * pull request that gives a mailbox a record of having sent: without
 * `outbound_messages` the "sent in the last 30 days" half cannot be asked, and
 * publishing the other half alone would alarm on a mailbox that has never been used.
 * `mailboxDisconnectedHours` below is the query with that clause left as a parameter,
 * so G7-2 supplies it and the metric starts being published in the same commit.
 *
 * **`MailboxCheckHeartbeat`** is "three missed one-minute mailbox checks", and it asks
 * about the mailboxes that are supposed to be checked: the connected ones (lane g81,
 * audit O15). Until then the job lane published it from every mailbox heartbeat row,
 * so a workspace that had never connected a mailbox published nothing — which the
 * alarm treats as breaching — and a mailbox its owner had disconnected left a row that
 * aged into a zero. Either way an environment with no mailbox on purpose sat in
 * critical ALARM, and held the critical composite there. It is published on every pass
 * now: 1 when every connected mailbox's check is on time, including when none is
 * connected, and 0 when any connected mailbox's check is late or has never happened.
 * A revoked grant is not a missed check either — it is 12.6's
 * `MailboxDisconnectedHours`, with its 48 hours.
 *
 * **`MailboxCoverageAgeSeconds`** is how long ago the stalest connected, `ready`
 * mailbox's coverage was last proved (lane g81). Since lane g77 the send path holds
 * every automated email for an owner whose watermark is older than
 * `COVERAGE_FRESHNESS_SECONDS` (`coverage.ts`), and until this gauge nothing outside
 * the Mac showed whether sync was advancing: the heartbeat says a check *ran*, and a
 * rate-limited check runs and proves nothing. The warning `mailbox_coverage_stale`
 * alarms above the same fifteen minutes. See `mailboxCoverageAgeSeconds` for how it
 * agrees with the gate.
 */

export const MAIL_METRIC_NAMES: readonly string[] = Object.freeze([
  'GmailWatchHoursToExpiry',
  'MailboxCheckHeartbeat',
  'MailboxCoverageAgeSeconds',
  'MailboxDisconnectedHours',
]);

/**
 * The coverage age of the stalest connected, `ready` mailbox, in seconds, by the send
 * gate's own rule, or null when no mailbox is connected and `ready`.
 *
 * Same column and same clock as `readMailboxCoverage`: `coverage_watermark_at` against
 * the database's `clock_timestamp()`. Each mailbox is judged by `coverageIsFresh`, so
 * the gauge crosses `COVERAGE_FRESHNESS_SECONDS` exactly when the gate would hold that
 * owner's sends:
 *
 * * a watermark the gate credits reads its age, never below zero (a few seconds of
 *   skew ahead of the database clock is the gate's to allow, and reads 0);
 * * a watermark the gate cannot credit for a reason other than age — none at all on a
 *   `ready` mailbox, or one more than the skew allowance in the future — has no honest
 *   age, and reads one second past the window, so it is above the alarm threshold
 *   without inventing a number of hours.
 *
 * Mailboxes in their baseline or recovering are not here: the gate holds them for their
 * state (`coverage_incomplete`), which is what `mail.recover` is working on, and the
 * mailbox check heartbeat already covers a recovery that has stopped.
 */
export async function mailboxCoverageAgeSeconds(db: Queryable): Promise<number | null> {
  const { rows } = await db.query<{ age_seconds: number | null }>(
    `SELECT extract(epoch FROM (clock_timestamp() - coverage_watermark_at))::float8 AS age_seconds
       FROM mailboxes
      WHERE status = 'connected' AND sync_state = 'ready'`,
  );
  if (rows.length === 0) return null;
  let stalest = 0;
  for (const row of rows) {
    const age = row.age_seconds === null ? null : Number(row.age_seconds);
    const reading = coverageIsFresh(age) ? Math.max(age ?? 0, 0) : Math.max(age ?? 0, COVERAGE_FRESHNESS_SECONDS + 1);
    stalest = Math.max(stalest, reading);
  }
  return stalest;
}

export interface ConnectedMailboxCheck {
  readonly mailboxId: string;
  /** Null when the mailbox has never recorded a check. */
  readonly ageSeconds: number | null;
  readonly fresh: boolean;
}

/**
 * Every connected mailbox and whether its check is on time, by the one definition of
 * fresh (`heartbeatIsFresh`, with the mailbox's grace). Disconnected and revoked
 * mailboxes are not here: nothing is supposed to check them.
 */
export async function connectedMailboxChecks(db: Queryable): Promise<readonly ConnectedMailboxCheck[]> {
  const { rows } = await db.query<{
    mailbox_id: string;
    age_seconds: string | null;
    expected_interval_seconds: number | null;
  }>(
    `SELECT m.id::text AS mailbox_id,
            extract(epoch FROM now() - h.observed_at)::text AS age_seconds,
            h.expected_interval_seconds
       FROM mailboxes AS m
       LEFT JOIN heartbeats AS h
         ON h.component = 'mailbox'
        AND h.workspace_id = m.workspace_id
        AND h.instance_key = m.id::text
      WHERE m.status = 'connected'
      ORDER BY m.id`,
  );
  return rows.map(row => {
    const ageSeconds = row.age_seconds === null ? null : Number(row.age_seconds);
    const fresh =
      ageSeconds !== null &&
      row.expected_interval_seconds !== null &&
      heartbeatIsFresh({ component: 'mailbox', ageSeconds, expectedIntervalSeconds: row.expected_interval_seconds });
    return { mailboxId: row.mailbox_id, ageSeconds, fresh };
  });
}

/**
 * How long the longest-disconnected mailbox has been disconnected, in hours, among
 * the mailboxes `hasRecentSend` says have sent recently.
 *
 * Null when none has. The alarm's missing-data treatment is `notBreaching`, so a
 * deployment with no mailboxes and a deployment with only healthy ones look the same
 * to it, which is correct: neither is a mailbox that stopped.
 */
export async function mailboxDisconnectedHours(
  db: Queryable,
  options: { readonly recentSenderIds?: readonly string[] | undefined } = {},
): Promise<number | null> {
  const recent = options.recentSenderIds;
  // Until G7-2 there is no record of a send, so the honest answer is "no mailbox
  // qualifies" rather than "every disconnected mailbox qualifies".
  if (recent === undefined || recent.length === 0) return null;
  const { rows } = await db.query<{ hours: string | null }>(
    `SELECT extract(epoch FROM now() - min(disconnected_at)) / 3600 AS hours
       FROM mailboxes
      WHERE status = 'revoked'
        AND disconnected_at IS NOT NULL
        AND id = ANY ($1::uuid[])`,
    [[...recent]],
  );
  const hours = rows[0]?.hours;
  return hours === null || hours === undefined ? null : Number(hours);
}

/** Everything the mail lane publishes on one metric pass. */
export async function collectMailMetrics(
  db: Queryable,
  options: { readonly recentSenderIds?: readonly string[] | undefined } = {},
): Promise<readonly MetricDatum[]> {
  const data: MetricDatum[] = [];

  // Every pass, 1 or 0: the alarm treats a missing datapoint as a missed check, so
  // "nothing is connected" is said as 1 rather than by silence.
  const checks = await connectedMailboxChecks(db);
  data.push({ name: 'MailboxCheckHeartbeat', value: checks.every(check => check.fresh) ? 1 : 0, unit: 'Count' });

  // Nothing, not 0, when no mailbox is connected and `ready`: the alarm treats missing
  // data as not breaching, and there is then no coverage for the gate to hold on.
  const coverageAge = await mailboxCoverageAgeSeconds(db);
  if (coverageAge !== null) data.push({ name: 'MailboxCoverageAgeSeconds', value: coverageAge, unit: 'Seconds' });

  const watchHours = await hoursToSoonestWatchExpiry(db);
  if (watchHours !== null) {
    // `None`, not `Hours`: CloudWatch has no unit for hours and rejects the whole
    // `PutMetricData` request over one datum that names it (24 September 2026, the
    // first connected mailbox). The value is still hours; the name says so, and the
    // `gmail_watch_expiring` alarm compares the bare number with a threshold in hours.
    data.push({ name: 'GmailWatchHoursToExpiry', value: Math.max(watchHours, 0), unit: 'None' });
  }

  const disconnectedHours = await mailboxDisconnectedHours(db, options);
  if (disconnectedHours !== null) {
    // Hours as a dimensionless `None`, for the reason given above.
    data.push({ name: 'MailboxDisconnectedHours', value: Math.max(disconnectedHours, 0), unit: 'None' });
  }

  return data;
}
