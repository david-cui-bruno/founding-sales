import type { SessionQueryable } from '@fss/domain/db/queryable.ts';
import { repositoryContext, workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import type { JobChunk, JobHandler } from '@fss/domain/jobs/handlerRegistry.ts';
import { jobIdempotencyKey } from '@fss/domain/jobs/jobKinds.ts';
import type { JobSpecification } from '@fss/domain/jobs/jobStore.ts';
import { databaseNow } from '@fss/domain/policy/clock.ts';
import { enqueueFirmResearch } from '@fss/domain/research/enqueue.ts';
import {
  beginFirmResearch,
  ensureResearchCalling,
  finishFirmResearch,
  recoverResearchCursor,
  RESEARCH_FIRM_MAX_RESERVATIONS,
  type ResearchStep,
} from '@fss/domain/research/enrichment.ts';
import type { ExtractionProvider, PageFetchProvider } from '@fss/domain/research/providers.ts';
import { readResearchSettings } from '@fss/domain/research/settings.ts';
import { finaliseAbandonedRuns } from '@fss/domain/research/runs.ts';
import { selectFirmsForSweep } from '@fss/domain/research/sweep.ts';
import { RESEARCH_TRIGGERS, type ResearchTrigger } from '@fss/domain/research/types.ts';
import type { DueWorkSource } from '../scheduler/schedulerPass.ts';

/**
 * The two research jobs and the sweep that materializes one of them.
 *
 * The body is in `@fss/domain/research`, for the reason every other lane keeps its
 * handler body there: everything it touches is domain code, and the at-least-once
 * harness registers it without importing `apps/worker`. What this file owns is the
 * composition — which ports this deployment was given, and therefore whether it
 * claims the kind at all.
 *
 * ## A worker with no model key still researches
 *
 * And that is the difference from `classify.reply`, which registers nothing without
 * its key. A research run with no extraction port records the firm's pages as
 * evidence, sets three of the four judgments to `unknown`, derives reachability from
 * the firm's routes and its suppression, and completes. That is a smaller answer and
 * a useful one — the evidence is what a later run's facts will point at — so the
 * handler is registered whenever the page fetch is, which is always.
 *
 * ## Three chunks, because the middle of a run spends money
 *
 * `research.firm` is chunked (`docs/greenfield/jobs.md`, "Chunked bulk work"), and the
 * boundaries are where the money is:
 *
 *   * **chunk 1** — `beginFirmResearch`: the run row, the consumed unit of the day's
 *     count, and a `provider_reservations` row in state `reserved`. No provider has been
 *     touched;
 *   * **chunk 2** — `ensureResearchCalling`: that reservation moves to `calling`, and
 *     **nothing else is written**. This chunk exists only to make "a call may now have
 *     happened" durable, because a marker that shared a transaction with work could be
 *     rolled back by that work's failure — and then the call which followed it would
 *     have no record at all. A deployment with no extraction port marks nothing and
 *     releases the cents here instead: there is no call to be ambiguous about, and a
 *     `calling` row left behind by a worker that then vanished would be finalised at
 *     the full price of a call that could not have happened;
 *   * **chunk 3** — `finishFirmResearch`: the fetch, the exact token count, the model
 *     call, the evidence, the facts, the judgment, the funnel facts, and the reservation
 *     settled by id. `done: true`.
 *
 * With two chunks, a chunk-2 failure *after* the call was retried and made a second
 * paid call against the same reservation. Now the retry finds its own reservation still
 * `calling` under an **earlier job attempt**, settles it `estimated`, and opens a fresh
 * reservation for this attempt — so a second call is a second authorization, and
 * `maxAttempts` bounds the pair at three.
 *
 * A worker that disappears leaves a row `running` with reservations standing.
 * `finaliseAbandonedRuns`, in the sweep, closes it `failed` with `lease_lost` after
 * `RUN_IN_PROGRESS_MINUTES` and writes the sum of those reservations into `cost_cents` —
 * `estimated` for any that reached `calling`, `released` for any that did not.
 *
 * ## The job always completes, even when the run failed
 *
 * No retry ladder for a provider failure, deliberately: a retry has to be a new
 * revision with a new clearance, or it spends money the budget cannot see.
 * `finishFirmResearch` commits every outcome, including a `failed` run, and this
 * handler treats a refusal the same way it treats a completion — the job is done. The
 * sweep issues the retry, one a business day, three times at most.
 *
 * `maxAttempts` is therefore about a poison payload and a stolen lease, not about
 * providers.
 *
 * ## Why `business_uniqueness`
 *
 * The run's first write is the insert into `research_runs`, unique on
 * `(workspace, firm, revision)`. A second claim that has no cursor finds the insert
 * refused and returns `already_recorded` having fetched nothing; a second claim that
 * *has* a cursor is the ordinary resumption of chunk 2.
 */

const RESEARCH_FIRM_MAX_ATTEMPTS = 3;
const RESEARCH_SWEEP_MAX_ATTEMPTS = 2;

export interface ResearchWorkerOptions {
  /** Always present: the fetch needs no credential. */
  readonly pageFetch: PageFetchProvider;
  /** Absent when the deployment has no model key. The run is smaller, not failed. */
  readonly extraction?: ExtractionProvider | undefined;
  readonly maxAttempts?: number | undefined;
  readonly leaseSeconds?: number | undefined;
}

export class ResearchHandlerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResearchHandlerError';
  }
}

