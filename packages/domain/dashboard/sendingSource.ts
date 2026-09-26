import type { RepositoryContext } from '../db/workspaceScope.ts';
import {
  authenticationPasses,
  effectiveDailyCap,
  readPrimarySendingDomain,
} from '../outbound/index.ts';
import { classifierFacts } from './classifierSource.ts';
import { enrollmentFacts } from './enrollmentSource.ts';
import {
  type Breakdown,
  type DashboardAudience,
  type DashboardSources,
  type DashboardWindow,
  type RampPosture,
  type SendingFacts,
  type SendingPosture,
} from './sources.ts';

/**
 * 13.4's sending figures, read from G7-2's tables (migration 0010).
 *
 * This is the implementation of the seam `sources.ts` describes: the DTO, the route
 * and the Mac's panel were built against a declared-unavailable default, and landing
 * the tables wires one function rather than designing a surface.
 *
 * ## The four counts, and what each instant means
 *
 * 13.4 asks for "emails sent, skipped, held and unknown". Each is counted by the
 * instant it happened at rather than by the fence's creation, because a window is a
 * question about a period and a fence prepared in August that sent in September sent
 * in September:
 *
 *   * `sent` — `state = 'sent'`, by `sent_at`;
 *   * `held` — `state = 'held'`, by `held_at`;
 *   * `unknown` — `state = 'unknown_terminal'` with no admin resolution, by
 *     `unknown_terminal_at`. A resolved one has left doubt and is counted below;
 *   * `skipped` and `resolvedDelivered` — 12.5's two admin resolutions, by
 *     `admin_resolved_at`.
 *
 * A fence can therefore appear in two counts across two windows — held in one,
 * unknown in another — which is correct: they are different events, not different
 * names for the fence.
 *
 * ## Reply attribution
 *
 * A reply is an incoming message in the same mailbox on the same Gmail thread, at or
 * after the send. That is the only linkage the schema actually carries, and it is an
 * honest one: `provider_thread_id` is written by the send path from Gmail's own
 * answer. A "positive" reply is one the classifier suggested `interested` for. Both
 * are counted `DISTINCT` on the message, because a message carries up to two
 * classification layers and a reply counted twice would quietly double a rate.
 *
 * ## The read matrix
 *
 * Counts follow the dashboard's audience rule (`docs/decisions/g9-dashboard-visibility.md`):
 * an admin's figures are the workspace's, a salesperson's are their own assigned
 * firms'. The posture follows Appendix F instead, because it is not a firm fact:
 * the domain checklist is admin configuration, and a ramp is mailbox diagnostics,
 * which row 3 gives to the mailbox's owner or an admin.
 */

type CountRow = {
  readonly [column: string]: unknown;
  sent: string;
  held: string;
  unknown_open: string;
  skipped: string;
  delivered: string;
};

type BreakdownRow = {
  readonly [column: string]: unknown;
  dimension: string;
  key: string;
  sent: string;
  replies: string;
  positive_replies: string;
};

type DayRow = {
  readonly [column: string]: unknown;
  provider_errors: string;
  unhealthy_days: string;
};

type RampRow = {
  readonly [column: string]: unknown;
  mailbox_id: string;
  healthy_sending_days: number;
  admin_daily_cap: number | null;
  raised_daily_cap: number | null;
  last_health_failure: string | null;
};

/**
 * Every fence on a firm the caller may see, as a common table expression the three
 * queries below start from. The audience is a nullable parameter rather than two
 * query strings so there is one place the visibility rule is written.
 */
const VISIBLE_FENCES = `
  SELECT om.*
    FROM outbound_messages om
    JOIN firms f ON f.workspace_id = om.workspace_id AND f.id = om.firm_id
   WHERE om.workspace_id = $1
     AND ($4::uuid IS NULL OR f.assigned_user_id = $4::uuid)
`;

