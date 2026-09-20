import type { RepositoryContext } from '../db/workspaceScope.ts';
import { incrementDailyCounter, readDailyCounter } from '../jobs/counters.ts';
import {
  readBusinessTimeZone,
  readProvider,
  readResearchSettings,
  readSpendMicros,
  type ApprovedProvider,
  type ResearchSettings,
} from './configuration.ts';
import { refuse, type ResearchRefusalCode, type ResearchResult } from './types.ts';

/**
 * The research caps (specification 7.4: "Provider calls, costs, failures, and
 * evidence retention are capped and audited"; Appendix D: "Sending and research caps:
 * workspace business date"; deliverable 3).
 *
 * Nothing in this package calls a provider without a clearance from here, and a
 * clearance is *consumed*: `claimResearchClearance` increments the counter as part of
 * deciding, through G5's `incrementDailyCounter`, whose whole design note is the
 * reason — "a read of 'are we under the cap?' followed by a write is the classic way
 * to send the fifty-first message of a fifty-message day".
 *
 * The order of the checks is the order of how much they cost to be wrong about:
 *
 *   1. research disabled for the workspace — nothing may run at all;
 *   2. the provider is not approved, or is disabled — its terms or price changed;
 *   3. the provider's own daily call ceiling;
 *   4. the workspace's daily count ceiling for this kind of work;
 *   5. the workspace's daily cost ceiling.
 *
 * The cost ceiling is last and is checked *before* the call using the provider's
 * reviewed per-call price, so the spend that would take the workspace over the line is
 * never made. It is a reviewed worst case rather than the actual invoice, which is the
 * same conservative shape the old build used: a provider that reports a lower cost
 * afterwards frees budget for the next call, and one that reports a higher cost cannot
 * have been authorized in the first place.
 *
 * ## Why the counter is separate from the ledger
 *
 * The counter answers "how many more may I start today", in one atomic statement, and
 * `research_provider_ledger` answers "what happened and what did it cost". Making one
 * table do both would mean either a ceiling that is not atomic or an accounting row
 * that has to be updated in the same statement as a cap decision — and the cap has to
 * be decided before the call while the cost is only known after it.
 */

/** The `daily_counters.counter_kind` values research owns. Lower snake, as the CHECK requires. */
export const RESEARCH_COUNTER_KINDS = Object.freeze({
  /** One per discovery page attempted. */
  discoveryPages: 'research_discovery_pages',
  /** One per firm enrichment attempted. */
  firmEnrichments: 'research_firm_enrichments',
});

export type ResearchWorkKind = 'discovery_page' | 'firm_enrichment';

function counterKindFor(work: ResearchWorkKind): string {
  return work === 'discovery_page'
    ? RESEARCH_COUNTER_KINDS.discoveryPages
    : RESEARCH_COUNTER_KINDS.firmEnrichments;
}

export interface ResearchClearance {
  readonly work: ResearchWorkKind;
  readonly provider: ApprovedProvider;
  readonly settings: ResearchSettings;
  readonly businessTimeZone: string;
  readonly businessDate: string;
  /** The counter after this clearance was taken. */
  readonly count: number;
  /** What the workspace had already spent today when the clearance was granted. */
  readonly spentMicros: number;
}

export interface ClaimClearanceInput {
  readonly work: ResearchWorkKind;
  readonly providerKey: string;
  /** Database time, supplied by the caller so one run dates every write identically. */
  readonly at: string;
}

/**
 * Take one unit of today's research budget, or say why not.
 *
 * Consuming: a granted clearance has already incremented the counter, so a caller that
 * abandons the work has still used the unit. That is deliberate. The alternative — a
 * reservation released on failure — is a distributed transaction with a provider, and
 * the failure mode of getting it wrong is calling a provider more times than the
 * ceiling allows. Losing a unit of a daily count is the cheaper error.
 */
