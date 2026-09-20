import {
  DEFAULT_SETTING_VALUES,
  SETTING_KEYS,
  SETTING_VALUE_SCHEMAS,
  type SettingKey,
} from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { isAdminScope } from '../db/workspaceScope.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
import { isKnownTimeZone } from '../src/rules/localClock.ts';

/**
 * Versioned administrative configuration with a change history
 * (specification 10.1, 13.3, 16.2).
 *
 * Three rules, and they are the whole file.
 *
 * **A change is a new version, never an edit.** `updateSetting` inserts version
 * *n+1* and marks version *n* superseded, in one transaction. "Who lowered the
 * sending cap, when, from what, and why" is then a `SELECT`, and 13.3's "versioned
 * with the release" is a property of the data rather than of a changelog somebody
 * has to remember to write.
 *
 * **The key chooses the schema.** The command carries an opaque `value` and the
 * server picks the validator from `SETTING_VALUE_SCHEMAS`. A client cannot nominate
 * which validation applies to its own payload, which is the failure mode a
 * discriminated union of command shapes would have had.
 *
 * **Configuration never bypasses suppression, and it is admin-only.** The refusal is
 * made here, in the same transaction as the write, rather than at the route, so a
 * second caller cannot reach the mutation past a route-level guard.
 */

export const SETTINGS_REFUSAL_CODES = [
  'admin_only',
  'invalid_value',
  'unknown_time_zone',
  'setting_version_conflict',
] as const;
export type SettingsRefusalCode = (typeof SETTINGS_REFUSAL_CODES)[number];

export type SettingsResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: SettingsRefusalCode };

export interface SettingVersionRow {
  readonly settingKey: SettingKey;
  readonly version: number;
  readonly value: unknown;
  readonly changeNote: string | null;
  readonly changedByUserId: string | null;
  readonly changedAt: string;
  readonly supersededAt: string | null;
}

/** One slice as it stands. `version` is 0 when no admin has ever set it. */
export interface CurrentSetting {
  readonly settingKey: SettingKey;
  readonly value: unknown;
  readonly version: number;
  readonly changedAt: string | null;
  readonly changedByUserId: string | null;
  readonly changeNote: string | null;
}

interface SettingDbRow {
  readonly setting_key: SettingKey;
  readonly version: number;
  readonly value: unknown;
  readonly change_note: string | null;
  readonly changed_by_user_id: string | null;
  readonly changed_at: Date;
  readonly superseded_at: Date | null;
}

const COLUMNS = 'setting_key, version, value, change_note, changed_by_user_id, changed_at, superseded_at';

function toVersion(row: SettingDbRow): SettingVersionRow {
  return {
    settingKey: row.setting_key,
    version: row.version,
    value: row.value,
    changeNote: row.change_note,
    changedByUserId: row.changed_by_user_id,
    changedAt: row.changed_at.toISOString(),
    supersededAt: row.superseded_at === null ? null : row.superseded_at.toISOString(),
  };
}

/**
 * Every slice at its current version, defaults included.
 *
 * A key with no row is not absent from the answer: it is present with its default and
 * `version: 0`. A settings page that had to know which keys exist in order to render
 * them would drift from the key set every time one is added.
 */
export async function readCurrentSettings(context: RepositoryContext): Promise<readonly CurrentSetting[]> {
  const { rows } = await context.db.query<SettingDbRow>(
    `SELECT ${COLUMNS} FROM workspace_settings
      WHERE workspace_id = $1 AND superseded_at IS NULL`,
    [context.scope.workspaceId],
  );
  const byKey = new Map(rows.map(row => [row.setting_key, row]));
  return SETTING_KEYS.map(key => {
    const row = byKey.get(key);
    if (row === undefined) {
      return {
        settingKey: key,
        value: DEFAULT_SETTING_VALUES[key],
        version: 0,
        changedAt: null,
        changedByUserId: null,
        changeNote: null,
      };
    }
    return {
      settingKey: key,
      value: row.value,
      version: row.version,
      changedAt: row.changed_at.toISOString(),
      changedByUserId: row.changed_by_user_id,
      changeNote: row.change_note,
    };
  });
}

/** One slice, typed by its key's schema. Falls back to the default. */
export async function readSetting<K extends SettingKey>(
  context: RepositoryContext,
  key: K,
): Promise<{ readonly value: unknown; readonly version: number }> {
  const { rows } = await context.db.query<SettingDbRow>(
    `SELECT ${COLUMNS} FROM workspace_settings
      WHERE workspace_id = $1 AND setting_key = $2 AND superseded_at IS NULL`,
    [context.scope.workspaceId, key],
  );
  const row = rows[0];
  if (row === undefined) return { value: DEFAULT_SETTING_VALUES[key], version: 0 };
  return { value: row.value, version: row.version };
}

