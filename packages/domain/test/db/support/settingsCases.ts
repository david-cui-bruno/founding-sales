import type { SessionQueryable } from '../../../db/queryable.ts';
import type { TwoWorkspaces } from './fixtures.ts';

/**
 * A failing insert for every constraint migration 0013 adds (lane G9:
 * `workspace_settings`).
 *
 * Same rules as `todayCases.ts`: its own file so two lanes never edit the middle of
 * one array, each case inside a transaction the caller rolls back, and each row
 * breaking exactly one thing — a row that breaks two is reported under whichever
 * check PostgreSQL reaches first and the case would be testing the wrong promise.
 */

export interface SettingsCaseFixture {
  readonly session: SessionQueryable;
  readonly seeded: TwoWorkspaces;
}

export interface SettingsCase {
  readonly constraint: string;
  readonly run: (fixture: SettingsCaseFixture) => Promise<unknown>;
}

const workspace = (f: SettingsCaseFixture): string => f.seeded.alpha.workspaceId;
const admin = (f: SettingsCaseFixture): string => f.seeded.alpha.admin.userId;
/** A member of the *other* workspace: the composite foreign key must refuse them. */
const otherWorkspaceUser = (f: SettingsCaseFixture): string => f.seeded.beta.admin.userId;

/** A syntactically valid UUID that is never a row. */
const MISSING = '00000000-0000-4000-8000-000000000000';
const VALUE = `'{"enabled": false, "releaseGateReference": null}'::jsonb`;

/** A valid current row, so a case can collide with it. */
async function insertCurrent(
  f: SettingsCaseFixture,
  key: string,
  version = 1,
): Promise<string> {
  const { rows } = await f.session.query<{ id: string }>(
    `INSERT INTO workspace_settings (workspace_id, setting_key, version, value, changed_by_user_id)
     VALUES ($1, $2, $3, ${VALUE}, $4) RETURNING id`,
    [workspace(f), key, version, admin(f)],
  );
  return rows[0]?.id ?? '';
}

export const SETTINGS_CONSTRAINT_CASES: readonly SettingsCase[] = [
  {
    constraint: 'workspace_settings_pkey',
    run: async f => {
      const id = await insertCurrent(f, 'sending_enabled');
      return await f.session.query(
        `INSERT INTO workspace_settings (id, workspace_id, setting_key, version, value)
         VALUES ($1, $2, 'business_time_zone', 1, ${VALUE})`,
        [id, workspace(f)],
      );
    },
  },
  {
    constraint: 'workspace_settings_workspace_id_fkey',
    run: async f =>
      await f.session.query(
        `INSERT INTO workspace_settings (workspace_id, setting_key, version, value)
         VALUES ($1, 'sending_enabled', 1, ${VALUE})`,
        [MISSING],
      ),
  },
  {
    constraint: 'workspace_settings_one_per_version',
    run: async f => {
      // Two rows at the same version of the same key. The first is superseded, so
      // the partial "current" index is not what refuses this one.
      await f.session.query(
        `INSERT INTO workspace_settings (workspace_id, setting_key, version, value, superseded_at, superseded_by_version)
         VALUES ($1, 'business_time_zone', 1, ${VALUE}, now(), 2)`,
        [workspace(f)],
      );
      return await f.session.query(
        `INSERT INTO workspace_settings (workspace_id, setting_key, version, value, superseded_at, superseded_by_version)
         VALUES ($1, 'business_time_zone', 1, ${VALUE}, now(), 2)`,
        [workspace(f)],
      );
    },
  },
  {
    constraint: 'workspace_settings_current',
    run: async f => {
      await insertCurrent(f, 'business_time_zone', 1);
      // A second *current* row for the same key, at a different version.
      return await f.session.query(
        `INSERT INTO workspace_settings (workspace_id, setting_key, version, value)
         VALUES ($1, 'business_time_zone', 2, ${VALUE})`,
        [workspace(f)],
      );
    },
  },
  {
    constraint: 'workspace_settings_actor_fkey',
    run: async f =>
      await f.session.query(
        `INSERT INTO workspace_settings (workspace_id, setting_key, version, value, changed_by_user_id)
         VALUES ($1, 'sending_enabled', 1, ${VALUE}, $2)`,
        [workspace(f), otherWorkspaceUser(f)],
      ),
  },
  {
    constraint: 'workspace_settings_key_known',
    run: async f =>
      await f.session.query(
        `INSERT INTO workspace_settings (workspace_id, setting_key, version, value)
         VALUES ($1, 'something_an_admin_invented', 1, ${VALUE})`,
        [workspace(f)],
      ),
  },
  {
    constraint: 'workspace_settings_version_positive',
    run: async f =>
      await f.session.query(
        `INSERT INTO workspace_settings (workspace_id, setting_key, version, value)
         VALUES ($1, 'sending_enabled', 0, ${VALUE})`,
        [workspace(f)],
      ),
  },
  {
    constraint: 'workspace_settings_value_is_object',
    run: async f =>
      await f.session.query(
        `INSERT INTO workspace_settings (workspace_id, setting_key, version, value)
         VALUES ($1, 'sending_enabled', 1, '"a string is not a settings value"'::jsonb)`,
        [workspace(f)],
      ),
  },
  {
    constraint: 'workspace_settings_note_bounded',
    run: async f =>
      await f.session.query(
        `INSERT INTO workspace_settings (workspace_id, setting_key, version, value, change_note)
         VALUES ($1, 'sending_enabled', 1, ${VALUE}, '   ')`,
        [workspace(f)],
      ),
  },
  {
    constraint: 'workspace_settings_supersession_consistent',
    run: async f =>
      await f.session.query(
        `INSERT INTO workspace_settings (workspace_id, setting_key, version, value, superseded_at)
         VALUES ($1, 'sending_enabled', 1, ${VALUE}, now())`,
        [workspace(f)],
      ),
  },
  {
    constraint: 'workspace_settings_superseded_by_later',
    run: async f =>
      await f.session.query(
        `INSERT INTO workspace_settings (workspace_id, setting_key, version, value, superseded_at, superseded_by_version)
         VALUES ($1, 'sending_enabled', 2, ${VALUE}, now(), 1)`,
        [workspace(f)],
      ),
  },
  {
    constraint: 'workspace_settings_superseded_not_before_changed',
    run: async f =>
      await f.session.query(
        `INSERT INTO workspace_settings
           (workspace_id, setting_key, version, value, changed_at, superseded_at, superseded_by_version)
         VALUES ($1, 'sending_enabled', 1, ${VALUE},
                 TIMESTAMPTZ '2026-09-20 12:00:00+00', TIMESTAMPTZ '2026-09-20 11:00:00+00', 2)`,
        [workspace(f)],
      ),
  },
];