export async function sendingFacts(
  context: RepositoryContext,
  window: DashboardWindow,
  audience: DashboardAudience,
): Promise<SendingFacts> {
  const scope = [context.scope.workspaceId, window.from, window.to, audience.onlyAssignedTo];

  const counts = await context.db.query<CountRow>(
    `WITH visible AS (${VISIBLE_FENCES})
     SELECT count(*) FILTER (WHERE state = 'sent'
                               AND sent_at >= $2::timestamptz AND sent_at < $3::timestamptz)::text AS sent,
            count(*) FILTER (WHERE state = 'held'
                               AND held_at >= $2::timestamptz AND held_at < $3::timestamptz)::text AS held,
            count(*) FILTER (WHERE state = 'unknown_terminal' AND admin_resolution IS NULL
                               AND unknown_terminal_at >= $2::timestamptz
                               AND unknown_terminal_at < $3::timestamptz)::text AS unknown_open,
            count(*) FILTER (WHERE admin_resolution = 'skipped'
                               AND admin_resolved_at >= $2::timestamptz
                               AND admin_resolved_at < $3::timestamptz)::text AS skipped,
            count(*) FILTER (WHERE admin_resolution = 'delivered'
                               AND admin_resolved_at >= $2::timestamptz
                               AND admin_resolved_at < $3::timestamptz)::text AS delivered
       FROM visible`,
    scope,
  );

  const breakdowns = await context.db.query<BreakdownRow>(
    `WITH visible AS (${VISIBLE_FENCES}),
          sent AS (
            -- The fence carries an enrollment id; which sequence that is takes two
            -- joins through G8 tables, and the answer is the sequence rather than
            -- the version, because 13.4 asks how a sequence performs and a version
            -- bump is not a different sequence.
            SELECT v.id, v.mailbox_id, v.template_version_id, v.sent_at, v.source_zone,
                   v.provider_thread_id, sv.sequence_id
              FROM visible v
              LEFT JOIN sequence_enrollments e
                ON e.workspace_id = $1 AND e.id = v.enrollment_id
              LEFT JOIN sequence_versions sv
                ON sv.workspace_id = $1 AND sv.id = e.sequence_version_id
             WHERE v.state = 'sent'
               AND v.sent_at >= $2::timestamptz AND v.sent_at < $3::timestamptz
          ),
          replied AS (
            SELECT s.id,
                   count(DISTINCT m.id)::int AS replies,
                   count(DISTINCT m.id) FILTER (WHERE c.suggested_disposition = 'interested')::int
                     AS positive_replies
              FROM sent s
              LEFT JOIN mail_messages m
                ON m.workspace_id = $1
               AND m.mailbox_id = s.mailbox_id
               AND m.provider_thread_id = s.provider_thread_id
               AND m.direction = 'incoming'
               AND m.internal_date >= s.sent_at
               AND m.internal_date < $3::timestamptz
              LEFT JOIN mail_message_classifications c
                ON c.workspace_id = $1 AND c.mail_message_id = m.id
             GROUP BY s.id
          ),
          joined AS (
            SELECT s.template_version_id, s.sequence_id, s.sent_at, s.source_zone,
                   r.replies, r.positive_replies
              FROM sent s JOIN replied r ON r.id = s.id
          )
     SELECT 'template' AS dimension,
            coalesce(template_version_id::text, 'none') AS key,
            count(*)::text AS sent,
            sum(replies)::text AS replies,
            sum(positive_replies)::text AS positive_replies
       FROM joined GROUP BY 1, 2
     UNION ALL
     -- The literal none is a real answer here: a draft has no enrollment, and 12.5
     -- makes a draft send a first-class origin rather than an anomaly.
     SELECT 'sequence', coalesce(sequence_id::text, 'none'),
            count(*)::text, sum(replies)::text, sum(positive_replies)::text
       FROM joined GROUP BY 1, 2
     UNION ALL
     SELECT 'weekday',
            extract(isodow FROM (sent_at AT TIME ZONE source_zone))::int::text,
            count(*)::text, sum(replies)::text, sum(positive_replies)::text
       FROM joined GROUP BY 1, 2
     UNION ALL
     SELECT 'hour',
            to_char(sent_at AT TIME ZONE source_zone, 'HH24'),
            count(*)::text, sum(replies)::text, sum(positive_replies)::text
       FROM joined GROUP BY 1, 2
     ORDER BY 1, 2`,
    scope,
  );

  // Send-day counters have no sub-day resolution, so the window's bounds are read as
  // whole business dates: a caller naming a mid-day upper bound excludes that day
  // rather than counting part of it as all of it.
  const days = await context.db.query<DayRow>(
    `SELECT coalesce(sum(d.provider_errors), 0)::text AS provider_errors,
            count(*) FILTER (WHERE d.healthy IS FALSE)::text AS unhealthy_days
       FROM mailbox_send_days d
       JOIN mailboxes mb ON mb.workspace_id = d.workspace_id AND mb.id = d.mailbox_id
      WHERE d.workspace_id = $1
        AND d.business_date >= ($2::timestamptz)::date
        AND d.business_date < ($3::timestamptz)::date
        AND ($4::uuid IS NULL OR mb.owner_user_id = $4::uuid)`,
    scope,
  );

  const count = counts.rows[0];
  const day = days.rows[0];
  const of = (dimension: string): readonly Breakdown[] =>
    breakdowns.rows
      .filter(row => row.dimension === dimension)
      .map(row => ({
        key: row.key,
        sent: Number(row.sent),
        replies: Number(row.replies),
        positiveReplies: Number(row.positive_replies),
      }));

  return {
    available: true,
    sent: Number(count?.sent ?? '0'),
    held: Number(count?.held ?? '0'),
    unknown: Number(count?.unknown_open ?? '0'),
    skipped: Number(count?.skipped ?? '0'),
    resolvedDelivered: Number(count?.delivered ?? '0'),
    providerDeferrals: Number(day?.provider_errors ?? '0'),
    reputationWarnings: Number(day?.unhealthy_days ?? '0'),
    posture: await sendingPosture(context, audience),
    byTemplateVersion: of('template'),
    byWeekday: of('weekday'),
    byLocalSendHour: of('hour'),
    bySequence: of('sequence'),
    // Still unavailable, and now provably rather than pending: G8's 0012 landed and
    // records no segment either, so no table in this build has one. 13.4 asks for
    // the breakdown; nothing has yet decided what a segment *is*. A zero here would
    // be a measurement of something nobody has defined.
    bySegment: {
      available: false,
      owner: 'unassigned',
      reason: 'no table in this build records a segment, and none of 0001–0013 defines one',
    },
  };
}

