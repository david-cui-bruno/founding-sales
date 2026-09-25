import type { Queryable } from '../db/queryable.ts';
import type { MetricDatum } from '../jobs/metrics.ts';

/**
 * The outbound lane's gauges (specification 12.6, 13.3).
 *
 * `MailboxDisconnectedHours` is the metric G7-1 documented as owed. 13.3 alarms on
 * "a mailbox that sent in the last 30 days and remains disconnected for 48 hours",
 * and the first clause needs a record of having sent — which arrived with
 * `outbound_messages`, so the metric arrives here.
 *
 * Both clauses matter and dropping either produces a bad alarm. Without "sent in the
 * last 30 days" it fires on a mailbox nobody has ever used, which is noise that
 * trains an operator to ignore it. Without "disconnected for 48 hours" it fires on
 * every re-consent, which takes a salesperson about ninety seconds.
 *
 * The 30-day window counts *any* outgoing message from the mailbox, not only FSS
 * sends: a salesperson who writes their own mail from that mailbox every day is
 * exactly the person who will notice it has stopped importing, and 12.7 already
 * treats direct sends as real traffic.
 *
 * "Disconnected" here means the grant is gone without anyone choosing it: `revoked`,
 * which is what a refused refresh (`holdForRevokedGrant`) and a departure write. A
 * mailbox its owner disconnected with the disconnect command is `disconnected`, and is
 * not a mailbox that stopped (lane g81, audit O15): until then it too alarmed as
 * critical 48 hours after the owner chose it.
 */

export const OUTBOUND_METRIC_NAMES: readonly string[] = Object.freeze(['MailboxDisconnectedHours']);

export const RECENT_SEND_WINDOW_DAYS = 30;
export const MAILBOX_DISCONNECTED_ALARM_HOURS = 48;

/**
 * How long the longest-disconnected *recently active* mailbox has been disconnected,
 * in hours, or null when there is no such mailbox.
 *
 * Null rather than zero, because the alarm's missing-data treatment is
 * `notBreaching`: a deployment with no mailboxes and a deployment whose mailboxes are
 * all healthy should look the same to it, and neither is a mailbox that stopped.
 */
export async function mailboxDisconnectedHours(db: Queryable): Promise<number | null> {
  const { rows } = await db.query<{ hours: string | null }>(
    `SELECT extract(epoch FROM now() - min(m.disconnected_at)) / 3600 AS hours
       FROM mailboxes AS m
      WHERE m.status = 'revoked'
        AND m.disconnected_at IS NOT NULL
        AND (
          EXISTS (
            SELECT 1 FROM outbound_messages AS o
             WHERE o.workspace_id = m.workspace_id
               AND o.mailbox_id = m.id
               AND o.state = 'sent'
               AND o.sent_at > now() - make_interval(days => $1::integer)
          )
          OR EXISTS (
            SELECT 1 FROM mail_messages AS d
             WHERE d.workspace_id = m.workspace_id
               AND d.mailbox_id = m.id
               AND d.direction = 'outgoing'
               AND d.internal_date > now() - make_interval(days => $1::integer)
          )
        )`,
    [RECENT_SEND_WINDOW_DAYS],
  );
  const hours = rows[0]?.hours;
  return hours === null || hours === undefined ? null : Number(hours);
}

/** Everything the outbound lane publishes on one metric pass. */
export async function collectOutboundMetrics(db: Queryable): Promise<readonly MetricDatum[]> {
  const data: MetricDatum[] = [];
  const disconnected = await mailboxDisconnectedHours(db);
  if (disconnected !== null) {
    // `None`, not `Hours`: CloudWatch has no hour unit and rejects the whole request
    // over one datum that names it. The value is hours, as the name says, and the
    // `mailbox_disconnected` alarm compares the bare number with a threshold in hours.
    data.push({ name: 'MailboxDisconnectedHours', value: Math.max(disconnected, 0), unit: 'None' });
  }
  return data;
}

/**
 * How many fences are in doubt right now, for the dashboard of 13.3's minimum
 * performance view.
 *
 * Not an alarm. A handful of reconciling fences is ordinary — Gmail's Sent index is
 * not instant — and alarming on it would page somebody for a system working exactly
 * as Appendix B designed. What is worth seeing is the *count of unresolved terminal*
 * fences, because each one is a question waiting on a person.
 */
export async function outboundDoubtCounts(
  db: Queryable,
): Promise<{ readonly reconciling: number; readonly unresolvedTerminal: number }> {
  const { rows } = await db.query<{ reconciling: string; unresolved: string }>(
    `SELECT count(*) FILTER (WHERE state = 'reconciling')::text AS reconciling,
            count(*) FILTER (WHERE state = 'unknown_terminal' AND admin_resolution IS NULL)::text AS unresolved
       FROM outbound_messages`,
  );
  return {
    reconciling: Number(rows[0]?.reconciling ?? '0'),
    unresolvedTerminal: Number(rows[0]?.unresolved ?? '0'),
  };
}
