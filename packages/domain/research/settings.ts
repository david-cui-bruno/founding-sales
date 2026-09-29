import type { RepositoryContext } from '../db/workspaceScope.ts';
import { decideAdminOnly } from '../crm/authorization.ts';
import { isPricedModel } from './pricing.ts';
import { accept, refuse, type ResearchResult } from './types.ts';

/**
 * The research settings, with defaults for a workspace that has no row.
 *
 * An absent row is the defaults, not "off". Migration 0007's table seeded
 * `enabled = false` and the result was a feature nobody ever turned on; the ceilings
 * below are what makes an enabled default safe, and they are small on purpose — fifty
 * firms, fifty cents and ten dollars are numbers David can raise after watching a
 * week of them rather than numbers he has to guess at before seeing one.
 */

export const SETTINGS_COLUMNS = `enabled, daily_firm_ceiling, daily_cost_ceiling_cents,
  monthly_cost_ceiling_cents, max_pages_per_firm, max_page_bytes, model_name,
  updated_by_user_id, updated_at`;

export interface ResearchSettings {
  readonly enabled: boolean;
  readonly dailyFirmCeiling: number;
  readonly dailyCostCeilingCents: number;
  readonly monthlyCostCeilingCents: number;
  readonly maxPagesPerFirm: number;
  readonly maxPageBytes: number;
  readonly modelName: string;
  readonly updatedByUserId: string | null;
  readonly updatedAt: string | null;
}

/** The row a workspace that has never been configured behaves as. Mirrors 0023's defaults. */
export const DEFAULT_RESEARCH_SETTINGS: ResearchSettings = Object.freeze({
  enabled: true,
  dailyFirmCeiling: 50,
  dailyCostCeilingCents: 50,
  monthlyCostCeilingCents: 1000,
  maxPagesPerFirm: 4,
  maxPageBytes: 1_000_000,
  modelName: 'claude-haiku-4-5',
  updatedByUserId: null,
  updatedAt: null,
});

interface SettingsRow {
  readonly enabled: boolean;
  readonly daily_firm_ceiling: number;
  readonly daily_cost_ceiling_cents: number;
  readonly monthly_cost_ceiling_cents: number;
  readonly max_pages_per_firm: number;
  readonly max_page_bytes: number;
  readonly model_name: string;
  readonly updated_by_user_id: string | null;
  readonly updated_at: Date | null;
  readonly [column: string]: unknown;
}

const toSettings = (row: SettingsRow): ResearchSettings => ({
  enabled: row.enabled,
  dailyFirmCeiling: Number(row.daily_firm_ceiling),
  dailyCostCeilingCents: Number(row.daily_cost_ceiling_cents),
  monthlyCostCeilingCents: Number(row.monthly_cost_ceiling_cents),
  maxPagesPerFirm: Number(row.max_pages_per_firm),
  maxPageBytes: Number(row.max_page_bytes),
  modelName: row.model_name,
  updatedByUserId: row.updated_by_user_id,
  updatedAt: row.updated_at?.toISOString() ?? null,
});

export async function readResearchSettings(context: RepositoryContext): Promise<ResearchSettings> {
  const { rows } = await context.db.query<SettingsRow>(
    `SELECT ${SETTINGS_COLUMNS} FROM research_settings WHERE workspace_id = $1`,
    [context.scope.workspaceId],
  );
  const row = rows[0];
  return row === undefined ? DEFAULT_RESEARCH_SETTINGS : toSettings(row);
}

export interface ResearchSettingsPatch {
  readonly enabled?: boolean | undefined;
  readonly dailyFirmCeiling?: number | undefined;
  readonly dailyCostCeilingCents?: number | undefined;
  readonly monthlyCostCeilingCents?: number | undefined;
  readonly maxPagesPerFirm?: number | undefined;
  readonly maxPageBytes?: number | undefined;
  readonly modelName?: string | undefined;
}

const bounded = (value: number | undefined, low: number, high: number): boolean =>
  value === undefined || (Number.isInteger(value) && value >= low && value <= high);

/**
 * Update the settings. Admin only, and the row is created on first write.
 *
 * Every bound here is also a CHECK in 0023. Both, on purpose: the CHECK is what makes
 * the claim true of the database, and these are what make a bad value a refusal with
 * a name rather than a constraint violation a route has to translate.
 */
export async function updateResearchSettings(
  context: RepositoryContext,
  patch: ResearchSettingsPatch,
): Promise<ResearchResult<ResearchSettings>> {
  const decision = decideAdminOnly(context);
  if (!decision.permitted) return refuse(decision.reason === 'admin_only' ? 'admin_only' : 'invalid_input');

  if (
    !bounded(patch.dailyFirmCeiling, 0, 10_000) ||
    !bounded(patch.dailyCostCeilingCents, 0, 1_000_000) ||
    !bounded(patch.monthlyCostCeilingCents, 0, 10_000_000) ||
    !bounded(patch.maxPagesPerFirm, 1, 8) ||
    !bounded(patch.maxPageBytes, 1024, 1_000_000)
  ) {
    return refuse('invalid_input');
  }
  // A model with no reviewed price row cannot be cleared, so it cannot be selected.
  if (patch.modelName !== undefined && !isPricedModel(patch.modelName)) return refuse('model_unpriced');

  const actor = context.scope.actor;
  const editor = actor.kind === 'user' ? actor.userId : null;
  const current = await readResearchSettings(context);
  const next: ResearchSettings = {
    ...current,
    ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
    ...(patch.dailyFirmCeiling === undefined ? {} : { dailyFirmCeiling: patch.dailyFirmCeiling }),
    ...(patch.dailyCostCeilingCents === undefined ? {} : { dailyCostCeilingCents: patch.dailyCostCeilingCents }),
    ...(patch.monthlyCostCeilingCents === undefined ? {} : { monthlyCostCeilingCents: patch.monthlyCostCeilingCents }),
    ...(patch.maxPagesPerFirm === undefined ? {} : { maxPagesPerFirm: patch.maxPagesPerFirm }),
    ...(patch.maxPageBytes === undefined ? {} : { maxPageBytes: patch.maxPageBytes }),
    ...(patch.modelName === undefined ? {} : { modelName: patch.modelName }),
  };

  const { rows } = await context.db.query<SettingsRow>(
    `INSERT INTO research_settings
       (workspace_id, enabled, daily_firm_ceiling, daily_cost_ceiling_cents, monthly_cost_ceiling_cents,
        max_pages_per_firm, max_page_bytes, model_name, updated_by_user_id, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
     ON CONFLICT (workspace_id) DO UPDATE
        SET enabled = EXCLUDED.enabled,
            daily_firm_ceiling = EXCLUDED.daily_firm_ceiling,
            daily_cost_ceiling_cents = EXCLUDED.daily_cost_ceiling_cents,
            monthly_cost_ceiling_cents = EXCLUDED.monthly_cost_ceiling_cents,
            max_pages_per_firm = EXCLUDED.max_pages_per_firm,
            max_page_bytes = EXCLUDED.max_page_bytes,
            model_name = EXCLUDED.model_name,
            updated_by_user_id = EXCLUDED.updated_by_user_id,
            updated_at = now()
     RETURNING ${SETTINGS_COLUMNS}`,
    [
      context.scope.workspaceId,
      next.enabled,
      next.dailyFirmCeiling,
      next.dailyCostCeilingCents,
      next.monthlyCostCeilingCents,
      next.maxPagesPerFirm,
      next.maxPageBytes,
      next.modelName,
      editor,
    ],
  );
  const row = rows[0];
  return row === undefined ? refuse('invalid_input') : accept(toSettings(row));
}