interface FirmPayload {
  readonly firmId: string;
  readonly revision: number;
  readonly trigger: ResearchTrigger;
  readonly requestedByUserId?: string | undefined;
}

export function parseResearchFirmPayload(payload: Readonly<Record<string, unknown>>): FirmPayload | null {
  const firmId = payload['firmId'];
  const revision = payload['revision'];
  const trigger = payload['trigger'];
  const requestedByUserId = payload['requestedByUserId'];
  if (typeof firmId !== 'string' || firmId === '') return null;
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1) return null;
  if (typeof trigger !== 'string' || !(RESEARCH_TRIGGERS as readonly string[]).includes(trigger)) return null;
  return {
    firmId,
    revision,
    trigger: trigger as ResearchTrigger,
    ...(typeof requestedByUserId === 'string' ? { requestedByUserId } : {}),
  };
}

export function researchHandlers(options: ResearchWorkerOptions | undefined): readonly JobHandler[] {
  if (options === undefined) return [];
  return [researchFirmJobHandler(options), researchSweepJobHandler(options)];
}

/**
 * The cursor, as it comes back out of `payload.progress`.
 *
 * `attempt` names the `provider_reservations` row this cursor is about, and `fencing`
 * is the fencing token of the claim that wrote it. The pair is what tells a reservation
 * *this* claim marked `calling` apart from one a previous claim marked and then died
 * holding — the job's own attempt counter cannot, because `requeueDeadJob` resets it.
 */
export interface ResearchProgress {
  readonly runId: string;
  readonly attempt: number;
  readonly step: ResearchStep;
  readonly fencing: string;
  /** `JobChunk.progress` is an open JSON record; this is what makes the shape one. */
  readonly [key: string]: unknown;
}

const STEPS: readonly ResearchStep[] = ['reserved', 'calling', 'uncalled'];

export function parseResearchProgress(progress: unknown): ResearchProgress | null {
  if (typeof progress !== 'object' || progress === null) return null;
  const row = progress as Record<string, unknown>;
  const runId = row['runId'];
  const attempt = row['attempt'];
  const step = row['step'];
  const fencing = row['fencing'];
  if (typeof runId !== 'string' || runId === '') return null;
  if (typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 1) return null;
  if (typeof step !== 'string' || !STEPS.includes(step as ResearchStep)) return null;
  if (typeof fencing !== 'string' || fencing === '') return null;
  return { runId, attempt, step: step as ResearchStep, fencing };
}

