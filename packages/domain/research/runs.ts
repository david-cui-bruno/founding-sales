import type { RepositoryContext } from '../db/workspaceScope.ts';
import type { ResearchOutcome, ResearchTrigger } from './types.ts';

/**
 * The life of one `research_runs` row.
 *
 * `UNIQUE (workspace, firm, revision)` is the `research.firm` handler's declared
 * `business_uniqueness`: a job claimed twice tries to open the row it already opened,
 * finds the insert refused, and reports `already_recorded` instead of fetching the
 * firm's site a second time. Nothing here needs a lock or a token for that, which is
 * the point of choosing the revision as the job's identity.
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
  readonly brief: Readonly<Record<string, unknown>> | null;
  readonly [column: string]: unknown;
}

const RUN_COLUMNS = `id, revision, trigger, started_at, completed_at, outcome, refusal_code,
  pages_fetched, facts_recorded, cost_cents, brief`;

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

export interface CompleteRunInput {
  readonly runId: string;
  readonly at: string;
  readonly pagesFetched: number;
  readonly factsRecorded: number;
  readonly modelName?: string | null | undefined;
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
            model_name = $6, input_tokens = $7, output_tokens = $8, cost_cents = $9, brief = $10::jsonb
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
    ],
  );
}

/** A run stopped by a rule: a ceiling, a suppression, a firm with no sources. */
export async function refuseRun(
  context: RepositoryContext,
  input: { readonly runId: string; readonly at: string; readonly refusalCode: string; readonly costCents?: number | undefined },
): Promise<void> {
  await closeRun(context, input, 'refused');
}

/** A run stopped by something that went wrong. The job's ladder retries it. */
export async function failRun(
  context: RepositoryContext,
  input: { readonly runId: string; readonly at: string; readonly refusalCode: string; readonly costCents?: number | undefined },
): Promise<void> {
  await closeRun(context, input, 'failed');
}

async function closeRun(
  context: RepositoryContext,
  input: { readonly runId: string; readonly at: string; readonly refusalCode: string; readonly costCents?: number | undefined },
  outcome: 'refused' | 'failed',
): Promise<void> {
  await context.db.query(
    `UPDATE research_runs
        SET outcome = $3, completed_at = $4::timestamptz, refusal_code = $5, cost_cents = $6
      WHERE workspace_id = $1 AND id = $2`,
    [
      context.scope.workspaceId,
      input.runId,
      outcome,
      input.at,
      input.refusalCode,
      Math.max(0, Math.trunc(input.costCents ?? 0)),
    ],
  );
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
