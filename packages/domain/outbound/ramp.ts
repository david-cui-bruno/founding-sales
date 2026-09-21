import type { Queryable } from '../db/queryable.ts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { listApplicableHolds } from '../policy/holds.ts';
import { authenticationPasses, readPrimarySendingDomain } from './domainGuard.ts';
import {
  RAMP_ADMIN_RAISE_LIMIT,
  RAMP_HARD_CEILING,
  RAMP_SCHEDULE,
  RAMP_SETTLED_CAP,
} from './types.ts';

/**
 * The reputation ramp (specification 12.7).
 *
 * The whole of this file is one idea: **the cap is computed, never stored**. What is
 * stored is the number of healthy sending days the mailbox has behind it, and the two
 * admin adjustments. The schedule is `RAMP_SCHEDULE`, and if it ever changes, every
 * mailbox already ramping is governed by the new one the moment the release lands,
 * which is what an operator expects of a safety limit.
 *
 * The two admin columns are not symmetrical and must not be treated as one.
 *
 * `admin_daily_cap` is a *lower bound on the day*: "Admins may lower caps." It is
 * combined with a minimum, so an admin who sets 3 while the schedule says 25 gets 3,
 * and an admin who sets 40 while the schedule says 5 still gets 5. Letting an admin
 * raise through this column would let a mistyped number undo the entire ramp.
 *
 * `raised_daily_cap` is the deliberate raise of "After sustained healthy results they
 * may raise a mailbox to 75". It replaces the schedule rather than bounding it, and
 * the *command* that writes it is what enforces the 75; the hard ceiling of 100 is a
 * CHECK on the column, because 12.7 calls it "a hard automated ceiling" and version
 * one should not be able to exceed it by any path at all.
 *
 * When both are set the minimum wins. An admin who raised a mailbox last month and
 * lowers it during an incident today means the incident.
 */

export interface RampRow {
  readonly id: string;
  readonly mailboxId: string;
  readonly healthySendingDays: number;
  readonly lastAdvancedOn: string | null;
  readonly adminDailyCap: number | null;
  readonly raisedDailyCap: number | null;
  readonly lastHealthFailure: string | null;
}

type RampDbRow = {
  id: string;
  mailbox_id: string;
  healthy_sending_days: number;
  last_advanced_on: Date | string | null;
  admin_daily_cap: number | null;
  raised_daily_cap: number | null;
  last_health_failure: string | null;
};

const asDate = (value: Date | string | null): string | null =>
  value === null ? null : value instanceof Date ? value.toISOString().slice(0, 10) : value;

function toRamp(row: RampDbRow): RampRow {
  return {
    id: row.id,
    mailboxId: row.mailbox_id,
    healthySendingDays: row.healthy_sending_days,
    lastAdvancedOn: asDate(row.last_advanced_on),
    adminDailyCap: row.admin_daily_cap,
    raisedDailyCap: row.raised_daily_cap,
    lastHealthFailure: row.last_health_failure,
  };
}

const RAMP_COLUMNS =
  'id, mailbox_id, healthy_sending_days, last_advanced_on, admin_daily_cap, raised_daily_cap, last_health_failure';

/** 12.7's table, as a function of healthy sending days. */
export function scheduledCap(healthySendingDays: number): number {
  const days = Math.max(Math.floor(healthySendingDays), 0);
  for (const band of RAMP_SCHEDULE) {
    if (days < band.throughDay) return band.cap;
  }
  return RAMP_SETTLED_CAP;
}

/**
 * The cap in force for one mailbox today: the schedule, the admin raise, the admin
 * lowering, and the hard ceiling, in that order of application.
 */
export function effectiveDailyCap(ramp: RampRow): number {
  const base = ramp.raisedDailyCap ?? scheduledCap(ramp.healthySendingDays);
  const lowered = ramp.adminDailyCap === null ? base : Math.min(base, ramp.adminDailyCap);
  return Math.max(Math.min(lowered, RAMP_HARD_CEILING), 0);
}

export async function readRamp(
  context: RepositoryContext,
  mailboxId: string,
): Promise<RampRow | null> {
  const { rows } = await context.db.query<RampDbRow>(
    `SELECT ${RAMP_COLUMNS} FROM mailbox_send_ramp WHERE workspace_id = $1 AND mailbox_id = $2`,
    [context.scope.workspaceId, mailboxId],
  );
  const row = rows[0];
  return row === undefined ? null : toRamp(row);
}

/**
 * The mailbox's ramp, created at zero if it has none.
 *
 * 12.7: "New mailboxes begin a mailbox-specific ramp even after the domain matures."
 * A missing row therefore means day zero and a cap of five, not "unlimited" and not
 * an error — so this is an upsert rather than a read that can fail.
 */
