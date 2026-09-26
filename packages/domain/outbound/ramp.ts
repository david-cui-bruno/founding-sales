import type { Queryable } from '../db/queryable.ts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { coverageRefusal, readMailboxCoverage } from '../mail/coverage.ts';
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
 * **A raise is the admin's decision, with a warning** (wave 2, S4.6). The "sustained
 * healthy results" clause is still a rule with two parts, `raiseRefusal`:
 *
 *   * the mailbox has finished the schedule — `RAMP_SETTLED_DAY` (30) healthy sending
 *     days, "After six healthy weeks" — `ramp_not_settled` otherwise;
 *   * its last `RAMP_RAISE_HEALTHY_STREAK` (10) closed sending days were all healthy,
 *     with no unhealthy one between them — `health_not_sustained`.
 *
 * `overrideRaise` (`POST /outbound/cap/override`) sets any raise up to the hard ceiling
 * and answers the part of the rule not met as a warning rather than a refusal: it is the
 * founder's own mailbox and his own risk. `setAdminCap` (`POST /outbound/cap`, desktop
 * 1.0.11) still refuses an unearned raise and one above 75, exactly as before. A stored
 * raise is honoured as written at every send — the per-send re-judgement of lane g87 is
 * gone with the lock — and the daily cap itself is checked exactly as before: the gate
 * refuses the send that would pass it.
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
 * The healthy sending day on which 12.7's schedule settles: "After six healthy weeks".
 * The last rung's end, so a schedule change moves it with the table.
 */
export const RAMP_SETTLED_DAY: number = RAMP_SCHEDULE[RAMP_SCHEDULE.length - 1]?.throughDay ?? 30;

/**
 * "Sustained healthy results", as a number the specification does not give: the most
 * recent closed sending days that must all have been healthy before a raise counts.
 *
 * Ten is the longest step the table itself takes — "Weeks 5–6", ten sending days at
 * one cap — so a raise asks for as long a clean run as any rung of the schedule does.
 * A lane's choice, named in `docs/decisions/g87-ramp-raise-headroom-exposure.md`;
 * changing it is David's decision, like the rate thresholds below.
 */
export const RAMP_RAISE_HEALTHY_STREAK = 10;

/** Why a raise is not earned (lane g87, S06). */
export type RaiseRefusal = 'ramp_not_settled' | 'health_not_sustained';

/**
 * Whether a mailbox has earned a raise above its schedule, or which part of the rule
 * it has not met. `healthyStreak` is `readHealthyStreak`'s answer.
 */
export function raiseRefusal(
  ramp: Pick<RampRow, 'healthySendingDays'>,
  healthyStreak: number,
): RaiseRefusal | null {
  if (ramp.healthySendingDays < RAMP_SETTLED_DAY) return 'ramp_not_settled';
  if (healthyStreak < RAMP_RAISE_HEALTHY_STREAK) return 'health_not_sustained';
  return null;
}

/**
 * The cap in force for one mailbox today: the schedule, or the admin's raise in its
 * place, then the admin's lowering, then the hard ceiling of 100, in that order. A raise
 * is honoured as written (wave 2, S4.6); whether it was earned is `raiseRefusal`'s
 * warning, not a bound on the cap.
 */
export function effectiveDailyCap(ramp: RampRow): number {
  const base = ramp.raisedDailyCap ?? scheduledCap(ramp.healthySendingDays);
  const lowered = ramp.adminDailyCap === null ? base : Math.min(base, ramp.adminDailyCap);
  return Math.max(Math.min(lowered, RAMP_HARD_CEILING), 0);
}

/**
 * How many of the mailbox's most recent closed sending days were healthy, counting
 * back from the latest until the first that was not, up to `limit`.
 *
 * A *sending* day is one with at least one automated send: 12.7 counts "healthy
 * sending days", and `rampHealthFailure` says a day with none "neither advances the
 * ramp nor counts against it", so a quiet Monday neither breaks a streak nor extends
 * one. An open day has no verdict yet and is not read. A closed day a late bounce
 * condemned (`recordBounceAgainstDay`) reads `healthy = false` and ends the streak.
 */
export async function readHealthyStreak(
  context: RepositoryContext,
  mailboxId: string,
  limit: number = RAMP_RAISE_HEALTHY_STREAK,
): Promise<number> {
  const { rows } = await context.db.query<{ healthy: boolean | null }>(
    `SELECT healthy FROM mailbox_send_days
      WHERE workspace_id = $1 AND mailbox_id = $2
        AND closed_at IS NOT NULL AND automated_sent > 0
      ORDER BY business_date DESC
      LIMIT $3`,
    [context.scope.workspaceId, mailboxId, Math.max(Math.trunc(limit), 0)],
  );
  let streak = 0;
  for (const row of rows) {
    if (row.healthy !== true) break;
    streak += 1;
  }
  return streak;
}

