import type { RepositoryContext } from '../db/workspaceScope.ts';
import { decideAdminOnly } from './authorization.ts';
import { recordCrmAuditEvent } from './audit.ts';
import { listPipelineStages } from './pipeline.ts';
import { accept, refuse, type CrmResult, type PipelineStageRow } from './types.ts';

/**
 * Stage administration (specification 7.2, 8.1).
 *
 * "Admins may rename, reorder, add, or retire nonterminal stages. Won and Lost are
 * terminal."
 *
 * Every verb in that sentence is one function here, and the adjective governs all
 * four: none of them touches a terminal stage. An opportunity must always have
 * somewhere terminal to go, and `changeStage` finds Won and Lost by their
 * `terminal_kind`, so a workspace that renamed, reordered away or retired one of them
 * would have closed opportunities nobody can create. See
 * `docs/decisions/g9-terminal-stages-are-not-administrable.md`.
 *
 * Positions are contiguous from 1, terminal stages last, after every command. That is
 * an invariant rather than a convenience: `reopenOpportunity` takes "the first
 * non-terminal, unretired stage" by position, and a gap or a terminal stage in the
 * middle would make that mean something different than a person reading the board
 * expects.
 *
 * `pipeline_stages_position_unique` is `DEFERRABLE INITIALLY IMMEDIATE`, so a reorder
 * defers it for its transaction and writes the new positions in one statement instead
 * of shuffling through a temporary range that a concurrent reader could observe.
 */

const STAGE_COLUMNS = 'id, workspace_id, key, display_name, position, terminal_kind, retired, created_at, updated_at';

const STAGE_KEY = /^[a-z][a-z0-9_]{1,39}$/u;

async function readStage(context: RepositoryContext, key: string): Promise<PipelineStageRow | null> {
  const { rows } = await context.db.query<PipelineStageRow>(
    `SELECT ${STAGE_COLUMNS} FROM pipeline_stages WHERE workspace_id = $1 AND key = $2 FOR UPDATE`,
    [context.scope.workspaceId, key],
  );
  return rows[0] ?? null;
}

/**
 * Renumber every stage: nonterminal first in the given order, then the terminal ones
 * in the order they already had. One statement, under the deferred constraint.
 */
async function writePositions(context: RepositoryContext, orderedIds: readonly string[]): Promise<void> {
  if (orderedIds.length === 0) return;
  await context.db.query('SET CONSTRAINTS pipeline_stages_position_unique DEFERRED');
  await context.db.query(
    `UPDATE pipeline_stages AS s
        SET position = ordered.position, updated_at = now()
       FROM (SELECT id, ordinality::integer AS position
               FROM unnest($2::uuid[]) WITH ORDINALITY AS t(id, ordinality)) AS ordered
      WHERE s.workspace_id = $1 AND s.id = ordered.id`,
    [context.scope.workspaceId, [...orderedIds]],
  );
}

/** The current order with the terminal stages pushed to the end, as ids. */
function orderedIds(stages: readonly PipelineStageRow[], nonTerminalKeys: readonly string[]): readonly string[] {
  const byKey = new Map(stages.map(stage => [stage.key, stage]));
  const nonTerminal = nonTerminalKeys.map(key => byKey.get(key)?.id ?? '');
  const terminal = stages.filter(stage => stage.terminal_kind !== null).map(stage => stage.id);
  return [...nonTerminal, ...terminal];
}

export interface CreatePipelineStageInput {
  readonly key: string;
  readonly displayName: string;
  /** Where among the nonterminal stages it goes, 1-based. Last by default. */
  readonly position?: number | undefined;
  readonly commandId?: string | undefined;
}

/**
 * Add a nonterminal stage.
 *
 * There is no way to add a terminal one, and that is the point: the workspace has
 * exactly one Won and one Lost, `pipeline_stages_one_per_terminal_kind` enforces it,
 * and a command that could try would only ever produce a constraint violation.
 */
export async function createPipelineStage(
  context: RepositoryContext,
  input: CreatePipelineStageInput,
): Promise<CrmResult<PipelineStageRow>> {
  const permitted = decideAdminOnly(context);
  if (!permitted.permitted) return refuse(permitted.reason);
  const displayName = input.displayName.trim();
  if (!STAGE_KEY.test(input.key) || displayName.length === 0 || displayName.length > 80) {
    return refuse('invalid_input');
  }
  if (input.position !== undefined && (!Number.isInteger(input.position) || input.position < 1)) {
    return refuse('invalid_input');
  }

  const stages = await listPipelineStages(context);
  if (stages.some(stage => stage.key === input.key)) return refuse('stage_key_exists');

  const nonTerminal = stages.filter(stage => stage.terminal_kind === null);
  // Inserted at the end of the nonterminal run, so the terminal stages stay last,
  // then renumbered below. The temporary position is beyond every existing one.
  const temporary = stages.length + 1;
  const { rows } = await context.db.query<PipelineStageRow>(
    `INSERT INTO pipeline_stages (workspace_id, key, display_name, position)
     VALUES ($1, $2, $3, $4)
     RETURNING ${STAGE_COLUMNS}`,
    [context.scope.workspaceId, input.key, displayName, temporary],
  );
  const created = rows[0];
  if (created === undefined) return refuse('invalid_input');

  const keys = nonTerminal.map(stage => stage.key);
  const at = Math.min(input.position ?? keys.length + 1, keys.length + 1) - 1;
  keys.splice(at, 0, input.key);
  await writePositions(context, orderedIds([...stages, created], keys));

  await recordCrmAuditEvent(context, {
    action: 'pipeline.stage_created',
    subjectKind: 'pipeline_stage',
    subjectId: created.id,
    detail: { key: input.key, position: at + 1 },
  });
  const after = await readStage(context, input.key);
  return accept(after ?? created);
}

