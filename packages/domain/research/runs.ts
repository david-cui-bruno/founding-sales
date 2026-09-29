import type { RepositoryContext } from '../db/workspaceScope.ts';
import { finaliseSubjectReservations } from './reservations.ts';
import type { ResearchOutcome, ResearchTrigger } from './types.ts';

/**
 * The life of one `research_runs` row.
 *
 * `UNIQUE (workspace, firm, revision)` is the `research.firm` handler's declared
 * `business_uniqueness`: a job claimed twice tries to open the row it already opened,
 * finds the insert refused, and reports `already_recorded` instead of fetching the
 * firm's site a second time. Nothing here needs a lock or a token for that, which is
 * the point of choosing the revision as the job's identity.
 *
 * ## `running` is a committed state, and a stale one is a lost lease
 *
 * The handler is chunked: chunk 1 commits the row and the money it reserved, chunk 2
 * makes the calls and closes it. So a row that says `running` is the ordinary state
 * between two commits, which is exactly why it cannot be read as a crash — and why
 * something else has to notice when it *is* one. `finaliseAbandonedRuns` is that
 * something: a row still `running` after `RUN_IN_PROGRESS_MINUTES` is finalised
 * `failed` with `refusal_code = 'lease_lost'`, and the sum of its reservations becomes
 * its recorded cost — `estimated` for any that reached `calling`, because nobody can
 * know whether the call was made, and `released` for any that never did.
 */

/** A run still `running` after this long is not in progress; it is a crashed worker. */
export const RUN_IN_PROGRESS_MINUTES = 30;

export interface RunRow {
  readonly id: string;
  readonly revision: number;
  readonly trigger: ResearchTrigger;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly outcome: ResearchOutcome;
  readonly refusalCode: string | null;
  readonly pagesFetched: number;
  readonly factsRecorded: number;
  readonly costCents: number;
  /** True when the cost is the run's reservation rather than a figure a provider gave. */
  readonly costEstimated: boolean;
  readonly extraction: RunExtraction;
  readonly brief: Readonly<Record<string, unknown>> | null;
}

interface RunDbRow {
  readonly id: string;
  readonly revision: number;
  readonly trigger: ResearchTrigger;
  readonly started_at: Date;
  readonly completed_at: Date | null;
  readonly outcome: ResearchOutcome;
  readonly refusal_code: string | null;
  readonly pages_fetched: number;
  readonly facts_recorded: number;
  readonly cost_cents: number;
  readonly cost_estimated: boolean;
  readonly extraction: RunExtraction;
  readonly brief: Readonly<Record<string, unknown>> | null;
  readonly [column: string]: unknown;
}

const RUN_COLUMNS = `id, revision, trigger, started_at, completed_at, outcome, refusal_code,
  pages_fetched, facts_recorded, cost_cents, cost_estimated, extraction, brief`;

const toRun = (row: RunDbRow): RunRow => ({
  id: row.id,
  revision: Number(row.revision),
  trigger: row.trigger,
  startedAt: row.started_at.toISOString(),
  completedAt: row.completed_at?.toISOString() ?? null,
  outcome: row.outcome,
  refusalCode: row.refusal_code,
  pagesFetched: Number(row.pages_fetched),
  factsRecorded: Number(row.facts_recorded),
  costCents: Number(row.cost_cents),
  costEstimated: row.cost_estimated,
  extraction: row.extraction,
  brief: row.brief,
});

/** The revision a new run for this firm should carry: one more than its highest. */
export async function nextRevision(context: RepositoryContext, firmId: string): Promise<number> {
  const { rows } = await context.db.query<{ revision: number | null }>(
    'SELECT max(revision) AS revision FROM research_runs WHERE workspace_id = $1 AND firm_id = $2',
    [context.scope.workspaceId, firmId],
  );
  return Number(rows[0]?.revision ?? 0) + 1;
}

