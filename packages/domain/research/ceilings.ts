import { localDate } from '../src/rules/localClock.ts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { incrementDailyCounter, readDailyCounter } from '../jobs/counters.ts';
import { readSpend, workspaceBusinessZone } from './ledger.ts';
import { clearMonthlyCash, readMonthlyCashCeiling } from '../settings/cashCeiling.ts';
import {
  isPricedModel,
  worstCaseInputTokens,
  worstCaseRunCents,
  MAX_EXTRACTION_OUTPUT_TOKENS,
} from './pricing.ts';
import { readResearchSettings, type ResearchSettings } from './settings.ts';
import { accept, refuse, type ResearchResult } from './types.ts';

/**
 * The research caps (David's answer 8: "$20–30 a month, with calls ahead of
 * everything else"; the design record's "every model call is cleared, priced in cents
 * and accounted before it is made").
 *
 * Nothing in this package calls a provider without a clearance from here, and a
 * clearance is **consumed**: `claimResearchClearance` increments the counter as part
 * of deciding, through `incrementDailyCounter`, whose whole design note is the reason
 * — "a read of 'are we under the cap?' followed by a write is the classic way to send
 * the fifty-first message of a fifty-message day".
 *
 * Consuming means a granted clearance has already spent the unit, so a caller that
 * abandons the work has still used it. That is deliberate. The alternative — a
 * reservation released on failure — is a distributed transaction with a provider, and
 * the failure mode of getting it wrong is calling a provider more times than the
 * ceiling allows. Losing a unit of a daily count is the cheaper error.
 *
 * The order of the checks is the order of how much it costs to be wrong about them:
 *
 *   1. research disabled — nothing may run at all;
 *   2. the model has no reviewed price — nothing can be priced, so nothing may run;
 *   3. the daily **count** ceiling, which is the atomic one and is therefore taken
 *      before the two that are only sums;
 *   4. today's cents plus this run's worst case;
 *   5. this month's cents plus this run's worst case.
 *
 * Both money checks use the reviewed worst case rather than the invoice, because the
 * invoice does not exist yet. A run that turns out cheaper frees budget for the next
 * one; a run that could turn out dearer could not have been authorized at all.
 *
 * ## One clearance, for every reservation, retries included
 *
 * `claimResearchClearance` is the **only** way a `provider_reservations` row is
 * priced, and attempt 1 and a retry go through the same door. They did not: a retry's
 * row was inserted in chunk 2 with no money check at all, so at the defaults sixteen
 * runs held 48 of the day's 50 cents and one retry took it to 51. The three-row cap that
 * was supposed to bound a firm was counted *per run*, and two revisions of one firm in
 * one day are two runs — so "nine cents a firm a day" was not enforced by anything.
 *
 * What one reservation now has to pass:
 *
 *   1. research is enabled and the settings' model has a reviewed price;
 *   2. the workspace's budget lock (`pg_advisory_xact_lock`), so two claims cannot read
 *      the same remaining cents and both spend them. It is transaction-scoped, which
 *      means it is the caller's transaction that makes it a lock — the handler's chunk
 *      is one (`runner/jobRunner.ts`), and a direct call in autocommit gets the checks
 *      without the mutual exclusion;
 *   3. for attempt 1 only, a consumed unit of the day's **firm** count. A retry is the
 *      same firm and must not spend a second unit; what bounds attempts is rule 4;
 *   4. the firm has fewer than `RESEARCH_FIRM_MAX_RESERVATIONS` reservation rows on this
 *      business date, counted across **every run of that firm** rather than per run;
 *   5. spend — the ledger's invoiced cents plus every open reservation, each on its own
 *      business date — plus this reservation's cents is within the daily ceiling;
 *   6. and within the monthly one.
 *
 * Rules 4, 5 and 6 answer `over_budget`, `daily_cost_ceiling` and
 * `monthly_cost_ceiling`: three ceilings, each named separately, because which one bound
 * is the first thing a person wants to know.
 */

/**
 * Reservations one firm may hold on one business date, and therefore paid calls one firm
 * can cost in a day: three worst cases, nine cents at the defaults.
 *
 * It is a money bound, not a queue ladder, which is why it lives with the ceilings and
 * not with `maxAttempts`: an admin requeue resets the attempt counter, a handler option
 * can lower the ladder to one, and a second revision of the same firm is a different run
 * — and none of them may buy a fourth call. Counted from the rows, across the firm's
 * runs, on the date each row was authorized for.
 */
