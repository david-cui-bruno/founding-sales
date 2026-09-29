import type { SessionQueryable } from '@fss/domain/db/queryable.ts';
import { repositoryContext, workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import type { JobHandler } from '@fss/domain/jobs/handlerRegistry.ts';
import { jobIdempotencyKey } from '@fss/domain/jobs/jobKinds.ts';
import type { JobSpecification } from '@fss/domain/jobs/jobStore.ts';
import { databaseNow } from '@fss/domain/policy/clock.ts';
import { enqueueFirmResearch } from '@fss/domain/research/enqueue.ts';
import { runFirmResearch } from '@fss/domain/research/enrichment.ts';
import type { ExtractionProvider, PageFetchProvider } from '@fss/domain/research/providers.ts';
import { readResearchSettings } from '@fss/domain/research/settings.ts';
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
 * ## The job always completes, even when the run failed
 *
 * This handler has no retry ladder for a provider failure, and that is deliberate.
 * The runner wraps the job in one transaction; the run's paid calls happen inside it.
 * Throwing would roll back the run row, the evidence, the ledger cents and the
 * consumed daily count while the money stayed spent — and then retry the same paid
 * calls against a budget with no record of the first attempt. So `runFirmResearch`
 * commits every outcome (see its "nothing throws" section), including a `failed` run,
 * and this handler treats a refusal the same way it treats a completion: the job is
 * done. A retry is the sweep's, as a new revision with a new clearance, which is a
 * retry the budget can see.
 *
 * `maxAttempts` is therefore about a poison payload and a stolen lease, not about
 * providers.
 *
 * ## Why `business_uniqueness`, and why it is not chunked
 *
 * The run's first write is the insert into `research_runs`, unique on
 * `(workspace, firm, revision)`. A second claim of the same job finds it refused and
 * returns `already_recorded` having fetched nothing. The runner commits the whole run
 * with the completion, so a stolen lease rolls back every row it wrote and the
 * reclaiming worker does the work once.
 *
 * Not chunked, deliberately. A chunk boundary inside a run would mean committing
 * some pages' evidence and not others under a cursor, and the ceiling was claimed for
 * one run: a resumed second half would either re-claim a unit or spend one it never
 * claimed. A firm's four pages fit inside a lease (`FIRM_TIMEOUT_MILLISECONDS` is
 * thirty seconds).
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

export function researchFirmJobHandler(options: ResearchWorkerOptions): JobHandler {
  return {
    kind: 'research.firm',
    protection: 'business_uniqueness',
    maxAttempts: options.maxAttempts ?? RESEARCH_FIRM_MAX_ATTEMPTS,
    // Thirty seconds of fetching plus one model call, with room to spare.
    leaseSeconds: options.leaseSeconds ?? 120,
    handle: async input => {
      const payload = parseResearchFirmPayload(input.job.payload);
      if (payload === null) {
        throw new ResearchHandlerError('a research.firm payload names a firm, a revision and a trigger');
      }
      const context = repositoryContext(input.scope, input.session);
      // Every outcome, including a failure, is recorded on the run row inside this
      // transaction. Nothing here throws on one: see the header.
      await runFirmResearch(context, {
        firmId: payload.firmId,
        revision: payload.revision,
        trigger: payload.trigger,
        ...(payload.requestedByUserId === undefined ? {} : { requestedByUserId: payload.requestedByUserId }),
        at: await databaseNow(context),
        pageFetch: options.pageFetch,
        ...(options.extraction === undefined ? {} : { extraction: options.extraction }),
      });
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