export function researchFirmJobHandler(options: ResearchWorkerOptions): JobHandler {
  const maxAttempts = options.maxAttempts ?? RESEARCH_FIRM_MAX_ATTEMPTS;
  return {
    kind: 'research.firm',
    protection: 'business_uniqueness',
    maxAttempts,
    // Thirty seconds of fetching plus one model call, with room to spare.
    leaseSeconds: options.leaseSeconds ?? 120,
    // Three chunks, and the boundaries are where the money is: see the header.
    chunked: true,
    handle: async (input): Promise<void | JobChunk> => {
      const payload = parseResearchFirmPayload(input.job.payload);
      if (payload === null) {
        throw new ResearchHandlerError('a research.firm payload names a firm, a revision and a trigger');
      }
      const context = repositoryContext(input.scope, input.session);
      const at = await databaseNow(context);
      const carried = parseResearchProgress(input.job.payload['progress']);

      // A missing or malformed cursor is recovered from the durable rows rather than
      // restarting: the run row of this revision is the same fact the cursor names, and
      // starting again would consume a second unit of the day's count for one firm.
      const runId =
        carried?.runId ?? (await recoverResearchCursor(context, { firmId: payload.firmId, revision: payload.revision }))?.runId;

      if (runId === undefined) {
        // Chunk 1. Nothing here touches a provider, and what it writes — the run row,
        // the consumed count, the reservation — is committed with the cursor below.
        const started = await beginFirmResearch(context, {
          firmId: payload.firmId,
          revision: payload.revision,
          trigger: payload.trigger,
          ...(payload.requestedByUserId === undefined ? {} : { requestedByUserId: payload.requestedByUserId }),
          at,
        });
        // A refusal and a replay are both finished jobs: the run row already says why,
        // and there is nothing for a second chunk to do.
        if (!started.ok || started.value.kind === 'done') return;
        const progress: ResearchProgress = {
          runId: started.value.runId,
          attempt: 1,
          step: 'reserved',
          fencing: input.job.fencingToken,
        };
        return { progress, done: false };
      }

      if (carried === null || carried.step === 'reserved' || carried.fencing !== input.job.fencingToken) {
        // Chunk 2: make "a call may now have happened" durable, and nothing else.
        //
        // The fencing token is the discriminator. A cursor written by *this* claim goes
        // straight on to chunk 3; a cursor written by any earlier claim means that claim
        // died somewhere after marking the reservation, so its call is ambiguous and
        // `ensureResearchCalling` settles it `estimated` before opening a fresh
        // reservation. Without the comparison the retry called a second time against the
        // first attempt's authorization — one reservation, two invoices.
        //
        // The job's own `attempt` cannot do this job: `requeueDeadJob` sets
        // `attempt_count` back to zero, so a requeued claim would carry the same number
        // as the claim that died. The fencing token is incremented by every claim.
        //
        // A chunk requeue (out of lease, cursor kept) is a new claim and therefore a new
        // token: it settles the open reservation and opens the next one, which is right,
        // because out of lease is exactly the case where nobody knows if the call landed.
        const permission = await ensureResearchCalling(context, {
          runId,
          at,
          maxReservations: RESEARCH_FIRM_MAX_RESERVATIONS,
          // A deployment with no key marks nothing: there is no call to be ambiguous
          // about, and a `calling` row left behind by a worker that then died would be
          // finalised at the full cost of a call that could not have happened.
          hasExtraction: options.extraction !== undefined,
        });
        if (permission.kind === 'closed') return;
        const progress: ResearchProgress = {
          runId,
          attempt: permission.attempt,
          step: permission.kind === 'calling' ? 'calling' : 'uncalled',
          fencing: input.job.fencingToken,
        };
        return { progress, done: false };
      }

      // Chunk 3, from the cursor. Every outcome, including a failure, is recorded on the
      // run row inside this transaction; nothing here throws on one, and a run that is
      // no longer `running` is left exactly as it is.
      await finishFirmResearch(context, {
        runId,
        firmId: payload.firmId,
        revision: payload.revision,
        at,
        attempt: carried.attempt,
        mayCall: carried.step === 'calling',
        pageFetch: options.pageFetch,
        ...(options.extraction === undefined ? {} : { extraction: options.extraction }),
      });
      return { progress: { ...carried }, done: true };
    },
  };
}