/** True when a run for this firm is open and younger than `RUN_IN_PROGRESS_MINUTES`. */
export async function runInProgress(context: RepositoryContext, firmId: string): Promise<boolean> {
  const { rows } = await context.db.query<{ present: boolean }>(
    `SELECT true AS present FROM research_runs
      WHERE workspace_id = $1 AND firm_id = $2 AND outcome = 'running'
        AND started_at > now() - ($3 || ' minutes')::interval
      LIMIT 1`,
    [context.scope.workspaceId, firmId, String(RUN_IN_PROGRESS_MINUTES)],
  );
  return rows[0]?.present === true;
}

export interface OpenRunInput {
  readonly firmId: string;
  readonly revision: number;
  readonly trigger: ResearchTrigger;
  readonly requestedByUserId?: string | null | undefined;
  readonly at: string;
}

/**
 * Open the run, or null when this revision already has a row.
 *
 * Null is the replay: the job was claimed twice and the first claim already did the
 * work, so the caller reports `already_recorded` rather than doing it again. The
 * insert is the check — `ON CONFLICT DO NOTHING` on the unique key — so there is no
 * window between asking and writing.
 */
export async function openRun(context: RepositoryContext, input: OpenRunInput): Promise<string | null> {
  const { rows } = await context.db.query<{ id: string }>(
    `INSERT INTO research_runs (workspace_id, firm_id, revision, trigger, requested_by_user_id, started_at)
     VALUES ($1, $2, $3, $4, $5, $6::timestamptz)
     ON CONFLICT ON CONSTRAINT research_runs_one_per_revision DO NOTHING
     RETURNING id`,
    [
      context.scope.workspaceId,
      input.firmId,
      input.revision,
      input.trigger,
      input.requestedByUserId ?? null,
      input.at,
    ],
  );
  return rows[0]?.id ?? null;
}

/**
 * Why the model was or was not used. `research_runs_extraction_known` is the same set.
 *
 * `over_budget` is the exact token count refusing a request the reservation would not
 * cover, decided **before** the call — so it costs nothing and is not a failure. The
 * run keeps its evidence and judges from the firm's routes alone.
 */
export type RunExtraction = 'used' | 'unconfigured' | 'no_pages' | 'failed' | 'over_budget';

export interface CompleteRunInput {
  readonly runId: string;
  readonly at: string;
  readonly pagesFetched: number;
  readonly factsRecorded: number;
  readonly modelName?: string | null | undefined;
  /**
   * Why the model was or was not used.
   *
   * `model_name IS NULL` could not say, and the difference decides whether the sweep
   * ever comes back: `unconfigured` is a run worth repeating once a key exists, and
   * `no_pages` is a firm that will have no pages tomorrow either. Re-selecting the
   * second was an unbounded daily spend on a firm with nothing to read.
   */
  readonly extraction: RunExtraction;
  /** True when `costCents` is the run's reservation rather than a reported figure. */
  readonly costEstimated?: boolean | undefined;
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly costCents: number;
  /** The generated parts only: `{ questions, opening, generated: true }`, or null. */
  readonly brief?: Readonly<Record<string, unknown>> | null | undefined;
}

export async function completeRun(context: RepositoryContext, input: CompleteRunInput): Promise<void> {
  await context.db.query(
    `UPDATE research_runs
        SET outcome = 'completed', completed_at = $3::timestamptz, pages_fetched = $4, facts_recorded = $5,
            model_name = $6, input_tokens = $7, output_tokens = $8, cost_cents = $9, brief = $10::jsonb,
            extraction = $11, cost_estimated = $12
      WHERE workspace_id = $1 AND id = $2`,
    [
      context.scope.workspaceId,
      input.runId,
      input.at,
      Math.max(0, Math.trunc(input.pagesFetched)),
      Math.max(0, Math.trunc(input.factsRecorded)),
      input.modelName ?? null,
      Math.max(0, Math.trunc(input.inputTokens ?? 0)),
      Math.max(0, Math.trunc(input.outputTokens ?? 0)),
      Math.max(0, Math.trunc(input.costCents)),
      input.brief === null || input.brief === undefined ? null : JSON.stringify(input.brief),
      input.extraction,
      input.costEstimated === true,
    ],
  );
}