export const RESEARCH_FIRM_MAX_RESERVATIONS = 3;

export interface ResearchClearance {
  readonly settings: ResearchSettings;
  readonly businessTimeZone: string;
  readonly businessDate: string;
  /** The count after this clearance was taken, or null for a retry, which takes none. */
  readonly count: number | null;
  /** What the workspace had already spent when the clearance was granted. */
  readonly todayCents: number;
  readonly monthToDateCents: number;
  /** The number both money checks were made against. Held on the reservation row. */
  readonly worstCaseCents: number;
  /**
   * The priced shape of the call this reservation authorizes, snapshotted onto the row.
   *
   * Chunk 3 admits its request against these three numbers rather than against the
   * settings it reads at the time, because the settings are mutable and the cents are
   * not: raising `max_pages_per_firm` between the chunks used to admit a request larger
   * than the money being held for it.
   */
  readonly modelName: string;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
}

/** `daily_counters.counter_kind`, lower snake, as its CHECK requires. */
export const RESEARCH_FIRM_RUN_COUNTER = 'research_firm_runs';

/**
 * The `pg_advisory_xact_lock` namespace for a workspace's research budget.
 *
 * Two keys, a namespace and a hash of the workspace, so this lock cannot collide with
 * another feature's advisory lock on the same cluster.
 */
const BUDGET_LOCK_NAMESPACE = 0x52534348; // 'RSCH'

export interface ResearchClearanceInput {
  readonly firmId: string;
  /** Database time. The business date of the reservation this clears is derived here. */
  readonly at: string;
  /**
   * `first` is attempt 1 of a run and consumes a unit of the day's firm count; `retry`
   * is a further attempt of the same run and consumes none. Everything else — the
   * firm's three rows a day, the daily cents, the monthly cents — is identical.
   */
  readonly attemptKind: 'first' | 'retry';
}

/** Price and clear exactly one reservation, or say why not. */
export async function claimResearchClearance(
  context: RepositoryContext,
  input: ResearchClearanceInput,
): Promise<ResearchResult<ResearchClearance>> {
  const settings = await readResearchSettings(context);
  if (!settings.enabled) return refuse('research_disabled');
  if (!isPricedModel(settings.modelName)) return refuse('model_unpriced');

  const businessTimeZone = await workspaceBusinessZone(context);
  const priced = {
    modelName: settings.modelName,
    maxPagesPerFirm: settings.maxPagesPerFirm,
    maxPageBytes: settings.maxPageBytes,
  };
  const worstCaseCents = worstCaseRunCents(priced);
  const businessDate = localDate(input.at, businessTimeZone);

  // The budget lock, before anything is read. Every number below is a sum over rows
  // another claim could be inserting, so reading them without it is the read-then-write
  // that ceilings exist to avoid.
  await context.db.query('SELECT pg_advisory_xact_lock($1::integer, $2::integer)', [
    BUDGET_LOCK_NAMESPACE,
    hashOfWorkspace(context.scope.workspaceId),
  ]);

  const counted =
    input.attemptKind === 'first'
      ? await incrementDailyCounter(
          context,
          {
            subjectKind: 'workspace',
            subjectKey: context.scope.workspaceId,
            counterKind: RESEARCH_FIRM_RUN_COUNTER,
            businessTimeZone,
            at: input.at,
          },
          settings.dailyFirmCeiling,
        )
      : null;
  if (counted !== null && !counted.allowed) return refuse('daily_firm_ceiling');

  // Every reservation this firm holds for this business date, across every one of its
  // runs. Per run it was no bound at all: two same-day revisions were six rows.
  const held = await firmReservationsOnDate(context, { firmId: input.firmId, businessDate });
  if (held >= RESEARCH_FIRM_MAX_RESERVATIONS) return refuse('over_budget');

  const spend = await readSpend(context, { businessTimeZone, at: input.at });
  if (spend.todayCents + worstCaseCents > settings.dailyCostCeilingCents) return refuse('daily_cost_ceiling');
  if (spend.monthToDateCents + worstCaseCents > settings.monthlyCostCeilingCents) {
    return refuse('monthly_cost_ceiling');
  }
  // And the workspace's one cash ceiling across every paid kind (slice P1, invariant I2),
  // under its monthly lock — taken after the research budget lock, the order every
  // reservation keeps (own budget lock first, the monthly lock last). The caller inserts
  // the reservation in this transaction, so the lock covers it.
  if (!(await clearMonthlyCash(context, { at: input.at, zone: businessTimeZone, cents: worstCaseCents }))) {
    return refuse('monthly_cash_ceiling');
  }

  return accept({
    settings,
    businessTimeZone,
    businessDate: counted?.businessDate ?? businessDate,
    count: counted?.count ?? null,
    todayCents: spend.todayCents,
    monthToDateCents: spend.monthToDateCents,
    worstCaseCents,
    modelName: settings.modelName,
    maxInputTokens: worstCaseInputTokens(priced),
    maxOutputTokens: MAX_EXTRACTION_OUTPUT_TOKENS,
  });
}