/** One mailbox's ramp as an admin sees it: the row, the streak and the cap in force. */
export interface RampStanding {
  readonly ramp: RampRow;
  readonly healthyStreak: number;
  readonly effectiveCap: number;
  /**
   * Why a raise is not earned today, or null when it is: `POST /outbound/cap` refuses
   * for it, and `POST /outbound/cap/override` answers it as a warning.
   */
  readonly raiseRefusal: RaiseRefusal | null;
}

export async function readRampStanding(
  context: RepositoryContext,
  mailboxId: string,
): Promise<RampStanding | null> {
  const ramp = await readRamp(context, mailboxId);
  if (ramp === null) return null;
  const healthyStreak = await readHealthyStreak(context, mailboxId);
  return {
    ramp,
    healthyStreak,
    effectiveCap: effectiveDailyCap(ramp),
    raiseRefusal: raiseRefusal(ramp, healthyStreak),
  };
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
 *
 * **A raise must be earned** (lane g87, S06). Any non-null `raiseTo` is refused unless
 * the mailbox has finished the schedule and its last `RAMP_RAISE_HEALTHY_STREAK`
 * closed sending days were all healthy — `ramp_not_settled` or
 * `health_not_sustained`, the part of the rule it has not met. Clearing a raise
 * (`raiseTo: null`) and lowering are never refused for health: both only make the cap
 * smaller.
 *
 * **Absent leaves a column alone; null clears it.** The route passes an absent field
 * through as absent and the desktop sends only the field a person changed, both on
 * that understanding. Until g87 this function read absent as null, so lowering a
 * raised mailbox during an incident silently cleared the raise as well, and raising it
 * cleared the lowering.
 *
 * The row is locked for the decision, so two admins cannot each read the other's
 * column as it was.
 */
export type AdminCapRefusal = 'raise_above_limit' | 'cap_out_of_range' | 'mailbox_unknown' | RaiseRefusal;

export type AdminCapOutcome =
  | { readonly ok: true; readonly ramp: RampRow; readonly effectiveCap: number }
  | { readonly ok: false; readonly reason: AdminCapRefusal };

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

  const locked = await context.db.query<RampDbRow>(
    `SELECT ${RAMP_COLUMNS} FROM mailbox_send_ramp WHERE workspace_id = $1 AND mailbox_id = $2 FOR UPDATE`,
    [context.scope.workspaceId, input.mailboxId],
  );
  const lockedRow = locked.rows[0];
  if (lockedRow === undefined) return { ok: false, reason: 'mailbox_unknown' };
  const current = toRamp(lockedRow);

  if (raiseTo !== null) {
    const refusal = raiseRefusal(current, await readHealthyStreak(context, input.mailboxId));
    if (refusal !== null) return { ok: false, reason: refusal };
  }

  const nextLower = input.lowerTo === undefined ? current.adminDailyCap : lowerTo;
  const nextRaise = input.raiseTo === undefined ? current.raisedDailyCap : raiseTo;
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
    [context.scope.workspaceId, input.mailboxId, nextLower, nextRaise, input.adminUserId],
  );
  const row = rows[0];
  if (row === undefined) return { ok: false, reason: 'mailbox_unknown' };
  const ramp = toRamp(row);
  return { ok: true, ramp, effectiveCap: effectiveDailyCap(ramp) };
}

export type OverrideRaiseOutcome =
  | {
      readonly ok: true;
      readonly ramp: RampRow;
      readonly effectiveCap: number;
      /** The part of the earned-raise rule the mailbox has not met, or null. Never a refusal. */
      readonly warning: RaiseRefusal | null;
    }
  | { readonly ok: false; readonly reason: 'cap_out_of_range' | 'mailbox_unknown' };

/**
 * The admin's override of the raise lock (wave 2, S4.6): set the mailbox's raised cap to
 * any number from 1 to the hard ceiling of 100, or clear it with null, whatever the
 * mailbox's health — and say so. The answer carries `warning`, the part of the earned
 * raise rule not met (`ramp_not_settled`, `health_not_sustained`), for the Mac to show
 * beside the new cap. The admin's lowering is left as it is; the ceiling stays a CHECK
 * on the column; the daily cap is enforced by the gate at every send exactly as before.
 */