/** How many firms one sweep enqueues, before the ceilings pace the rest. */
export const RESEARCH_SWEEP_LIMIT = 200;

export function researchSweepJobHandler(options: ResearchWorkerOptions): JobHandler {
  return {
    kind: 'research.sweep',
    protection: 'business_uniqueness',
    maxAttempts: options.maxAttempts ?? RESEARCH_SWEEP_MAX_ATTEMPTS,
    leaseSeconds: options.leaseSeconds ?? 60,
    handle: async input => {
      const context = repositoryContext(input.scope, input.session);
      const settings = await readResearchSettings(context);
      if (!settings.enabled) return;
      const at = await databaseNow(context);
      // First, the runs a worker abandoned between two chunks: closed `lease_lost`
      // with their reservation kept as the cost. Before the select, because until a
      // run is closed `run_in_progress` refuses the firm a new revision.
      await finaliseAbandonedRuns(context, { at });
      // Whether this deployment can extract at all changes which firms are worth
      // re-reading: a run that completed with no model is a run with no facts, and it
      // should not hold the firm off for ninety days once a key exists.
      const extractionConfigured = options.extraction !== undefined;
      // Bounded by the day's own firm ceiling: a sweep that queued more than the day
      // can run would fill the queue with jobs that each refuse and complete, which
      // is the shape 13.1 asks a source to avoid.
      const limit = Math.min(settings.dailyFirmCeiling, RESEARCH_SWEEP_LIMIT);
      for (const candidate of await selectFirmsForSweep(context, { limit, at, extractionConfigured })) {
        // Every refusal is ignored: a firm suppressed since the select, or one whose
        // run opened in between, is a firm the next sweep will see again.
        await enqueueFirmResearch(context, { firmId: candidate.firmId, trigger: 'sweep' });
      }
    },
  };
}

/**
 * One sweep per workspace per business date.
 *
 * The same key rule as the Today build's, and for the same reason: the sweep's
 * identity is the day it is for, so a pass that runs every minute inserts one job a
 * day rather than one job a minute. It runs at the top of the local day rather than
 * at a chosen hour, because nobody is waiting on it.
 */
export function researchSweepSource(): DueWorkSource {
  return {
    name: 'research-sweep',
    find: async (session: SessionQueryable, now: string): Promise<readonly JobSpecification[]> => {
      const { rows } = await session.query<{ id: string; slug: string; business_date: string }>(
        `SELECT w.id, w.slug, (($1::timestamptz AT TIME ZONE w.business_time_zone))::date::text AS business_date
           FROM workspaces w
          ORDER BY w.id`,
        [now],
      );
      const specifications: JobSpecification[] = [];
      for (const row of rows) {
        // The scheduler pass holds one session and no scope, so the settings read is
        // scoped here rather than by the pass. A workspace with research off inserts
        // nothing at all, which keeps the backlog truthful about what is owed.
        const context = repositoryContext(workspaceScope(row.id, { kind: 'system', component: 'scheduler' }), session);
        const settings = await readResearchSettings(context);
        if (!settings.enabled) continue;
        specifications.push({
          workspaceId: row.id,
          kind: 'research.sweep',
          idempotencyKey: jobIdempotencyKey.researchSweep(row.slug, row.business_date),
          payload: { businessDate: row.business_date },
          maxAttempts: RESEARCH_SWEEP_MAX_ATTEMPTS,
        });
      }
      return specifications;
    },
  };
}