/**
 * A stable 32-bit key for one workspace, for the advisory lock.
 *
 * `hashtextextended` would do it in SQL; this does it here so the key is the same number
 * whatever the database's collation, and so a test can compute it.
 */
function hashOfWorkspace(workspaceId: string): number {
  let hash = 0;
  for (const character of workspaceId) {
    hash = (Math.imul(hash, 31) + character.charCodeAt(0)) | 0;
  }
  return hash;
}

/**
 * How many reservation rows this firm holds for one business date, across all its runs.
 *
 * Every state counts, settled and released included: the bound is on paid *attempts* a
 * firm may cost in a day, and an attempt that has been settled is one that happened.
 */
async function firmReservationsOnDate(
  context: RepositoryContext,
  input: { readonly firmId: string; readonly businessDate: string },
): Promise<number> {
  const { rows } = await context.db.query<{ held: number }>(
    `SELECT count(*)::int AS held
       FROM provider_reservations p
       JOIN research_runs r
         ON r.workspace_id = p.workspace_id AND r.id = p.subject_id
      WHERE p.workspace_id = $1
        AND p.subject_kind = 'research_run'
        AND p.business_date = $3::date
        AND r.firm_id = $2`,
    [context.scope.workspaceId, input.firmId, input.businessDate],
  );
  return Number(rows[0]?.held ?? 0);
}

/**
 * Whether a clearance would be granted now, without consuming one.
 *
 * What `POST /research/firm/run` asks before it enqueues, so a day at its ceiling
 * answers `ceiling_reached` to a person's click instead of queueing a job that will
 * refuse in a minute's time. A job that is already queued still asks
 * `claimResearchClearance`, because the ceiling may be reached in between.
 */
export async function researchClearanceAvailable(
  context: RepositoryContext,
  input: { readonly at: string },
): Promise<ResearchResult<{ readonly remaining: number }>> {
  const settings = await readResearchSettings(context);
  if (!settings.enabled) return refuse('research_disabled');
  if (!isPricedModel(settings.modelName)) return refuse('model_unpriced');

  const businessTimeZone = await workspaceBusinessZone(context);
  const used = await readDailyCounter(context, {
    subjectKind: 'workspace',
    subjectKey: context.scope.workspaceId,
    counterKind: RESEARCH_FIRM_RUN_COUNTER,
    businessTimeZone,
    at: input.at,
  });
  const remaining = settings.dailyFirmCeiling - used;
  if (remaining <= 0) return refuse('daily_firm_ceiling');

  const worstCaseCents = worstCaseRunCents({
    modelName: settings.modelName,
    maxPagesPerFirm: settings.maxPagesPerFirm,
    maxPageBytes: settings.maxPageBytes,
  });
  const spend = await readSpend(context, { businessTimeZone, at: input.at });
  if (spend.todayCents + worstCaseCents > settings.dailyCostCeilingCents) return refuse('daily_cost_ceiling');
  if (spend.monthToDateCents + worstCaseCents > settings.monthlyCostCeilingCents) {
    return refuse('monthly_cost_ceiling');
  }
  if (spend.monthToDateCents + worstCaseCents > (await readMonthlyCashCeiling(context))) {
    return refuse('monthly_cash_ceiling');
  }
  return accept({ remaining });
}