export async function overrideRaise(
  context: RepositoryContext,
  input: { readonly mailboxId: string; readonly adminUserId: string; readonly raiseTo: number | null },
): Promise<OverrideRaiseOutcome> {
  const raiseTo = input.raiseTo;
  if (raiseTo !== null && (!Number.isInteger(raiseTo) || raiseTo < 1 || raiseTo > RAMP_HARD_CEILING)) {
    return { ok: false, reason: 'cap_out_of_range' };
  }
  const { rows: mailbox } = await context.db.query<{ id: string }>(
    'SELECT id FROM mailboxes WHERE workspace_id = $1 AND id = $2',
    [context.scope.workspaceId, input.mailboxId],
  );
  if (mailbox[0] === undefined) return { ok: false, reason: 'mailbox_unknown' };
  await ensureRamp(context, input.mailboxId);

  const { rows } = await context.db.query<RampDbRow>(
    `UPDATE mailbox_send_ramp
        SET raised_daily_cap = $3,
            admin_changed_at = CASE WHEN $3::integer IS NULL AND admin_daily_cap IS NULL THEN NULL ELSE now() END,
            admin_changed_by_user_id = CASE WHEN $3::integer IS NULL AND admin_daily_cap IS NULL
                                            THEN NULL ELSE $4::uuid END,
            updated_at = now()
      WHERE workspace_id = $1 AND mailbox_id = $2
      RETURNING ${RAMP_COLUMNS}`,
    [context.scope.workspaceId, input.mailboxId, raiseTo, input.adminUserId],
  );
  const row = rows[0];
  if (row === undefined) return { ok: false, reason: 'mailbox_unknown' };
  const ramp = toRamp(row);
  const warning = raiseTo === null ? null : raiseRefusal(ramp, await readHealthyStreak(context, input.mailboxId));
  return { ok: true, ramp, effectiveCap: effectiveDailyCap(ramp), warning };
}