export async function claimResearchClearance(
  context: RepositoryContext,
  input: ClaimClearanceInput,
): Promise<ResearchResult<ResearchClearance>> {
  const settings = await readResearchSettings(context);
  if (settings === null || !settings.enabled) return refuse('research_disabled');

  const provider = await readProvider(context, input.providerKey);
  if (provider === null) return refuse('provider_unknown');
  if (!provider.enabled) return refuse('provider_disabled');

  const businessTimeZone = await readBusinessTimeZone(context);
  const ceiling = input.work === 'discovery_page' ? settings.dailyPageCeiling : settings.dailyFirmCeiling;

  // The provider's own ceiling first: it is the tighter, more specific promise, and a
  // workspace unit spent on a provider that was already at its cap would be wasted.
  const providerCalls = await readDailyCounter(context, {
    subjectKind: 'workspace',
    subjectKey: `provider:${provider.providerKey}`,
    counterKind: counterKindFor(input.work),
    businessTimeZone,
    at: input.at,
  });
  if (provider.dailyCallCeiling <= providerCalls) return refuse('provider_ceiling_reached');

  const spentMicros = await readSpendMicros(context, { businessTimeZone, at: input.at });
  if (spentMicros + provider.costPerCallMicros > settings.dailyCostCeilingMicros) {
    return refuse('cost_ceiling_reached');
  }

  const workspaceOutcome = await incrementDailyCounter(
    context,
    {
      subjectKind: 'workspace',
      subjectKey: context.scope.workspaceId,
      counterKind: counterKindFor(input.work),
      businessTimeZone,
      at: input.at,
    },
    ceiling,
  );
  if (!workspaceOutcome.allowed) return refuse('daily_ceiling_reached');

  // The provider's counter is incremented after the workspace's, under its own ceiling,
  // so a provider cap and a workspace cap cannot both be exceeded by one call.
  const providerOutcome = await incrementDailyCounter(
    context,
    {
      subjectKind: 'workspace',
      subjectKey: `provider:${provider.providerKey}`,
      counterKind: counterKindFor(input.work),
      businessTimeZone,
      at: input.at,
    },
    provider.dailyCallCeiling,
  );
  if (!providerOutcome.allowed) return refuse('provider_ceiling_reached');

  return {
    ok: true,
    value: {
      work: input.work,
      provider,
      settings,
      businessTimeZone,
      businessDate: workspaceOutcome.businessDate,
      count: workspaceOutcome.count,
      spentMicros,
    },
  };
}

/**
 * Whether more work of this kind may be *enqueued* today, without consuming a unit.
 *
 * The acceptance criterion "the ceiling stops enqueues" is this function: a scheduler
 * or an admin command asks it before materializing a job, so a day at its ceiling
 * produces no queued work rather than a queue of jobs that will each refuse and
 * complete. A job that is already queued still asks `claimResearchClearance`, because
 * the ceiling may be reached between materialization and the claim.
 */
export async function researchEnqueueAllowed(
  context: RepositoryContext,
  input: { readonly work: ResearchWorkKind; readonly at: string },
): Promise<ResearchResult<{ readonly remaining: number }>> {
  const settings = await readResearchSettings(context);
  if (settings === null || !settings.enabled) return refuse('research_disabled');
  const businessTimeZone = await readBusinessTimeZone(context);
  const ceiling = input.work === 'discovery_page' ? settings.dailyPageCeiling : settings.dailyFirmCeiling;
  const used = await readDailyCounter(context, {
    subjectKind: 'workspace',
    subjectKey: context.scope.workspaceId,
    counterKind: counterKindFor(input.work),
    businessTimeZone,
    at: input.at,
  });
  const remaining = ceiling - used;
  if (remaining <= 0) return refuse('daily_ceiling_reached');

  const spentMicros = await readSpendMicros(context, { businessTimeZone, at: input.at });
  if (spentMicros >= settings.dailyCostCeilingMicros) return refuse('cost_ceiling_reached');
  return { ok: true, value: { remaining } };
}

/** The refusal codes a caller may see from this file. Useful to a route's documentation. */
export const CEILING_REFUSALS: readonly ResearchRefusalCode[] = Object.freeze([
  'research_disabled',
  'provider_unknown',
  'provider_disabled',
  'provider_ceiling_reached',
  'daily_ceiling_reached',
  'cost_ceiling_reached',
]);
