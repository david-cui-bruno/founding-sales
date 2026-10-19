import type { RepositoryContext } from '../db/workspaceScope.ts';
import { enqueueJob } from '../jobs/jobStore.ts';
import { jobIdempotencyKey } from '../jobs/jobKinds.ts';
import { firmIsResearchable } from './firmState.ts';
import { nextRevision, runInProgress } from './runs.ts';
import { readResearchSettings } from './settings.ts';
import { accept, refuse, type ResearchResult, type ResearchTrigger } from './types.ts';
import type { ResearchPurpose, ResearchPurposeInput } from './officeAssessmentContract.ts';

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

export interface EnqueueResearchInput extends ResearchPurposeInput {
  readonly firmId: string;
  readonly trigger: ResearchTrigger;
  /** Required by `research_runs_requester_consistent` for `user_request` and `link_added`. */
  readonly requestedByUserId?: string | undefined;
}

export interface EnqueuedResearch {
  readonly purpose: ResearchPurpose;
  readonly revision: number;
  readonly jobId: string;
  /** False when the key already existed. That is the normal case, not an error. */
  readonly inserted: boolean;
}

export async function enqueueFirmResearch(
  context: RepositoryContext,
  input: EnqueueResearchInput,
): Promise<ResearchResult<EnqueuedResearch>> {
  const purpose = input.purpose ?? 'brief';
  if (purpose !== 'brief' && purpose !== 'office_evidence') return refuse('invalid_input');
  if (purpose === 'office_evidence' && (input.trigger !== 'user_request' || !input.requestedByUserId)) return refuse('invalid_input');
  await context.db.query('SELECT id FROM firms WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [context.scope.workspaceId, input.firmId]);
  const settings = await readResearchSettings(context);
  if (!settings.enabled) return refuse('research_disabled');

  const firm = await firmIsResearchable(context, input.firmId);
  if (!firm.ok) return firm;

  // A run already open and younger than half an hour: the work is in flight, and a
  // second revision would read the same pages twice for nothing.
  if (await runInProgress(context, input.firmId, purpose)) return refuse('run_in_progress');

  const pending = await context.db.query<{id:string;revision:number}>(`SELECT j.id,(j.payload->>'revision')::bigint AS revision
    FROM jobs j LEFT JOIN research_runs r ON r.workspace_id=j.workspace_id AND r.firm_id=$2
      AND j.idempotency_key='research-firm:'||r.firm_id::text||':'||r.revision::text
    WHERE j.workspace_id=$1 AND j.kind='research.firm' AND j.payload->>'firmId'=$2::text
      AND j.state IN ('queued','retryable','running') AND j.payload->>'revision' ~ '^[1-9][0-9]{0,9}$'
      AND j.idempotency_key='research-firm:'||$2::text||':'||(j.payload->>'revision')
      AND COALESCE(r.purpose,j.payload->>'purpose','brief')=$3 ORDER BY revision DESC LIMIT 1`,
    [context.scope.workspaceId,input.firmId,purpose]);
  if (pending.rows[0]) return accept({revision:Number(pending.rows[0].revision),jobId:pending.rows[0].id,inserted:false,purpose});

  const revision = await nextRevision(context, input.firmId);
  const outcome = await enqueueJob(context.db, {
    workspaceId: context.scope.workspaceId,
    kind: 'research.firm',
    idempotencyKey: jobIdempotencyKey.researchFirm(input.firmId, revision),
    payload: {
      firmId: input.firmId,
      revision,
      trigger: input.trigger,
      ...(purpose === 'brief' ? {} : { purpose }),
      ...(input.requestedByUserId === undefined ? {} : { requestedByUserId: input.requestedByUserId }),
    },
    maxAttempts: 3,
  });
  return accept({ revision, jobId: outcome.jobId, inserted: outcome.inserted, purpose });
}

const ENQUEUE_SAVEPOINT = 'research_enqueue';

/**
 * Enqueue a run for a firm whose caller must succeed whatever this does.
 *
 * `createFirm` and `mergeFirms` both want a firm looked at, and neither may fail
 * because of it. The refusal was already ignored — research being off is not a reason a
 * firm cannot be created — but an **exception** was not: a jobs table that refuses an
 * insert, a payload the store rejects, a bug in this file, and a firm somebody typed in
 * does not exist. The savepoint is the difference between "the run was not queued" and
 * "the firm was not created", and only the first of those is acceptable. The sweep
 * picks the firm up either way, which is what makes swallowing the error honest rather
 * than lossy.
 *
 * Inside a transaction — every command, through `runCommand` — this is a savepoint.
 * Outside one, which only a test calling the domain directly on an autocommit session
 * does, there is nothing to protect and nothing to undo: the enqueue is its own
 * statement. Both give the same answer, and the pattern is `dial/calls.ts`'s.
 */
export async function enqueueFirmResearchBestEffort(
  context: RepositoryContext,
  input: EnqueueResearchInput,
): Promise<void> {
  let nested = true;
  try {
    await context.db.query(`SAVEPOINT ${ENQUEUE_SAVEPOINT}`);
  } catch (error) {
    // 25P01 no_active_sql_transaction: not inside a transaction block.
    if ((error as { code?: string }).code !== '25P01') throw error;
    nested = false;
  }
  try {
    await enqueueFirmResearch(context, input);
    if (nested) await context.db.query(`RELEASE SAVEPOINT ${ENQUEUE_SAVEPOINT}`);
  } catch {
    if (!nested) return;
    // Everything the failed attempt wrote, undone — and nothing before it.
    await context.db.query(`ROLLBACK TO SAVEPOINT ${ENQUEUE_SAVEPOINT}`);
    await context.db.query(`RELEASE SAVEPOINT ${ENQUEUE_SAVEPOINT}`);
  }
}