/** Every version of one key, newest first. 10.1's "reason history". */
export async function readSettingHistory(
  context: RepositoryContext,
  key: SettingKey,
  options: { readonly limit?: number } = {},
): Promise<readonly SettingVersionRow[]> {
  const { rows } = await context.db.query<SettingDbRow>(
    `SELECT ${COLUMNS} FROM workspace_settings
      WHERE workspace_id = $1 AND setting_key = $2
      ORDER BY version DESC
      LIMIT $3`,
    [context.scope.workspaceId, key, Math.trunc(options.limit ?? 50)],
  );
  return rows.map(toVersion);
}

export interface UpdateSettingInput {
  readonly settingKey: SettingKey;
  readonly value: unknown;
  readonly changeNote: string;
  readonly commandId?: string | undefined;
}

/**
 * Write the next version of one slice.
 *
 * The advisory lock is the reason two admins saving at the same instant queue rather
 * than collide. Without it both would read version *n*, both would try to write
 * *n+1*, and the loser would take a unique violation — which aborts the transaction
 * and therefore loses the command receipt with it (`docs/greenfield/crm.md`, rule 2:
 * a refusal is a value, never an exception). With it the loser reads *n+1* and writes
 * *n+2*, which is what a person who pressed save actually meant.
 *
 * The lock key is `(workspace, setting key)`, so the two admins only queue when they
 * are editing the same slice.
 */
export async function updateSetting(
  context: RepositoryContext,
  input: UpdateSettingInput,
): Promise<SettingsResult<{ readonly current: CurrentSetting; readonly previousVersion: number }>> {
  if (!isAdminScope(context.scope)) return { ok: false, reason: 'admin_only' };
  const actor = context.scope.actor;
  if (actor.kind !== 'user') return { ok: false, reason: 'admin_only' };

  const schema = SETTING_VALUE_SCHEMAS[input.settingKey];
  const parsed = schema.safeParse(input.value);
  if (!parsed.success) return { ok: false, reason: 'invalid_value' };
  const value: unknown = parsed.data;

  // A real IANA lookup reads a catalogue and cannot be a CHECK constraint
  // (docs/decisions/g0-database-conventions.md), so the zone is validated here,
  // against `Intl`, before anything is written.
  if (input.settingKey === 'business_time_zone') {
    const zone = (value as { readonly timeZone: string }).timeZone;
    if (!isKnownTimeZone(zone)) return { ok: false, reason: 'unknown_time_zone' };
  }

  await context.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `${context.scope.workspaceId}:${input.settingKey}`,
  ]);

  const currentRead = await context.db.query<SettingDbRow>(
    `SELECT ${COLUMNS} FROM workspace_settings
      WHERE workspace_id = $1 AND setting_key = $2 AND superseded_at IS NULL
      FOR UPDATE`,
    [context.scope.workspaceId, input.settingKey],
  );
  const previous = currentRead.rows[0];
  const previousVersion = previous?.version ?? 0;
  const nextVersion = previousVersion + 1;

  if (previous !== undefined) {
    const superseded = await context.db.query(
      `UPDATE workspace_settings
          SET superseded_at = now(), superseded_by_version = $4
        WHERE workspace_id = $1 AND setting_key = $2 AND version = $3 AND superseded_at IS NULL`,
      [context.scope.workspaceId, input.settingKey, previousVersion, nextVersion],
    );
    // Belt and braces: the advisory lock makes this unreachable, and a refusal is
    // still better than a second current row if it ever is reached.
    if ((superseded.rowCount ?? 0) !== 1) return { ok: false, reason: 'setting_version_conflict' };
  }

  const inserted = await context.db.query<SettingDbRow>(
    `INSERT INTO workspace_settings
       (workspace_id, setting_key, version, value, change_note, changed_by_user_id)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6)
     ON CONFLICT (workspace_id, setting_key, version) DO NOTHING
     RETURNING ${COLUMNS}`,
    [
      context.scope.workspaceId,
      input.settingKey,
      nextVersion,
      JSON.stringify(value),
      input.changeNote,
      actor.userId,
    ],
  );
  const row = inserted.rows[0];
  if (row === undefined) return { ok: false, reason: 'setting_version_conflict' };

  // Appendix D: the workspace business zone is a column every query reads. The
  // setting row is its history; the column is its value, and the two commit together
  // so there is no instant in which they disagree.
  if (input.settingKey === 'business_time_zone') {
    await context.db.query('UPDATE workspaces SET business_time_zone = $2, updated_at = now() WHERE id = $1', [
      context.scope.workspaceId,
      (value as { readonly timeZone: string }).timeZone,
    ]);
  }

  await recordCrmAuditEvent(context, {
    action: 'settings.updated',
    subjectKind: 'workspace_setting',
    subjectId: input.settingKey,
    detail: { version: nextVersion, previousVersion, changeNote: input.changeNote },
  });

  return {
    ok: true,
    value: {
      previousVersion,
      current: {
        settingKey: input.settingKey,
        value: row.value,
        version: row.version,
        changedAt: row.changed_at.toISOString(),
        changedByUserId: row.changed_by_user_id,
        changeNote: row.change_note,
      },
    },
  };
}
