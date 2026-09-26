import { decideAdminOnly } from '../crm/authorization.ts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
import {
  DEFAULT_CLASSIFIER_SETTINGS,
  acceptClassification,
  isClassifierEffort,
  isClassifierModel,
  refuseClassification,
  type ClassificationResult,
  type ClassifierSettings,
} from './types.ts';
import type { ClassifierEffort, ClassifierModel } from '@fss/contracts';

/**
 * Which model, at which effort, and whether the classifier runs at all
 * (specification 10.1, 12.4).
 *
 * The model id is configuration, never a literal at a call site, because the choice
 * between Claude Opus 5 and Claude Haiku 4.5 is David's and is made at launch. A
 * workspace with no row gets `DEFAULT_CLASSIFIER_SETTINGS`, which is Opus 5 at
 * `effort: "low"` — the recommendation in the brief, for the reason the
 * specification's priority 3 gives: a missed human reply is the expensive error.
 *
 * Writing is admin-only (10.1). Reading is not, because the reply card names the
 * model that produced its suggestion and a salesperson looking at a card is entitled
 * to know which one it was.
 */

interface SettingsRow {
  readonly enabled: boolean;
  readonly model_name: string;
  readonly effort: string;
  readonly max_output_tokens: number;
  readonly daily_call_cap: number;
  readonly updated_by_user_id: string | null;
  readonly updated_at: Date;
  readonly [column: string]: unknown;
}

function toSettings(row: SettingsRow): ClassifierSettings {
  // The database already refuses an unknown model or effort; the narrowing here is
  // for the type, and falling back to the default rather than throwing means a row
  // written by a future migration cannot take the reply card down.
  return {
    enabled: row.enabled,
    modelName: isClassifierModel(row.model_name) ? row.model_name : DEFAULT_CLASSIFIER_SETTINGS.modelName,
    effort: isClassifierEffort(row.effort) ? row.effort : DEFAULT_CLASSIFIER_SETTINGS.effort,
    maxOutputTokens: row.max_output_tokens,
    dailyCallCap: row.daily_call_cap,
    updatedByUserId: row.updated_by_user_id,
    updatedAt: row.updated_at.toISOString(),
  };
}

const COLUMNS =
  'enabled, model_name, effort, max_output_tokens, daily_call_cap, updated_by_user_id, updated_at';

export async function readClassifierSettings(context: RepositoryContext): Promise<ClassifierSettings> {
  const { rows } = await context.db.query<SettingsRow>(
    `SELECT ${COLUMNS} FROM classifier_settings WHERE workspace_id = $1`,
    [context.scope.workspaceId],
  );
  const row = rows[0];
  return row === undefined ? DEFAULT_CLASSIFIER_SETTINGS : toSettings(row);
}

/**
 * Read for a worker running a job. Identical to the above except that it takes the
 * session rather than a scoped context, because the scheduler source has no actor.
 */
export interface UpdateClassifierSettingsInput {
  readonly enabled?: boolean | undefined;
  readonly modelName?: ClassifierModel | undefined;
  readonly effort?: ClassifierEffort | undefined;
  readonly maxOutputTokens?: number | undefined;
  readonly dailyCallCap?: number | undefined;
}

export async function updateClassifierSettings(
  context: RepositoryContext,
  input: UpdateClassifierSettingsInput,
): Promise<ClassificationResult<ClassifierSettings>> {
  const decision = decideAdminOnly(context);
  if (!decision.permitted) return refuseClassification('admin_only');

  const actor = context.scope.actor;
  const current = await readClassifierSettings(context);
  const next: ClassifierSettings = {
    enabled: input.enabled ?? current.enabled,
    modelName: input.modelName ?? current.modelName,
    effort: input.effort ?? current.effort,
    maxOutputTokens: input.maxOutputTokens ?? current.maxOutputTokens,
    dailyCallCap: input.dailyCallCap ?? current.dailyCallCap,
    updatedByUserId: actor.kind === 'user' ? actor.userId : null,
    updatedAt: null,
  };
  if (!Number.isInteger(next.maxOutputTokens) || next.maxOutputTokens < 64 || next.maxOutputTokens > 4096) {
    return refuseClassification('invalid_input');
  }
  if (!Number.isInteger(next.dailyCallCap) || next.dailyCallCap < 0 || next.dailyCallCap > 100_000) {
    return refuseClassification('invalid_input');
  }

  const { rows } = await context.db.query<SettingsRow>(
    `INSERT INTO classifier_settings (workspace_id, enabled, model_name, effort, max_output_tokens,
                                      daily_call_cap, updated_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (workspace_id) DO UPDATE
        SET enabled = EXCLUDED.enabled,
            model_name = EXCLUDED.model_name,
            effort = EXCLUDED.effort,
            max_output_tokens = EXCLUDED.max_output_tokens,
            daily_call_cap = EXCLUDED.daily_call_cap,
            updated_by_user_id = EXCLUDED.updated_by_user_id,
            updated_at = now()
     RETURNING ${COLUMNS}`,
    [
      context.scope.workspaceId,
      next.enabled,
      next.modelName,
      next.effort,
      next.maxOutputTokens,
      next.dailyCallCap,
      next.updatedByUserId,
    ],
  );
  const row = rows[0];
  if (row === undefined) return refuseClassification('invalid_input');

  // 10.1's configuration is versioned by its audit trail here: the row is the
  // current value and the events are how it got there. A model change is the one an
  // operator will want to correlate a cost step-change with.
  await recordCrmAuditEvent(context, {
    action: 'classifier.configured',
    subjectKind: 'workspace',
    subjectId: context.scope.workspaceId,
    detail: {
      enabled: next.enabled,
      model: next.modelName,
      effort: next.effort,
      previousModel: current.modelName,
      previousEffort: current.effort,
    },
  });
  return acceptClassification(toSettings(row));
}