export interface CloseRunInput {
  readonly runId: string;
  readonly at: string;
  readonly refusalCode: string;
  readonly costCents?: number | undefined;
  /** True when `costCents` is the run's reservation rather than a reported figure. */
  readonly costEstimated?: boolean | undefined;
  /**
   * Why the model was or was not used, when the closing path knows.
   *
   * Absent leaves the column as it was, which for a row that never reached the model is
   * the `unconfigured` default. A run whose extraction *failed* says so, because
   * "nobody had configured a model" and "the model was asked and broke" are different
   * facts and only one of them is worth trying again for.
   */
  readonly extraction?: RunExtraction | undefined;
}

/** A run stopped by a rule: a ceiling, a suppression, a firm with no sources. */
export async function refuseRun(context: RepositoryContext, input: CloseRunInput): Promise<void> {
  await closeRun(context, input, 'refused');
}

/**
 * A run stopped by something that went wrong.
 *
 * Committed, never thrown — see `enrichment.ts`. The retry is the sweep's, as a new
 * revision with a new clearance, because a throw would roll back the accounting of a
 * call that was already paid for.
 */
export async function failRun(context: RepositoryContext, input: CloseRunInput): Promise<void> {
  await closeRun(context, input, 'failed');
}

async function closeRun(
  context: RepositoryContext,
  input: CloseRunInput,
  outcome: 'refused' | 'failed',
): Promise<void> {
  await context.db.query(
    `UPDATE research_runs
        SET outcome = $3, completed_at = $4::timestamptz, refusal_code = $5, cost_cents = $6,
            cost_estimated = $7, extraction = COALESCE($8, extraction)
      WHERE workspace_id = $1 AND id = $2`,
    [
      context.scope.workspaceId,
      input.runId,
      outcome,
      input.at,
      input.refusalCode,
      Math.max(0, Math.trunc(input.costCents ?? 0)),
      input.costEstimated === true,
      input.extraction ?? null,
    ],
  );
}

/**
 * Finalise every run abandoned mid-flight, and say how many.
 *
 * A chunked run commits `running` before it spends anything. A worker that loses its
 * lease between the two chunks — a pause past the deadline, a container replaced, a
 * database failover — leaves that row `running` for ever, and with it a reservation on
 * the ledger and a firm that `run_in_progress` will refuse a new revision for.
 *
 * So the sweep closes them: `failed`, `refusal_code = 'lease_lost'`, and the sum of the
 * run's reservations written into `cost_cents` — which the previous shape could not do
 * at all, because a per-run amount did not exist anywhere. A reservation that reached
 * `calling` is `estimated`: the honest answer to "did the model call happen?" is that
 * nobody knows, and the last thing that worker did before disappearing may well have
 * been to make it. One still `reserved` is `released`, because no call could have
 * happened.
 *
 * `RUN_IN_PROGRESS_MINUTES` is the same window `run_in_progress` uses, so a firm becomes
 * researchable again in the same breath as its abandoned run is closed.
 */
export async function finaliseAbandonedRuns(
  context: RepositoryContext,
  input: { readonly at: string },
): Promise<number> {
  const { rows } = await context.db.query<{ id: string }>(
    `SELECT id FROM research_runs
      WHERE workspace_id = $1
        AND outcome = 'running'
        AND started_at <= $2::timestamptz - ($3 || ' minutes')::interval
      ORDER BY started_at`,
    [context.scope.workspaceId, input.at, String(RUN_IN_PROGRESS_MINUTES)],
  );

  for (const row of rows) {
    // Every open reservation of the run is closed first, and *how* depends on whether
    // it had been marked `calling`: one that had is `estimated`, because the last thing
    // the vanished worker may have done was make the call; one still `reserved` is
    // `released`, because no call could have happened. The sum is what the run cost.
    const settled = await finaliseSubjectReservations(context, {
      subjectKind: 'research_run',
      subjectId: row.id,
      at: input.at,
    });
    await context.db.query(
      `UPDATE research_runs
          SET outcome = 'failed', completed_at = $2::timestamptz, refusal_code = 'lease_lost',
              cost_cents = $4, cost_estimated = $5
        WHERE workspace_id = $1 AND id = $3 AND outcome = 'running'`,
      [context.scope.workspaceId, input.at, row.id, settled.cents, settled.estimated],
    );
  }
  return rows.length;
}