export interface RenamePipelineStageInput {
  readonly stageKey: string;
  readonly displayName: string;
  readonly commandId?: string | undefined;
}

/** Change the label a person reads. The key is the stable identifier and never moves. */
export async function renamePipelineStage(
  context: RepositoryContext,
  input: RenamePipelineStageInput,
): Promise<CrmResult<PipelineStageRow>> {
  const permitted = decideAdminOnly(context);
  if (!permitted.permitted) return refuse(permitted.reason);
  const displayName = input.displayName.trim();
  if (displayName.length === 0 || displayName.length > 80) return refuse('invalid_input');

  const stage = await readStage(context, input.stageKey);
  if (stage === null) return refuse('stage_unknown');
  if (stage.terminal_kind !== null) return refuse('stage_terminal');

  const { rows } = await context.db.query<PipelineStageRow>(
    `UPDATE pipeline_stages SET display_name = $3, updated_at = now()
      WHERE workspace_id = $1 AND id = $2
      RETURNING ${STAGE_COLUMNS}`,
    [context.scope.workspaceId, stage.id, displayName],
  );
  const updated = rows[0];
  if (updated === undefined) return refuse('stage_unknown');

  await recordCrmAuditEvent(context, {
    action: 'pipeline.stage_renamed',
    subjectKind: 'pipeline_stage',
    subjectId: stage.id,
    detail: { key: stage.key },
  });
  return accept(updated);
}

export interface ReorderPipelineStagesInput {
  /** Every nonterminal stage key, in the order they should appear. */
  readonly stageKeys: readonly string[];
  readonly commandId?: string | undefined;
}

/**
 * Reorder the nonterminal stages.
 *
 * The command names *every* one of them or is refused. A partial list would leave
 * "what happened to the ones you left out" to a convention, and the answer people
 * assume ("they stay where they were") is not expressible when the ones you did name
 * moved through their positions.
 */
export async function reorderPipelineStages(
  context: RepositoryContext,
  input: ReorderPipelineStagesInput,
): Promise<CrmResult<readonly PipelineStageRow[]>> {
  const permitted = decideAdminOnly(context);
  if (!permitted.permitted) return refuse(permitted.reason);

  const stages = await listPipelineStages(context);
  const nonTerminal = stages.filter(stage => stage.terminal_kind === null).map(stage => stage.key);
  const wanted = [...input.stageKeys];
  if (new Set(wanted).size !== wanted.length) return refuse('invalid_input');
  if (wanted.length !== nonTerminal.length) return refuse('invalid_input');
  if (!wanted.every(key => nonTerminal.includes(key))) return refuse('invalid_input');

  await writePositions(context, orderedIds(stages, wanted));
  await recordCrmAuditEvent(context, {
    action: 'pipeline.stages_reordered',
    subjectKind: 'pipeline_stage',
    subjectId: context.scope.workspaceId,
    detail: { order: wanted },
  });
  return accept(await listPipelineStages(context));
}

export interface RetirePipelineStageOutcome {
  readonly stage: PipelineStageRow;
  /**
   * How many open opportunities were sitting in it. Not a refusal — 7.2 says
   * "retired stages remain readable" and anticipates exactly this — but the number
   * the receipt carries so the admin knows what they have just done.
   */
  readonly openOpportunities: number;
}

/**
 * Retire a nonterminal stage.
 *
 * Retiring is not deleting. `changeStage` refuses a move *into* a retired stage and
 * `listPipelineStages` still returns it, so a historical opportunity that sits in one
 * still renders with a name.
 *
 * The last unretired nonterminal stage is refused, because `reopenOpportunity` starts
 * a reopened opportunity at the first of them, and a workspace with none would refuse
 * every reopen with `stage_unknown` — a refusal whose cause is three commands away
 * from its symptom.
 */
export async function retirePipelineStage(
  context: RepositoryContext,
  input: { readonly stageKey: string; readonly commandId?: string | undefined },
): Promise<CrmResult<RetirePipelineStageOutcome>> {
  const permitted = decideAdminOnly(context);
  if (!permitted.permitted) return refuse(permitted.reason);

  const stage = await readStage(context, input.stageKey);
  if (stage === null) return refuse('stage_unknown');
  if (stage.terminal_kind !== null) return refuse('stage_terminal');
  if (stage.retired) return refuse('stage_retired');

  const stages = await listPipelineStages(context);
  const active = stages.filter(entry => entry.terminal_kind === null && !entry.retired);
  if (active.length <= 1) return refuse('stage_last_active');

  const open = await context.db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM opportunities
      WHERE workspace_id = $1 AND stage_id = $2 AND status = 'open'`,
    [context.scope.workspaceId, stage.id],
  );

  const { rows } = await context.db.query<PipelineStageRow>(
    `UPDATE pipeline_stages SET retired = true, updated_at = now()
      WHERE workspace_id = $1 AND id = $2 AND retired = false
      RETURNING ${STAGE_COLUMNS}`,
    [context.scope.workspaceId, stage.id],
  );
  const retired = rows[0];
  if (retired === undefined) return refuse('stage_retired');

  const openOpportunities = Number(open.rows[0]?.count ?? '0');
  await recordCrmAuditEvent(context, {
    action: 'pipeline.stage_retired',
    subjectKind: 'pipeline_stage',
    subjectId: stage.id,
    detail: { key: stage.key, openOpportunities },
  });
  return accept({ stage: retired, openOpportunities });
}
