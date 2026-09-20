import type { RepositoryContext } from '../db/workspaceScope.ts';
import { decideAdminOnly } from '../crm/authorization.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
import { localDate } from '../src/rules/localClock.ts';
import {
  accept,
  numeric,
  refuse,
  type ResearchProviderKind,
  type ResearchProviderRow,
  type ResearchResult,
  type ResearchSettingsRow,
} from './types.ts';

/**
 * Research settings, approved providers and the provider ledger (specification 7.4,
 * 10.1, Appendix D).
 *
 * "Admins maintain ... research limits, route-eligibility thresholds" and "Provider
 * calls, costs, failures, and evidence retention are capped and audited." This file is
 * the first half of that sentence's machinery: what an admin may set, and where the
 * calls and the money are written down.
 *
 * Three things are deliberate.
 *
 * **Everything here is admin-only.** A salesperson cannot raise a ceiling or enable a
 * provider; section 5.2 gives limits to admins, and `decideAdminOnly` is asked rather
 * than the caller's word taken. A read is admin-only too, because a provider's
 * reviewed per-call price is commercial configuration rather than firm data.
 *
 * **The ledger never decides anything.** It records what happened. The decision — may
 * this call be made at all — is `ceilings.ts`, and it is made through G5's
 * increment-with-ceiling so that the check and the increment are one statement.
 *
 * **A failure is recorded with the call that produced it.** `recordProviderCall`
 * writes the attempt, its cost and, when it failed, its short code, in one statement.
 * The alternative — record the call, then record the failure — leaves a window in
 * which spend exists and the reason it was wasted does not.
 */

const SETTINGS_COLUMNS = `workspace_id, enabled, daily_page_ceiling, daily_firm_ceiling,
  daily_cost_ceiling_micros, max_pages_per_firm, max_page_bytes`;

const PROVIDER_COLUMNS = `provider_key, kind, display_name, enabled, cost_per_call_micros,
  daily_call_ceiling, terms_allow_retention, retention_days`;

export interface ResearchSettings {
  readonly enabled: boolean;
  readonly dailyPageCeiling: number;
  readonly dailyFirmCeiling: number;
  readonly dailyCostCeilingMicros: number;
  readonly maxPagesPerFirm: number;
  readonly maxPageBytes: number;
}

function toSettings(row: ResearchSettingsRow): ResearchSettings {
  return {
    enabled: row.enabled,
    dailyPageCeiling: row.daily_page_ceiling,
    dailyFirmCeiling: row.daily_firm_ceiling,
    dailyCostCeilingMicros: numeric(row.daily_cost_ceiling_micros) ?? 0,
    maxPagesPerFirm: row.max_pages_per_firm,
    maxPageBytes: row.max_page_bytes,
  };
}

/**
 * The workspace's research settings.
 *
 * Null when no row exists, which the migration's trigger makes impossible for a
 * workspace created after it — but a caller must still fail closed rather than
 * substitute a default, because a default ceiling is an unreviewed budget.
 */
export async function readResearchSettings(context: RepositoryContext): Promise<ResearchSettings | null> {
  const { rows } = await context.db.query<ResearchSettingsRow>(
    `SELECT ${SETTINGS_COLUMNS} FROM research_settings WHERE workspace_id = $1`,
    [context.scope.workspaceId],
  );
  const row = rows[0];
  return row === undefined ? null : toSettings(row);
}

export interface ResearchSettingsPatch {
  readonly enabled?: boolean | undefined;
  readonly dailyPageCeiling?: number | undefined;
  readonly dailyFirmCeiling?: number | undefined;
  readonly dailyCostCeilingMicros?: number | undefined;
  readonly maxPagesPerFirm?: number | undefined;
  readonly maxPageBytes?: number | undefined;
}

const SETTINGS_PATCH_COLUMNS: Readonly<Record<keyof ResearchSettingsPatch, string>> = Object.freeze({
  enabled: 'enabled',
  dailyPageCeiling: 'daily_page_ceiling',
  dailyFirmCeiling: 'daily_firm_ceiling',
  dailyCostCeilingMicros: 'daily_cost_ceiling_micros',
  maxPagesPerFirm: 'max_pages_per_firm',
  maxPageBytes: 'max_page_bytes',
});

/** Change the workspace's research limits. Admin-only, audited, bounds in the database. */
export async function updateResearchSettings(
  context: RepositoryContext,
  patch: ResearchSettingsPatch,
): Promise<ResearchResult<ResearchSettings>> {
  const admin = decideAdminOnly(context);
  if (!admin.permitted) return refuse(admin.reason === 'admin_only' ? 'admin_only' : 'not_assigned');

  const assignments: string[] = [];
  const values: unknown[] = [context.scope.workspaceId, actorOrNull(context)];
  for (const [field, column] of Object.entries(SETTINGS_PATCH_COLUMNS)) {
    const value = patch[field as keyof ResearchSettingsPatch];
    if (value === undefined) continue;
    values.push(value);
    assignments.push(`${column} = $${String(values.length)}`);
  }
  if (assignments.length === 0) {
    const current = await readResearchSettings(context);
    return current === null ? refuse('research_disabled') : accept(current);
  }

  const { rows } = await context.db.query<ResearchSettingsRow>(
    `UPDATE research_settings
        SET ${assignments.join(', ')}, updated_by_user_id = $2, updated_at = now()
      WHERE workspace_id = $1
      RETURNING ${SETTINGS_COLUMNS}`,
    values,
  );
  const updated = rows[0];
  if (updated === undefined) return refuse('invalid_input');

  await recordCrmAuditEvent(context, {
    action: 'research.settings_updated',
    subjectKind: 'research_settings',
    subjectId: context.scope.workspaceId,
    detail: { fields: Object.keys(patch).sort() },
  });
  return accept(toSettings(updated));
}