/**
 * A run that never opened, recorded so a refusal is visible rather than silent.
 *
 * A refusal before `openRun` still deserves a row: "research is disabled" and
 * "research has never looked at this firm" are different facts, and the runs list on
 * the firm page is where a person finds out which.
 */
export async function recordRefusedRun(
  context: RepositoryContext,
  input: OpenRunInput & { readonly refusalCode: string },
): Promise<void> {
  await context.db.query(
    `INSERT INTO research_runs
       (workspace_id, firm_id, revision, trigger, requested_by_user_id, started_at, completed_at,
        outcome, refusal_code)
     VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $6::timestamptz, 'refused', $7)
     ON CONFLICT ON CONSTRAINT research_runs_one_per_revision DO NOTHING`,
    [
      context.scope.workspaceId,
      input.firmId,
      input.revision,
      input.trigger,
      input.requestedByUserId ?? null,
      input.at,
      input.refusalCode,
    ],
  );
}

/** One run by id, or null. What chunk 3 asks before it does anything at all. */
export async function readRunById(context: RepositoryContext, runId: string): Promise<RunRow | null> {
  const { rows } = await context.db.query<RunDbRow>(
    `SELECT ${RUN_COLUMNS} FROM research_runs WHERE workspace_id = $1 AND id = $2`,
    [context.scope.workspaceId, runId],
  );
  const row = rows[0];
  return row === undefined ? null : toRun(row);
}

/**
 * The run row of one revision, or null.
 *
 * How a handler with a missing or malformed cursor finds its own work again: the
 * revision is the job's identity, so this is the same question the cursor answers and
 * the durable one.
 */
export async function readRunForRevision(
  context: RepositoryContext,
  input: { readonly firmId: string; readonly revision: number },
): Promise<RunRow | null> {
  const { rows } = await context.db.query<RunDbRow>(
    `SELECT ${RUN_COLUMNS} FROM research_runs
      WHERE workspace_id = $1 AND firm_id = $2 AND revision = $3`,
    [context.scope.workspaceId, input.firmId, Math.trunc(input.revision)],
  );
  const row = rows[0];
  return row === undefined ? null : toRun(row);
}

/** The firm's most recent runs, newest first. The firm page shows five. */
export async function listRuns(
  context: RepositoryContext,
  firmId: string,
  limit = 5,
): Promise<readonly RunRow[]> {
  const { rows } = await context.db.query<RunDbRow>(
    `SELECT ${RUN_COLUMNS} FROM research_runs
      WHERE workspace_id = $1 AND firm_id = $2
      ORDER BY revision DESC
      LIMIT $3`,
    [context.scope.workspaceId, firmId, Math.trunc(limit)],
  );
  return rows.map(toRun);
}

/** The newest completed run, which is the one the brief's revision names. */
export async function readLatestCompletedRun(
  context: RepositoryContext,
  firmId: string,
): Promise<RunRow | null> {
  const { rows } = await context.db.query<RunDbRow>(
    `SELECT ${RUN_COLUMNS} FROM research_runs
      WHERE workspace_id = $1 AND firm_id = $2 AND outcome = 'completed'
      ORDER BY revision DESC
      LIMIT 1`,
    [context.scope.workspaceId, firmId],
  );
  const row = rows[0];
  return row === undefined ? null : toRun(row);
}
