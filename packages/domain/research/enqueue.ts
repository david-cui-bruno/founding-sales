import type { RepositoryContext } from '../db/workspaceScope.ts';
import { enqueueJob } from '../jobs/jobStore.ts';
import { jobIdempotencyKey } from '../jobs/jobKinds.ts';
import { firmIsResearchable } from './firmState.ts';
import { nextRevision, runInProgress } from './runs.ts';
import { readResearchSettings } from './settings.ts';
import { accept, refuse, type ResearchResult, type ResearchTrigger } from './types.ts';

/**
 * Materialize one `research.firm` job.
 *
 * The revision is decided here rather than in the handler, because it is the job's
 * identity: Appendix C's key is `research-firm:{firm}:{revision}`, the run row is
 * unique on `(workspace, firm, revision)`, and the two together are what make the
 * handler's declared `business_uniqueness` true. A second request for the same firm
 * is a new revision and a new job; a replayed job for the revision it was
 * materialized with finds the row it already wrote.
 *
 * Every refusal here is also asked again by the handler, because a ceiling can be
 * reached, a firm suppressed and a merge committed between materialization and the
 * claim. This is the cheap early answer, not the authority.
 */

export interface EnqueueResearchInput {
  readonly firmId: string;
  readonly trigger: ResearchTrigger;
  /** Required by `research_runs_requester_consistent` for `user_request` and `link_added`. */
  readonly requestedByUserId?: string | undefined;
}

export interface EnqueuedResearch {
  readonly revision: number;
  readonly jobId: string;
  /** False when the key already existed. That is the normal case, not an error. */
  readonly inserted: boolean;
}

export async function enqueueFirmResearch(
  context: RepositoryContext,
  input: EnqueueResearchInput,
): Promise<ResearchResult<EnqueuedResearch>> {
  const settings = await readResearchSettings(context);
  if (!settings.enabled) return refuse('research_disabled');

  const firm = await firmIsResearchable(context, input.firmId);
  if (!firm.ok) return firm;

  // A run already open and younger than half an hour: the work is in flight, and a
  // second revision would read the same pages twice for nothing.
  if (await runInProgress(context, input.firmId)) return refuse('run_in_progress');

  const revision = await nextRevision(context, input.firmId);
  const outcome = await enqueueJob(context.db, {
    workspaceId: context.scope.workspaceId,
    kind: 'research.firm',
    idempotencyKey: jobIdempotencyKey.researchFirm(input.firmId, revision),
    payload: {
      firmId: input.firmId,
      revision,
      trigger: input.trigger,
      ...(input.requestedByUserId === undefined ? {} : { requestedByUserId: input.requestedByUserId }),
    },
    maxAttempts: 3,
  });
  return accept({ revision, jobId: outcome.jobId, inserted: outcome.inserted });
}