async function sendingPosture(
  context: RepositoryContext,
  audience: DashboardAudience,
): Promise<SendingPosture> {
  const domain =
    audience.onlyAssignedTo === null ? await readPrimarySendingDomain(context) : null;

  const { rows } = await context.db.query<RampRow>(
    `SELECT r.mailbox_id, r.healthy_sending_days, r.admin_daily_cap, r.raised_daily_cap,
            r.last_health_failure
       FROM mailbox_send_ramp r
       JOIN mailboxes mb ON mb.workspace_id = r.workspace_id AND mb.id = r.mailbox_id
      WHERE r.workspace_id = $1 AND ($2::uuid IS NULL OR mb.owner_user_id = $2::uuid)
      ORDER BY mb.email_address`,
    [context.scope.workspaceId, audience.onlyAssignedTo],
  );

  const ramps: readonly RampPosture[] = rows.map(row => ({
    mailboxId: row.mailbox_id,
    healthySendingDays: row.healthy_sending_days,
    effectiveCap: effectiveDailyCap({
      id: '',
      mailboxId: row.mailbox_id,
      healthySendingDays: row.healthy_sending_days,
      lastAdvancedOn: null,
      adminDailyCap: row.admin_daily_cap,
      raisedDailyCap: row.raised_daily_cap,
      lastHealthFailure: row.last_health_failure,
    }),
    adminDailyCap: row.admin_daily_cap,
    raisedDailyCap: row.raised_daily_cap,
    lastHealthFailure: row.last_health_failure,
  }));

  return {
    domain:
      domain === null
        ? null
        : {
            domain: domain.domain,
            authenticationPasses: authenticationPasses(domain),
            automatedSendingEnabled: domain.automatedSendingEnabled,
          },
    ramps,
  };
}

/**
 * What the API supplies. Every method reads a table that exists.
 *
 * `unavailableDashboardSources()` stays exported and stays tested: it is what a
 * caller uses when a source is deliberately not wired, and it is the shape the next
 * figure whose table does not exist yet will take.
 */
export function liveDashboardSources(): DashboardSources {
  return { sending: sendingFacts, enrollments: enrollmentFacts, classifier: classifierFacts };
}