export interface ApprovedProvider {
  readonly providerKey: string;
  readonly kind: ResearchProviderKind;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly costPerCallMicros: number;
  readonly dailyCallCeiling: number;
  readonly termsAllowRetention: boolean;
  readonly retentionDays: number | null;
}

function toProvider(row: ResearchProviderRow): ApprovedProvider {
  return {
    providerKey: row.provider_key,
    kind: row.kind,
    displayName: row.display_name,
    enabled: row.enabled,
    costPerCallMicros: numeric(row.cost_per_call_micros) ?? 0,
    dailyCallCeiling: row.daily_call_ceiling,
    termsAllowRetention: row.terms_allow_retention,
    retentionDays: row.retention_days,
  };
}

export async function listProviders(context: RepositoryContext): Promise<readonly ApprovedProvider[]> {
  const { rows } = await context.db.query<ResearchProviderRow>(
    `SELECT ${PROVIDER_COLUMNS} FROM research_providers WHERE workspace_id = $1 ORDER BY kind, provider_key`,
    [context.scope.workspaceId],
  );
  return rows.map(toProvider);
}

export async function readProvider(
  context: RepositoryContext,
  providerKey: string,
): Promise<ApprovedProvider | null> {
  const { rows } = await context.db.query<ResearchProviderRow>(
    `SELECT ${PROVIDER_COLUMNS} FROM research_providers WHERE workspace_id = $1 AND provider_key = $2`,
    [context.scope.workspaceId, providerKey],
  );
  const row = rows[0];
  return row === undefined ? null : toProvider(row);
}

export interface ProviderPatch {
  readonly enabled?: boolean | undefined;
  readonly costPerCallMicros?: number | undefined;
  readonly dailyCallCeiling?: number | undefined;
  readonly termsAllowRetention?: boolean | undefined;
  readonly retentionDays?: number | null | undefined;
}

const PROVIDER_PATCH_COLUMNS: Readonly<Record<keyof ProviderPatch, string>> = Object.freeze({
  enabled: 'enabled',
  costPerCallMicros: 'cost_per_call_micros',
  dailyCallCeiling: 'daily_call_ceiling',
  termsAllowRetention: 'terms_allow_retention',
  retentionDays: 'retention_days',
});

/**
 * Enable, price or cap an approved provider. Admin-only and audited.
 *
 * A provider key that has no row is refused rather than created: "approved providers"
 * means the set is a reviewed list, and adding to it is a migration, not a PATCH.
 */
export async function updateProvider(
  context: RepositoryContext,
  input: { readonly providerKey: string; readonly patch: ProviderPatch },
): Promise<ResearchResult<ApprovedProvider>> {
  const admin = decideAdminOnly(context);
  if (!admin.permitted) return refuse(admin.reason === 'admin_only' ? 'admin_only' : 'not_assigned');
  const existing = await readProvider(context, input.providerKey);
  if (existing === null) return refuse('provider_unknown');

  const assignments: string[] = [];
  const values: unknown[] = [context.scope.workspaceId, input.providerKey, actorOrNull(context)];
  for (const [field, column] of Object.entries(PROVIDER_PATCH_COLUMNS)) {
    const value = input.patch[field as keyof ProviderPatch];
    if (value === undefined) continue;
    values.push(value);
    assignments.push(`${column} = $${String(values.length)}`);
  }
  if (assignments.length === 0) return accept(existing);

  const { rows } = await context.db.query<ResearchProviderRow>(
    `UPDATE research_providers
        SET ${assignments.join(', ')}, updated_by_user_id = $3, updated_at = now()
      WHERE workspace_id = $1 AND provider_key = $2
      RETURNING ${PROVIDER_COLUMNS}`,
    values,
  );
  const updated = rows[0];
  if (updated === undefined) return refuse('provider_unknown');

  await recordCrmAuditEvent(context, {
    action: 'research.provider_updated',
    subjectKind: 'research_provider',
    subjectId: input.providerKey,
    detail: { fields: Object.keys(input.patch).sort(), enabled: updated.enabled },
  });
  return accept(toProvider(updated));
}

/**
 * The retention expiry a provider's terms give a piece of evidence retrieved now, or
 * null when the terms permit keeping it with the firm (10.3).
 *
 * Migration 0004 refuses an evidence item whose terms forbid retention and which
 * carries no expiry, so this is the function that keeps that CHECK satisfiable.
 */
