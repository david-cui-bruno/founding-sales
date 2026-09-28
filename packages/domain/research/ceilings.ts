import type { RepositoryContext } from '../db/workspaceScope.ts';
import { incrementDailyCounter, readDailyCounter } from '../jobs/counters.ts';
import { readSpend, workspaceBusinessZone } from './ledger.ts';
import { isPricedModel, worstCaseRunCents } from './pricing.ts';
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
 */

export interface ResearchClearance {
  readonly settings: ResearchSettings;
  readonly businessTimeZone: string;
  readonly businessDate: string;
  /** The count after this clearance was taken. */
  readonly count: number;
  /** What the workspace had already spent when the clearance was granted. */
  readonly todayCents: number;
  readonly monthToDateCents: number;
  /** The number both money checks were made against. Recorded on the run. */
  readonly worstCaseCents: number;
}

/** `daily_counters.counter_kind`, lower snake, as its CHECK requires. */
export const RESEARCH_FIRM_RUN_COUNTER = 'research_firm_runs';

/** Take one unit of today's research budget, or say why not. */
export async function claimResearchClearance(
  context: RepositoryContext,
  input: { readonly at: string },
): Promise<ResearchResult<ResearchClearance>> {
  const settings = await readResearchSettings(context);
  if (!settings.enabled) return refuse('research_disabled');
  if (!isPricedModel(settings.modelName)) return refuse('model_unpriced');

  const businessTimeZone = await workspaceBusinessZone(context);
  const worstCaseCents = worstCaseRunCents({
    modelName: settings.modelName,
    maxPagesPerFirm: settings.maxPagesPerFirm,
    maxPageBytes: settings.maxPageBytes,
  });

  const outcome = await incrementDailyCounter(
    context,
    {
      subjectKind: 'workspace',
      subjectKey: context.scope.workspaceId,
      counterKind: RESEARCH_FIRM_RUN_COUNTER,
      businessTimeZone,
      at: input.at,
    },
    settings.dailyFirmCeiling,
  );
  if (!outcome.allowed) return refuse('daily_firm_ceiling');

  const spend = await readSpend(context, { businessTimeZone, at: input.at });
  if (spend.todayCents + worstCaseCents > settings.dailyCostCeilingCents) return refuse('daily_cost_ceiling');
  if (spend.monthToDateCents + worstCaseCents > settings.monthlyCostCeilingCents) {
    return refuse('monthly_cost_ceiling');
  }

  return accept({
    settings,
    businessTimeZone,
    businessDate: outcome.businessDate,
    count: outcome.count,
    todayCents: spend.todayCents,
    monthToDateCents: spend.monthToDateCents,
    worstCaseCents,
  });
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
  return accept({ remaining });
}
