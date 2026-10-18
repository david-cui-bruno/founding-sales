import type { RepositoryContext } from '../db/workspaceScope.ts';
import { firmIsResearchable, type ResearchableFirm } from './firmState.ts';
import { listAttempts } from './reservations.ts';
import { refuseRun } from './runs.ts';
import { readResearchSettings } from './settings.ts';
import { refuse, type ResearchResult } from './types.ts';

/** Fresh settings and actual firm/owner/channel authority, never the job's requester. */
export async function researchEligibility(context: RepositoryContext, firmId: string): Promise<ResearchResult<ResearchableFirm>> {
  if (!(await readResearchSettings(context)).enabled) return refuse('research_disabled');
  return await firmIsResearchable(context, firmId);
}

/** Settled costs survive a hold, including earlier ambiguous attempts. */
export async function researchRunCost(context: RepositoryContext, runId: string): Promise<{ cents: number; estimated: boolean }> {
  const rows = await listAttempts(context, { subjectKind: 'research_run', subjectId: runId });
  return {
    cents: rows.reduce((total, row) => total + row.settledCents, 0),
    estimated: rows.some(row => row.state === 'estimated'),
  };
}

/**
 * Called at every provider boundary under the worker's dispatch gate and run lock.
 * A hold disables this action, not the stored research switch. Release only the
 * current caller's unused attempt and keep all already-incurred/estimated costs.
 */
export async function closeResearchIfPaused<T>(context: RepositoryContext, input: {
  readonly firmId: string;
  readonly runId: string;
  readonly at: string;
  readonly release: () => Promise<void>;
  readonly closedElsewhere: () => ResearchResult<T>;
}): Promise<ResearchResult<T> | null> {
  const eligibility = await researchEligibility(context, input.firmId);
  if (eligibility.ok) return null;
  await input.release();
  const cost = await researchRunCost(context, input.runId);
  const closed = await refuseRun(context, {
    runId: input.runId, at: input.at, refusalCode: eligibility.reason,
    costCents: cost.cents, costEstimated: cost.estimated,
  });
  return closed ? refuse(eligibility.reason) : input.closedElsewhere();
}
