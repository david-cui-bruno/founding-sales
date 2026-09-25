import type { Queryable } from '../db/queryable.ts';
import type { MetricDatum } from '../jobs/metrics.ts';
import { hoursToSoonestWatchExpiry } from './watch.ts';

/**
 * The two mail metrics the infrastructure alarms on (13.3).
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
 */

export const MAIL_METRIC_NAMES: readonly string[] = Object.freeze([
  'GmailWatchHoursToExpiry',
  'MailboxDisconnectedHours',
]);

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
      WHERE status IN ('disconnected', 'revoked')
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
