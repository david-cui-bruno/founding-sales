import type { SessionQueryable } from '@fss/domain/db/queryable.ts';
import { repositoryContext, workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import type { JobChunk, JobHandler } from '@fss/domain/jobs/handlerRegistry.ts';
import { jobIdempotencyKey } from '@fss/domain/jobs/jobKinds.ts';
import type { JobSpecification } from '@fss/domain/jobs/jobStore.ts';
import { databaseNow } from '@fss/domain/policy/clock.ts';
import { enqueueFirmResearch } from '@fss/domain/research/enqueue.ts';
import { beginFirmResearch, finishFirmResearch } from '@fss/domain/research/enrichment.ts';
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
 * ## Two chunks, because the middle of a run spends money
 *
 * `research.firm` is chunked (`docs/greenfield/jobs.md`, "Chunked bulk work"), and the
 * boundary is where the money is:
 *
 *   * **chunk 1** — `beginFirmResearch`: the run row, the consumed unit of the day's
 *     count, and the worst case **reserved** on `provider_ledger`. No provider has been
 *     touched. The runner commits this together with the cursor
 *     `{ runId, reservedCents, step: 'reserved' }`;
 *   * **chunk 2** — `finishFirmResearch`: the fetch, the model call, the evidence, the
 *     facts, the judgment, the funnel facts, and the reservation turned into the actual
 *     figure. `done: true`.
 *
 * Before the split, both halves ran in the runner's single job transaction. A lease
 * reclaimed during the extraction — or any database error after the call — rolled back
 * the run row, the ledger row and the consumed counter while the money stayed spent at
 * the provider, and the next attempt spent it again against a budget that had never
 * heard of the first. Now a rollback of chunk 2 leaves chunk 1 committed: the second
 * claim resumes from the cursor, finds its run row and its reservation, and does not
 * consume a second unit.
 *
 * A worker that disappears between the chunks leaves a row `running` with a reservation
 * standing. `finaliseAbandonedRuns`, in the sweep, closes it `failed` with
 * `lease_lost` after `RUN_IN_PROGRESS_MINUTES` and keeps the reservation as the recorded
 * cost — nobody can know whether the call was made, and over-counting is the direction
 * in which nothing is lost.
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

/** The cursor chunk 1 leaves behind, as it comes back out of `payload.progress`. */
export interface ResearchProgress {
  readonly runId: string;
  readonly reservedCents: number;
  readonly step: 'reserved';
  /** `JobChunk.progress` is an open JSON record; this is what makes the shape one. */
  readonly [key: string]: unknown;
}

export function parseResearchProgress(progress: unknown): ResearchProgress | null {
  if (typeof progress !== 'object' || progress === null) return null;
  const row = progress as Record<string, unknown>;
  const runId = row['runId'];
  const reservedCents = row['reservedCents'];
  if (typeof runId !== 'string' || runId === '') return null;
  if (typeof reservedCents !== 'number' || !Number.isFinite(reservedCents) || reservedCents < 0) return null;
  if (row['step'] !== 'reserved') return null;
  return { runId, reservedCents, step: 'reserved' };
}

export function researchFirmJobHandler(options: ResearchWorkerOptions): JobHandler {
  return {
    kind: 'research.firm',
    protection: 'business_uniqueness',
    maxAttempts: options.maxAttempts ?? RESEARCH_FIRM_MAX_ATTEMPTS,
    // Thirty seconds of fetching plus one model call, with room to spare.
    leaseSeconds: options.leaseSeconds ?? 120,
    // Two chunks, and the boundary is where the money is: see the header.
    chunked: true,
    handle: async (input): Promise<void | JobChunk> => {
      const payload = parseResearchFirmPayload(input.job.payload);
      if (payload === null) {
        throw new ResearchHandlerError('a research.firm payload names a firm, a revision and a trigger');
      }
      const context = repositoryContext(input.scope, input.session);
      const at = await databaseNow(context);
      const carried = parseResearchProgress(input.job.payload['progress']);

      if (carried === null) {
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
          reservedCents: started.value.reservedCents,
          step: 'reserved',
        };
        return { progress, done: false };
      }

      // Chunk 2, from the cursor. Every outcome, including a failure, is recorded on the
      // run row inside this transaction; nothing here throws on one.
      await finishFirmResearch(context, {
        runId: carried.runId,
        reservedCents: carried.reservedCents,
        firmId: payload.firmId,
        revision: payload.revision,
        at,
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
      // First, the runs a worker abandoned between their two chunks: closed `lease_lost`
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