export interface SendDayRow {
  readonly id: string;
  readonly businessDate: string;
  readonly automatedSent: number;
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
    cap_granted: number;
    healthy: boolean | null;
  }>(
    `INSERT INTO mailbox_send_days (workspace_id, mailbox_id, business_date, cap_granted)
     VALUES ($1, $2, $3::date, $4)
     ON CONFLICT (workspace_id, mailbox_id, business_date)
     DO UPDATE SET cap_granted = greatest(mailbox_send_days.cap_granted, EXCLUDED.cap_granted),
                   updated_at = now()
     RETURNING id, business_date, automated_sent, cap_granted, healthy`,
    [context.scope.workspaceId, input.mailboxId, input.businessDate, input.cap],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('the send-day upsert returned no row');
  return {
    id: row.id,
    businessDate: asDate(row.business_date) ?? input.businessDate,
    automatedSent: row.automated_sent,
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
 *
 * It is a *reservation by fence* (lane g77, C25): `send.ts` calls it only inside the
 * transaction that claims the fence, on the business date the claim records. The two
 * commit together or not at all, so no count exists without a claimed fence behind it
 * and none can be orphaned by a crash — `claimedAutomatedSends` is the same number
 * derived from the fences.
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
 * `automated_sent`, derived from the fences (lane g77, C25).
 *
 * Every increment of the counter commits in the transaction that claims a fence and
 * writes the same business date onto it, so for any mailbox and date the counter is
 * the number of fences whose dispatch began with that business date — sent, in doubt
 * or unknown alike, because the count stands once a message may have left. A
 * difference between the two is a count no claim explains, which is what the old
 * increment-then-OAuth-then-claim order produced when a process died in the middle;
 * the send path cannot produce one, and a day-boundary check or an incident can ask.
 */
export async function claimedAutomatedSends(
  context: RepositoryContext,
  input: { readonly mailboxId: string; readonly businessDate: string },
): Promise<number> {
  const { rows } = await context.db.query<{ claimed: string }>(
    `SELECT count(*)::text AS claimed FROM outbound_messages
      WHERE workspace_id = $1 AND mailbox_id = $2 AND business_date = $3::date
        AND attempt_token IS NOT NULL`,
    [context.scope.workspaceId, input.mailboxId, input.businessDate],
  );
  return Number(rows[0]?.claimed ?? '0');
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
 * What counting one bounce did to the day it belongs to.
 *
 * A null answer is a real answer: `mailbox_send_days` has no row for that mailbox and
 * date, so the day never sent anything automated and there is nothing for a bounce to
 * be a proportion of (`rampHealthFailure` calls such a day `no_sends`).
 */
export interface BounceAgainstDay {
  readonly businessDate: string;
  /** True when the day had already been closed when the bounce arrived. */
  readonly late: boolean;
  /** Whether the late bounce took back the day the ramp had counted. */
  readonly ramp: 'unchanged' | 'reversed';
  readonly failure: RampHealthFailure | null;
}

/**
 * Count one bounce against a send day, re-judging a day that has already closed
 * (12.7, lane G22).
 *
 * `recordDaySignal` is a bare `UPDATE`, which is right while the day is open and is
 * silent once it is not: lane G15 wrote down that "a bounce arriving after its day has
 * been closed is not counted against it". That is the hole this closes. A bounce is a
 * fact about the send that caused it, and the day the send happened on is the
 * denominator 12.7's threshold is a rate over, so a late report must be able to change
 * a verdict the close already reached.
 *
 * **The three non-counter conditions come from the verdict, not from a fresh read.**
 * `healthy = true` on a closed day *is* the record that authentication passed,
 * coverage was healthy and no provider warning was seen when the day closed. Asking
 * `readSendDayHealth` again would judge yesterday on today's mailbox state — a hold
 * opened this morning would condemn a day it had nothing to do with — so the
 * re-judgement changes only what the bounce changed.
 *
 * **Taking a day back is a decrement, and `last_advanced_on` does not move.** 12.7's
 * cap is a function of `healthy_sending_days`, so a day that turns out not to have
 * been healthy must leave the count. `last_advanced_on` stays where it is, because it
 * is what stops `closeSendDay` advancing the same date twice, and moving it back would
 * let a later close re-earn the day this call has just removed. The direction is the
 * conservative one in every case: the cap falls, never rises.
 *
 * Reversal happens at most once per day. The first call flips `healthy` to false under
 * the row lock this function's own `UPDATE` already holds, and every later bounce
 * finds a day that is no longer healthy and takes nothing.
 */
export async function recordBounceAgainstDay(
  context: RepositoryContext,
  input: { readonly mailboxId: string; readonly businessDate: string },
): Promise<BounceAgainstDay | null> {
  const { rows } = await context.db.query<{
    automated_sent: number;
    bounces: number;
    opt_outs: number;
    provider_errors: number;
    closed_at: Date | null;
    healthy: boolean | null;
  }>(
    `UPDATE mailbox_send_days
        SET bounces = bounces + 1, updated_at = now()
      WHERE workspace_id = $1 AND mailbox_id = $2 AND business_date = $3::date
      RETURNING automated_sent, bounces, opt_outs, provider_errors, closed_at, healthy`,
    [context.scope.workspaceId, input.mailboxId, input.businessDate],
  );
  const day = rows[0];
  if (day === undefined) return null;
  if (day.closed_at === null) {
    return { businessDate: input.businessDate, late: false, ramp: 'unchanged', failure: null };
  }
  if (day.healthy !== true) {
    // The day was already condemned, so it never advanced the ramp: there is nothing
    // to take back and the counter is simply more accurate than it was.
    return { businessDate: input.businessDate, late: true, ramp: 'unchanged', failure: null };
  }

  const failure = rampHealthFailure({
    authenticationPasses: true,
    coverageHealthy: true,
    providerWarning: false,
    automatedSent: day.automated_sent,
    bounces: day.bounces,
    optOuts: day.opt_outs,
    providerErrors: day.provider_errors,
  });
  if (failure === null) {
    return { businessDate: input.businessDate, late: true, ramp: 'unchanged', failure: null };
  }

  const { rowCount } = await context.db.query(
    `UPDATE mailbox_send_days SET healthy = false, updated_at = now()
      WHERE workspace_id = $1 AND mailbox_id = $2 AND business_date = $3::date AND healthy`,
    [context.scope.workspaceId, input.mailboxId, input.businessDate],
  );
  if ((rowCount ?? 0) === 0) {
    return { businessDate: input.businessDate, late: true, ramp: 'unchanged', failure };
  }
  await context.db.query(
    `UPDATE mailbox_send_ramp
        SET healthy_sending_days = greatest(healthy_sending_days - 1, 0),
            last_health_failure = $3,
            updated_at = now()
      WHERE workspace_id = $1 AND mailbox_id = $2`,
    [context.scope.workspaceId, input.mailboxId, failure],
  );
  return { businessDate: input.businessDate, late: true, ramp: 'reversed', failure };
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
 *   * **coverage** — the mailbox's coverage is *proven* (`coverageRefusal`: connected,
 *     `ready`, and a watermark inside `COVERAGE_FRESHNESS_SECONDS`, lane g77) and no
 *     open hold blocks `email_send` for it or for its owner — the same decision the
 *     send gate makes, from the same function.
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
  const coverage = await readMailboxCoverage(context, { mailboxId });
  if (coverage === null) return null;

  const domain = await readPrimarySendingDomain(context);
  const holds = await listApplicableHolds(context, {
    actionKind: 'email_send',
    ownerUserId: coverage.ownerUserId,
    mailboxId,
  });

  return {
    authenticationPasses: domain !== null && authenticationPasses(domain) && domain.automatedSendingEnabled,
    coverageHealthy: coverageRefusal(coverage) === null && holds.length === 0,
    providerWarning: false,
  };
}