export function evidenceRetentionExpiry(provider: ApprovedProvider, retrievedAt: Date): Date | null {
  if (provider.retentionDays === null) return null;
  return new Date(retrievedAt.getTime() + provider.retentionDays * 24 * 60 * 60 * 1000);
}

export interface ProviderLedgerEntry {
  readonly providerKey: string;
  readonly businessDate: string;
  readonly calls: number;
  readonly failures: number;
  readonly costMicros: number;
  readonly lastFailureCode: string | null;
}

interface LedgerRow {
  readonly provider_key: string;
  readonly business_date: Date | string;
  readonly calls: number;
  readonly failures: number;
  readonly cost_micros: string;
  readonly last_failure_code: string | null;
  readonly [column: string]: unknown;
}

function toLedgerEntry(row: LedgerRow): ProviderLedgerEntry {
  const date = row.business_date;
  return {
    providerKey: row.provider_key,
    businessDate: typeof date === 'string' ? date : date.toISOString().slice(0, 10),
    calls: row.calls,
    failures: row.failures,
    costMicros: numeric(row.cost_micros) ?? 0,
    lastFailureCode: row.last_failure_code,
  };
}

export interface RecordProviderCallInput {
  readonly providerKey: string;
  readonly costMicros: number;
  /** Present when the call failed. A short lower-snake code, never a message. */
  readonly failureCode?: string | undefined;
  readonly businessTimeZone: string;
  readonly at: string;
}

/**
 * Record one provider call: its cost, and its failure when it failed.
 *
 * One statement, so spend and the reason for it are never separately visible. The
 * business date is derived here from the workspace zone, like `daily_counters`, and
 * stored beside the zone that produced it (Appendix D).
 */
export async function recordProviderCall(
  context: RepositoryContext,
  input: RecordProviderCallInput,
): Promise<ProviderLedgerEntry> {
  const businessDate = localDate(input.at, input.businessTimeZone);
  const failed = input.failureCode !== undefined;
  const { rows } = await context.db.query<LedgerRow>(
    `INSERT INTO research_provider_ledger
       (workspace_id, provider_key, business_date, business_time_zone, calls, failures, cost_micros,
        last_failure_code, last_failure_at, updated_at)
     VALUES ($1, $2, $3::date, $4, 1, CASE WHEN $5::boolean THEN 1 ELSE 0 END, $6::bigint,
             $7, CASE WHEN $5::boolean THEN now() ELSE NULL END, now())
     ON CONFLICT (workspace_id, provider_key, business_date) DO UPDATE
        SET calls = research_provider_ledger.calls + 1,
            failures = research_provider_ledger.failures + CASE WHEN $5::boolean THEN 1 ELSE 0 END,
            cost_micros = research_provider_ledger.cost_micros + $6::bigint,
            last_failure_code = COALESCE($7, research_provider_ledger.last_failure_code),
            last_failure_at = CASE WHEN $5::boolean THEN now() ELSE research_provider_ledger.last_failure_at END,
            updated_at = now()
     RETURNING provider_key, business_date, calls, failures, cost_micros, last_failure_code`,
    [
      context.scope.workspaceId,
      input.providerKey,
      businessDate,
      input.businessTimeZone,
      failed,
      Math.max(0, Math.trunc(input.costMicros)),
      input.failureCode ?? null,
    ],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('the provider ledger did not return the row it wrote');
  return toLedgerEntry(row);
}

/** Today's ledger for every provider, in the workspace's business zone. */
export async function readProviderLedger(
  context: RepositoryContext,
  input: { readonly businessTimeZone: string; readonly at: string },
): Promise<readonly ProviderLedgerEntry[]> {
  const businessDate = localDate(input.at, input.businessTimeZone);
  const { rows } = await context.db.query<LedgerRow>(
    `SELECT provider_key, business_date, calls, failures, cost_micros, last_failure_code
       FROM research_provider_ledger
      WHERE workspace_id = $1 AND business_date = $2::date
      ORDER BY provider_key`,
    [context.scope.workspaceId, businessDate],
  );
  return rows.map(toLedgerEntry);
}

/** What research has already spent today, across every provider. */
export async function readSpendMicros(
  context: RepositoryContext,
  input: { readonly businessTimeZone: string; readonly at: string },
): Promise<number> {
  const entries = await readProviderLedger(context, input);
  return entries.reduce((total, entry) => total + entry.costMicros, 0);
}

/** The workspace's configured business zone (Appendix D). */
export async function readBusinessTimeZone(context: RepositoryContext): Promise<string> {
  const { rows } = await context.db.query<{ business_time_zone: string }>(
    'SELECT business_time_zone FROM workspaces WHERE id = $1',
    [context.scope.workspaceId],
  );
  const zone = rows[0]?.business_time_zone;
  if (zone === undefined) throw new Error('the workspace has no business time zone');
  return zone;
}

function actorOrNull(context: RepositoryContext): string | null {
  return context.scope.actor.kind === 'user' ? context.scope.actor.userId : null;
}