export async function ensureRamp(context: RepositoryContext, mailboxId: string): Promise<RampRow> {
  const { rows } = await context.db.query<RampDbRow>(
    `INSERT INTO mailbox_send_ramp (workspace_id, mailbox_id)
     VALUES ($1, $2)
     ON CONFLICT (workspace_id, mailbox_id) DO UPDATE SET updated_at = mailbox_send_ramp.updated_at
     RETURNING ${RAMP_COLUMNS}`,
    [context.scope.workspaceId, mailboxId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('the ramp upsert returned no row');
  return toRamp(row);
}

/**
 * 12.7's health conditions, as data.
 *
 * "The ramp advances only with passing authentication, healthy mailbox coverage, no
 * provider rate-limit or reputation warning, and acceptable bounce and opt-out
 * signals."
 *
 * Each field is one clause of that sentence, and `rampHealthFailure` returns the
 * first that is false. Returning the *reason* rather than a boolean is what lets
 * `mailbox_send_ramp.last_health_failure` tell an operator why a mailbox has been
 * stuck at five a day for a fortnight, which is a question that otherwise takes an
 * afternoon.
 */
export interface RampHealthSignals {
  readonly authenticationPasses: boolean;
  readonly coverageHealthy: boolean;
  readonly providerWarning: boolean;
  readonly automatedSent: number;
  readonly bounces: number;
  readonly optOuts: number;
  readonly providerErrors: number;
}

/**
 * The thresholds "acceptable bounce and opt-out signals" is read as.
 *
 * The specification does not give numbers, so these are conservative and named: a
 * day with more than five per cent bounces or more than ten per cent opt-outs does
 * not advance the ramp. They are deliberately *not* thresholds for stopping — that
 * is a hold, and holds have their own reasons — only for whether the day counts
 * toward earning a larger cap tomorrow.
 *
 * Small denominators are the trap. On a five-send day one bounce is twenty per cent,
 * which would stall every new mailbox on its first bad luck, so a day is only judged
 * on its rates once it has sent `RAMP_RATE_FLOOR` messages; below that a single
 * bounce is tolerated and two are not.
 */
export const RAMP_MAX_BOUNCE_RATE = 0.05;
export const RAMP_MAX_OPT_OUT_RATE = 0.1;
export const RAMP_RATE_FLOOR = 20;
export const RAMP_SMALL_DAY_TOLERANCE = 1;

export type RampHealthFailure =
  | 'authentication_failing'
  | 'coverage_unhealthy'
  | 'provider_warning'
  | 'bounce_rate'
  | 'opt_out_rate'
  | 'no_sends';

export function rampHealthFailure(signals: RampHealthSignals): RampHealthFailure | null {
  if (!signals.authenticationPasses) return 'authentication_failing';
  if (!signals.coverageHealthy) return 'coverage_unhealthy';
  if (signals.providerWarning || signals.providerErrors > 0) return 'provider_warning';
  // A day with no automated sends is not a sending day, so it neither advances the
  // ramp nor counts against it. 12.7 counts "healthy sending days".
  if (signals.automatedSent === 0) return 'no_sends';

  if (signals.automatedSent < RAMP_RATE_FLOOR) {
    if (signals.bounces > RAMP_SMALL_DAY_TOLERANCE) return 'bounce_rate';
    if (signals.optOuts > RAMP_SMALL_DAY_TOLERANCE) return 'opt_out_rate';
    return null;
  }
  if (signals.bounces / signals.automatedSent > RAMP_MAX_BOUNCE_RATE) return 'bounce_rate';
  if (signals.optOuts / signals.automatedSent > RAMP_MAX_OPT_OUT_RATE) return 'opt_out_rate';
  return null;
}

export interface CloseDayOutcome {
  readonly healthy: boolean;
  readonly failure: RampHealthFailure | null;
  readonly healthySendingDays: number;
  readonly advanced: boolean;
}

/**
 * Close one business date for one mailbox and advance the ramp if the day was
 * healthy.
 *
 * Idempotent in the way that matters: `last_advanced_on` is compared with the date
 * being closed, so running this twice for the same date advances once. That is not a
 * convenience — a ramp that could be advanced twice by a repeated job would reach
 * fifty a day in half the time the specification allows, which is precisely the
 * outcome the ramp exists to prevent.
 */
export async function closeSendDay(
  context: RepositoryContext,
  input: {
    readonly mailboxId: string;
    readonly businessDate: string;
    readonly signals: Omit<RampHealthSignals, 'automatedSent' | 'bounces' | 'optOuts' | 'providerErrors'>;
  },
): Promise<CloseDayOutcome | null> {
  const { rows } = await context.db.query<{
    automated_sent: number;
    bounces: number;
    opt_outs: number;
    provider_errors: number;
    closed_at: Date | null;
  }>(
    `SELECT automated_sent, bounces, opt_outs, provider_errors, closed_at
       FROM mailbox_send_days
      WHERE workspace_id = $1 AND mailbox_id = $2 AND business_date = $3::date
      FOR UPDATE`,
    [context.scope.workspaceId, input.mailboxId, input.businessDate],
  );
  const day = rows[0];
  if (day === undefined) return null;

  const failure = rampHealthFailure({
    ...input.signals,
    automatedSent: day.automated_sent,
    bounces: day.bounces,
    optOuts: day.opt_outs,
    providerErrors: day.provider_errors,
  });
  const healthy = failure === null;

  if (day.closed_at === null) {
    await context.db.query(
      `UPDATE mailbox_send_days
          SET healthy = $4, closed_at = now(), updated_at = now()
        WHERE workspace_id = $1 AND mailbox_id = $2 AND business_date = $3::date`,
      [context.scope.workspaceId, input.mailboxId, input.businessDate, healthy],
    );
  }

  const ramp = await ensureRamp(context, input.mailboxId);
  if (!healthy) {
    await context.db.query(
      `UPDATE mailbox_send_ramp SET last_health_failure = $3, updated_at = now()
        WHERE workspace_id = $1 AND mailbox_id = $2`,
      [context.scope.workspaceId, input.mailboxId, failure],
    );
    return { healthy: false, failure, healthySendingDays: ramp.healthySendingDays, advanced: false };
  }

  const advanced = await context.db.query<{ healthy_sending_days: number }>(
    `UPDATE mailbox_send_ramp
        SET healthy_sending_days = healthy_sending_days + 1,
            last_advanced_on = $3::date,
            last_health_failure = NULL,
            updated_at = now()
      WHERE workspace_id = $1 AND mailbox_id = $2
        AND (last_advanced_on IS NULL OR last_advanced_on < $3::date)
      RETURNING healthy_sending_days`,
    [context.scope.workspaceId, input.mailboxId, input.businessDate],
  );
  const updated = advanced.rows[0];
  return {
    healthy: true,
    failure: null,
    healthySendingDays: updated?.healthy_sending_days ?? ramp.healthySendingDays,
    advanced: updated !== undefined,
  };
}

/**
 * An admin lowering or raising a mailbox's cap (12.7).
 *
 * `lowerTo` and `raiseTo` are separate parameters rather than one number, because
 * they mean different things and are subject to different limits. A raise above
 * `RAMP_ADMIN_RAISE_LIMIT` is refused here rather than silently clamped: an admin who
 * typed 100 meant 100, and telling them the limit is 75 is better than giving them 75
 * and letting them believe they have 100.
 */
export type AdminCapOutcome =
  | { readonly ok: true; readonly ramp: RampRow; readonly effectiveCap: number }
  | { readonly ok: false; readonly reason: 'raise_above_limit' | 'cap_out_of_range' | 'mailbox_unknown' };

export async function setAdminCap(
  context: RepositoryContext,
  input: {
    readonly mailboxId: string;
    readonly adminUserId: string;
    readonly lowerTo?: number | null | undefined;
    readonly raiseTo?: number | null | undefined;
  },
): Promise<AdminCapOutcome> {
  const lowerTo = input.lowerTo ?? null;
  const raiseTo = input.raiseTo ?? null;
  if (raiseTo !== null && raiseTo > RAMP_ADMIN_RAISE_LIMIT) return { ok: false, reason: 'raise_above_limit' };
  if (raiseTo !== null && raiseTo < 1) return { ok: false, reason: 'cap_out_of_range' };
  if (lowerTo !== null && (lowerTo < 0 || lowerTo > RAMP_HARD_CEILING)) {
    return { ok: false, reason: 'cap_out_of_range' };
  }

  const existing = await readRamp(context, input.mailboxId);
  if (existing === null) {
    const { rows } = await context.db.query<{ id: string }>(
      'SELECT id FROM mailboxes WHERE workspace_id = $1 AND id = $2',
      [context.scope.workspaceId, input.mailboxId],
    );
    if (rows[0] === undefined) return { ok: false, reason: 'mailbox_unknown' };
    await ensureRamp(context, input.mailboxId);
  }

  const { rows } = await context.db.query<RampDbRow>(
    `UPDATE mailbox_send_ramp
        SET admin_daily_cap = $3,
            raised_daily_cap = $4,
            admin_changed_at = CASE WHEN $3::integer IS NULL AND $4::integer IS NULL
                                    THEN NULL ELSE now() END,
            admin_changed_by_user_id = CASE WHEN $3::integer IS NULL AND $4::integer IS NULL
                                            THEN NULL ELSE $5::uuid END,
            updated_at = now()
      WHERE workspace_id = $1 AND mailbox_id = $2
      RETURNING ${RAMP_COLUMNS}`,
    [context.scope.workspaceId, input.mailboxId, lowerTo, raiseTo, input.adminUserId],
  );
  const row = rows[0];
  if (row === undefined) return { ok: false, reason: 'mailbox_unknown' };
  const ramp = toRamp(row);
  return { ok: true, ramp, effectiveCap: effectiveDailyCap(ramp) };
}

export interface SendDayRow {
  readonly id: string;
  readonly businessDate: string;
  readonly automatedSent: number;
  readonly directSent: number;
  readonly capGranted: number;
  readonly healthy: boolean | null;
}

/**
 * The mailbox's counter row for one business date, created if absent, with the cap
 * recorded as a high-water mark.
 *
 * `cap_granted` uses `greatest` so it never decreases. `mailbox_send_days_within_cap`
 * is a backstop, and a backstop that an admin's mid-incident lowering could make
 * unsatisfiable would refuse the lowering — which is the opposite of what an
 * incident needs. The lowering happens on the ramp, which the send path reads fresh.
 */
export async function openSendDay(
  context: RepositoryContext,
  input: { readonly mailboxId: string; readonly businessDate: string; readonly cap: number },
): Promise<SendDayRow> {
  const { rows } = await context.db.query<{
    id: string;
    business_date: Date | string;
    automated_sent: number;
    direct_sent: number;
    cap_granted: number;
    healthy: boolean | null;
  }>(
    `INSERT INTO mailbox_send_days (workspace_id, mailbox_id, business_date, cap_granted)
     VALUES ($1, $2, $3::date, $4)
     ON CONFLICT (workspace_id, mailbox_id, business_date)
     DO UPDATE SET cap_granted = greatest(mailbox_send_days.cap_granted, EXCLUDED.cap_granted),
                   updated_at = now()
     RETURNING id, business_date, automated_sent, direct_sent, cap_granted, healthy`,
    [context.scope.workspaceId, input.mailboxId, input.businessDate, input.cap],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('the send-day upsert returned no row');
  return {
    id: row.id,
    businessDate: asDate(row.business_date) ?? input.businessDate,
    automatedSent: row.automated_sent,
    directSent: row.direct_sent,
    capGranted: row.cap_granted,
    healthy: row.healthy,
  };
}

/**
 * Count one automated send against the day, refusing if it would exceed the cap.
 *
 * The `WHERE automated_sent < $4` is the cap, and it is the cap because it is in the
 * same statement as the increment. Reading the counter, comparing it and then writing
 * it would let two workers each read four, each decide four is under five, and each
 * send — which is Appendix G 33's "mailbox caps hold excess" failing in the one way
 * that matters.
 */
export async function countAutomatedSend(
  context: RepositoryContext,
  input: { readonly mailboxId: string; readonly businessDate: string; readonly cap: number },
): Promise<boolean> {
  const { rowCount } = await context.db.query(
    `UPDATE mailbox_send_days
        SET automated_sent = automated_sent + 1, updated_at = now()
      WHERE workspace_id = $1 AND mailbox_id = $2 AND business_date = $3::date
        AND automated_sent < $4`,
    [context.scope.workspaceId, input.mailboxId, input.businessDate, input.cap],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Count one direct send — a message the salesperson wrote in Gmail themselves.
 *
 * 12.7: "All outgoing Gmail messages, including direct sends, count toward
 * operational headroom." They are counted in their own column and never against the
 * automated cap, because the cap is FSS's self-restraint and a person writing their
 * own email is not FSS.
 */
export async function countDirectSend(
  context: RepositoryContext,
  input: { readonly mailboxId: string; readonly businessDate: string; readonly cap: number },
): Promise<void> {
  await context.db.query(
    `INSERT INTO mailbox_send_days (workspace_id, mailbox_id, business_date, cap_granted, direct_sent)
     VALUES ($1, $2, $3::date, $4, 1)
     ON CONFLICT (workspace_id, mailbox_id, business_date)
     DO UPDATE SET direct_sent = mailbox_send_days.direct_sent + 1, updated_at = now()`,
    [context.scope.workspaceId, input.mailboxId, input.businessDate, input.cap],
  );
}

/** Record a bounce, an opt-out or a provider error against the day the ramp reads. */
export async function recordDaySignal(
  context: RepositoryContext,
  input: {
    readonly mailboxId: string;
    readonly businessDate: string;
    readonly signal: 'bounce' | 'opt_out' | 'provider_error';
  },
): Promise<void> {
  const column =
    input.signal === 'bounce' ? 'bounces' : input.signal === 'opt_out' ? 'opt_outs' : 'provider_errors';
  await context.db.query(
    `UPDATE mailbox_send_days
        SET ${column} = ${column} + 1, updated_at = now()
      WHERE workspace_id = $1 AND mailbox_id = $2 AND business_date = $3::date`,
    [context.scope.workspaceId, input.mailboxId, input.businessDate],
  );
}

/**
 * Every mailbox with an open day older than the given business date, for the sweep.
 *
 * `workspaceId` narrows it to one workspace, which is what the scheduler source wants:
 * `mailbox_send_days.business_date` is in the *workspace's* zone (migration 0010 says
 * so beside the column), so "yesterday" is a different date for two workspaces in
 * different zones and one global cut-off would close one of them a day early.
 */
export async function listDaysToClose(
  db: Queryable,
  beforeBusinessDate: string,
  options: { readonly workspaceId?: string | undefined; readonly limit?: number | undefined } = {},
): Promise<readonly { readonly workspaceId: string; readonly mailboxId: string; readonly businessDate: string }[]> {
  const { rows } = await db.query<{ workspace_id: string; mailbox_id: string; business_date: Date | string }>(
    `SELECT workspace_id, mailbox_id, business_date
       FROM mailbox_send_days
      WHERE closed_at IS NULL AND business_date < $1::date
        AND ($2::uuid IS NULL OR workspace_id = $2)
      ORDER BY business_date, mailbox_id
      LIMIT $3`,
    [beforeBusinessDate, options.workspaceId ?? null, Math.trunc(options.limit ?? 500)],
  );
  return rows.map(row => ({
    workspaceId: row.workspace_id,
    mailboxId: row.mailbox_id,
    businessDate: asDate(row.business_date) ?? beforeBusinessDate,
  }));
}

/**
 * The three health conditions of 12.7 that are not counters on the day itself.
 *
 * "The ramp advances only with passing authentication, healthy mailbox coverage, no
 * provider rate-limit or reputation warning, and acceptable bounce and opt-out
 * signals." The last clause is `mailbox_send_days`; the first three are read here,
 * from the same rows the send gate reads before every send, so a day cannot be judged
 * healthy on facts the gate would have refused:
 *
 *   * **authentication** — the workspace's primary sending domain has SPF, DKIM and
 *     DMARC recorded as passing and automated sending enabled. 12.7's gate is an
 *     admin's checklist, never a DNS lookup (`docs/decisions/g7-no-dns-lookup.md`).
 *   * **coverage** — the mailbox is `ready` and no open hold blocks `email_send` for
 *     it or for its owner, which is `decideSend`'s own pair of checks.
 *   * **provider warning** — FSS subscribes to no Postmaster Tools feed, so the only
 *     provider complaint it can observe is an error during dispatch, and that is
 *     already counted on the day as `provider_errors`. Reporting a second, unsourced
 *     boolean would be inventing a signal; this one is always false and the counter
 *     does the work. Named in the decision record as a known limit of version one.
 *
 * `null` means the mailbox is not this workspace's, which is a payload naming
 * somebody else's mailbox rather than a day that cannot be judged.
 */
export async function readSendDayHealth(
  context: RepositoryContext,
  mailboxId: string,
): Promise<Omit<RampHealthSignals, 'automatedSent' | 'bounces' | 'optOuts' | 'providerErrors'> | null> {
  const { rows } = await context.db.query<{ sync_state: string; owner_user_id: string }>(
    'SELECT sync_state, owner_user_id FROM mailboxes WHERE workspace_id = $1 AND id = $2',
    [context.scope.workspaceId, mailboxId],
  );
  const mailbox = rows[0];
  if (mailbox === undefined) return null;

  const domain = await readPrimarySendingDomain(context);
  const holds = await listApplicableHolds(context, {
    actionKind: 'email_send',
    ownerUserId: mailbox.owner_user_id,
    mailboxId,
  });

  return {
    authenticationPasses: domain !== null && authenticationPasses(domain) && domain.automatedSendingEnabled,
    coverageHealthy: mailbox.sync_state === 'ready' && holds.length === 0,
    providerWarning: false,
  };
}
