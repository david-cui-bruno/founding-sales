import {
  DEFAULT_SETTING_VALUES,
  RELEASE_RECORD_BINDING_REFUSAL_CODES,
  SETTING_VALUE_SCHEMAS,
  SNAPSHOT_SETTING_KEYS,
  postalAddressSettingSchema,
  type ActiveSettingKey,
  type SendingEnabledSetting,
} from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { isAdminScope } from '../db/workspaceScope.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
import { bindReleaseAttestation } from '../release/records.ts';
import { isKnownTimeZone } from '../src/rules/localClock.ts';

/**
 * Versioned administrative configuration with a change history
 * (specification 10.1, 16.2).
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
 *
 * **Enabling production sending names a release record that binds to this API**
 * (16.2, lane g71). `sending_enabled` with `enabled: true` is refused unless its
 * `releaseGateReference` is a stored `release_records` row whose suite is `pass` and
 * whose API digest is the digest of the API image making the write — the caller
 * passes that digest in as `runningApiDigest`. The four refusals are the release
 * record's binding refusals, and they are made here for the same reason as the
 * others: a check at the route would be a check a second caller could walk past.
 * `enabled: false` is always accepted, because turning sending off must never need a
 * rehearsal. Since lane g100 the reference may be the release process, `ci-gate:main`:
 * the enable then needs a stored, passing `ci-gate` record naming this API's digest.
 */

export const SETTINGS_REFUSAL_CODES = [
  'admin_only',
  'invalid_value',
  'unknown_time_zone',
  'setting_version_conflict',
  ...RELEASE_RECORD_BINDING_REFUSAL_CODES,
] as const;
export type SettingsRefusalCode = (typeof SETTINGS_REFUSAL_CODES)[number];

export type SettingsResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: SettingsRefusalCode };

export interface SettingVersionRow {
  readonly settingKey: ActiveSettingKey;
  readonly version: number;
  readonly value: unknown;
  readonly changeNote: string | null;
  readonly changedByUserId: string | null;
  readonly changedAt: string;
  readonly supersededAt: string | null;
}

/** One slice as it stands. `version` is 0 when no admin has ever set it. */
export interface CurrentSetting {
  readonly settingKey: ActiveSettingKey;
  readonly value: unknown;
  readonly version: number;
  readonly changedAt: string | null;
  readonly changedByUserId: string | null;
  readonly changeNote: string | null;
}

interface SettingDbRow {
  readonly setting_key: ActiveSettingKey;
  readonly version: number;
  readonly value: unknown;
  readonly change_note: string | null;
  readonly changed_by_user_id: string | null;
  readonly changed_at: Date;
  readonly superseded_at: Date | null;
  readonly [column: string]: unknown;
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
 *
 * `postal_address` is not listed yet (`SNAPSHOT_SETTING_KEYS`): desktop 1.0.11 refuses a
 * snapshot naming a key it does not know. Its history answers it.
 */
export async function readCurrentSettings(context: RepositoryContext): Promise<readonly CurrentSetting[]> {
  const { rows } = await context.db.query<SettingDbRow>(
    `SELECT ${COLUMNS} FROM workspace_settings
      WHERE workspace_id = $1 AND superseded_at IS NULL`,
    [context.scope.workspaceId],
  );
  const byKey = new Map(rows.map(row => [row.setting_key, row]));
  return SNAPSHOT_SETTING_KEYS.map(key => {
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
export async function readSetting<K extends ActiveSettingKey>(
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
  key: ActiveSettingKey,
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

/**
 * The change note a save records when the person gave none (wave 2, D5's API half).
 * `change_note` may be null in 0013, but the history reads better with a sentence; the
 * Mac already defaults its field to this.
 */
export const DEFAULT_SETTING_CHANGE_NOTE = 'Changed on the Mac';

export interface UpdateSettingInput {
  readonly settingKey: ActiveSettingKey;
  readonly value: unknown;
  /** Optional since wave 2 (D5): blank or absent records `DEFAULT_SETTING_CHANGE_NOTE`. */
  readonly changeNote?: string | undefined;
  readonly commandId?: string | undefined;
  /**
   * The digest of the API image making this write, as its bootstrap discovered it
   * (`discoverImageDigest`), or `unknown`. Read only for `sending_enabled` with
   * `enabled: true`, and absent means unknown: an enable from a caller that cannot say
   * which image it is running is refused `release_record_identity_unknown`.
   */
  readonly runningApiDigest?: string | undefined;
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

  const changeNote = input.changeNote?.trim() || DEFAULT_SETTING_CHANGE_NOTE;
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

  // 16.2: the reference must be a stored, passing record, and it must name the API
  // image that is taking this write — or, for the process form `ci-gate:main` (lane
  // g100), a stored, passing `ci-gate` record must name it. The schema has already
  // refused an enable with no reference at all.
  if (input.settingKey === 'sending_enabled') {
    const sending = value as SendingEnabledSetting;
    if (sending.enabled) {
      const binding = await bindReleaseAttestation(
        context,
        sending.releaseGateReference ?? '',
        'api',
        input.runningApiDigest,
      );
      if (!binding.ok) return { ok: false, reason: binding.reason };
    }
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
      // `greatest(now(), changed_at)` rather than `now()`: `now()` is the
      // *transaction start* instant, and under the advisory lock the superseding
      // transaction may well have begun before the one whose row it is retiring
      // committed. Plain `now()` would then be earlier than `changed_at` and
      // `workspace_settings_superseded_not_before_changed` would refuse it — which
      // is the constraint doing its job on a value that was wrong, not a constraint
      // that is too strict. A zero-length validity window is the honest answer for
      // two versions written in the same instant.
      `UPDATE workspace_settings
          SET superseded_at = greatest(now(), changed_at), superseded_by_version = $4
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
      changeNote,
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
    detail: { version: nextVersion, previousVersion, changeNote },
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

/**
 * The workspace's postal address, or null when none is set (wave 2, S3). When it is set
 * the worker composes an automated email's footer at send (`composeSendFooter`) and a
 * template's approval no longer requires one in the body.
 */
export async function readPostalAddress(context: RepositoryContext): Promise<string | null> {
  const { value } = await readSetting(context, 'postal_address');
  const parsed = postalAddressSettingSchema.safeParse(value);
  return parsed.success ? parsed.data.address : null;
}
