import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_SETTING_VALUES, RETIRED_SETTING_KEYS, SETTING_KEYS } from '@fss/contracts';
import { withTransaction } from '../../db/queryable.ts';
import { createTestDatabase, type TestDatabase } from '../../db/testing/index.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import {
  effectiveSendingEnabled,
  readCurrentSettings,
  readSetting,
  readSettingHistory,
  updateSetting,
} from '../../settings/index.ts';
import { ALL_BLOCKED_ACTION_KINDS, CHANNEL_BLOCKED_ACTION_KINDS } from '../../policy/types.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { FIXTURE_API_DIGEST, storeFixtureRecord } from '../release/support/releaseRecords.ts';

/**
 * Versioned administrative configuration (specification 10.1, 16.2).
 *
 * The two-workspace fixture is the frame, as it is for every database test here: the
 * same key set exists in both, and a change in one is invisible in the other.
 *
 * The last test reads the migration and fails when `SETTING_KEYS` names a key its
 * CHECK does not allow.
 */

const MIGRATION = fileURLToPath(new URL('../../db/migrations/', import.meta.url));

describe('workspace settings', () => {
  let database: TestDatabase;
  let seeded: TwoWorkspaces;
  let admin: RepositoryContext;
  let salesperson: RepositoryContext;
  let betaAdmin: RepositoryContext;

  beforeAll(async () => {
    database = await createTestDatabase();
    seeded = await seedTwoWorkspaces(database.session);
    admin = repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.admin.userId, role: 'admin' }),
      database.session,
    );
    salesperson = repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, {
        kind: 'user',
        userId: seeded.alpha.salesperson.userId,
        role: 'salesperson',
      }),
      database.session,
    );
    betaAdmin = repositoryContext(
      workspaceScope(seeded.beta.workspaceId, { kind: 'user', userId: seeded.beta.admin.userId, role: 'admin' }),
      database.session,
    );
  });

  afterAll(async () => {
    await database.drop();
  });

  it('answers with every key at its default before anybody has configured anything', async () => {
    const current = await readCurrentSettings(admin);
    expect(current.map(entry => entry.settingKey)).toEqual([...SETTING_KEYS]);
    for (const entry of current) {
      expect(entry.version, entry.settingKey).toBe(0);
      expect(entry.changedAt, entry.settingKey).toBeNull();
      expect(entry.value, entry.settingKey).toEqual(DEFAULT_SETTING_VALUES[entry.settingKey]);
    }
  });

  it('answers neither retired slice, even when an old row is stored', async () => {
    // Migration 0015's CHECK still allows both keys, so a row written before they were
    // retired can still be in the table. It is never answered.
    await database.session.query(
      `INSERT INTO workspace_settings (workspace_id, setting_key, version, value, change_note, changed_by_user_id)
       VALUES ($1, 'client_version_range', 1, '{"minimum":"1.0.0","maximum":"1.4.0"}'::jsonb, 'old row', $2)`,
      [seeded.beta.workspaceId, seeded.beta.admin.userId],
    );
    const keys = (await readCurrentSettings(betaAdmin)).map(entry => entry.settingKey);
    expect(keys).toEqual([...SETTING_KEYS]);
    for (const retired of RETIRED_SETTING_KEYS) expect(keys as readonly string[]).not.toContain(retired);
  });

  it('refuses a salesperson and writes nothing', async () => {
    const outcome = await updateSetting(salesperson, {
      settingKey: 'business_time_zone',
      value: { timeZone: 'America/Chicago' },
      changeNote: 'trying it on',
    });
    expect(outcome).toEqual({ ok: false, reason: 'admin_only' });
    expect((await readSetting(admin, 'business_time_zone')).version).toBe(0);
  });

  it('refuses a value its key does not accept, including one that breaks a bound', async () => {
    const malformed = await updateSetting(admin, {
      settingKey: 'business_time_zone',
      value: { timeZone: 42 },
      changeNote: 'a number is not a zone',
    });
    expect(malformed).toEqual({ ok: false, reason: 'invalid_value' });

    // The bound that is a relationship rather than a shape: enabling sending names the
    // release gate it passed.
    const unnamed = await updateSetting(admin, {
      settingKey: 'sending_enabled',
      value: { enabled: true, releaseGateReference: null },
      changeNote: 'no gate named',
    });
    expect(unnamed).toEqual({ ok: false, reason: 'invalid_value' });

    expect((await readSetting(admin, 'business_time_zone')).version).toBe(0);
    expect((await readSetting(admin, 'sending_enabled')).version).toBe(0);
  });

  it('commits the business zone with the workspace column and refuses an unknown zone', async () => {
    const unknown = await updateSetting(admin, {
      settingKey: 'business_time_zone',
      value: { timeZone: 'America/Nowhere_At_All' },
      changeNote: 'a zone Intl does not know',
    });
    expect(unknown).toEqual({ ok: false, reason: 'unknown_time_zone' });

    const changed = await updateSetting(admin, {
      settingKey: 'business_time_zone',
      value: { timeZone: 'America/Chicago' },
      changeNote: 'the founder moved',
    });
    expect(changed.ok).toBe(true);

    const { rows } = await database.session.query<{ business_time_zone: string }>(
      'SELECT business_time_zone FROM workspaces WHERE id = $1',
      [seeded.alpha.workspaceId],
    );
    expect(rows[0]?.business_time_zone).toBe('America/Chicago');
    // The other workspace's zone did not move with it.
    const other = await database.session.query<{ business_time_zone: string }>(
      'SELECT business_time_zone FROM workspaces WHERE id = $1',
      [seeded.beta.workspaceId],
    );
    expect(other.rows[0]?.business_time_zone).toBe('America/New_York');
  });

  it('writes an audit event naming the key and the version, and no value', async () => {
    const { rows } = await database.session.query<{ subject_id: string; detail: Record<string, unknown> }>(
      `SELECT subject_id, detail FROM audit_events
        WHERE workspace_id = $1 AND action = 'settings.updated' AND subject_id = 'business_time_zone'
        ORDER BY occurred_at DESC LIMIT 1`,
      [seeded.alpha.workspaceId],
    );
    expect(rows[0]?.subject_id).toBe('business_time_zone');
    expect(rows[0]?.detail).toMatchObject({ version: 1, previousVersion: 0 });
    // The detail carries identifiers and codes, never the configured value itself.
    expect(JSON.stringify(rows[0]?.detail)).not.toContain('America/Chicago');
  });

  it('versions every change, supersedes the previous one and keeps the history', async () => {
    const second = await updateSetting(admin, {
      settingKey: 'business_time_zone',
      value: { timeZone: 'America/Denver' },
      changeNote: 'moved again',
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.current.version).toBe(2);
    expect(second.value.previousVersion).toBe(1);

    const history = await readSettingHistory(admin, 'business_time_zone');
    expect(history.map(entry => entry.version)).toEqual([2, 1]);
    expect(history[0]?.supersededAt).toBeNull();
    expect(history[1]?.supersededAt).not.toBeNull();
    expect(history[1]?.changeNote).toBe('the founder moved');
    expect(history.every(entry => entry.changedByUserId === seeded.alpha.admin.userId)).toBe(true);

    // At most one current version per key. The partial unique index is the invariant;
    // this asserts the command respects it rather than relying on it.
    const currentRows = await database.session.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM workspace_settings
        WHERE workspace_id = $1 AND setting_key = 'business_time_zone' AND superseded_at IS NULL`,
      [seeded.alpha.workspaceId],
    );
    expect(currentRows.rows[0]?.count).toBe('1');
  });

  it('keeps the other workspace at its default', async () => {
    expect((await readSetting(betaAdmin, 'business_time_zone')).version).toBe(0);
    expect((await readSetting(betaAdmin, 'business_time_zone')).value).toEqual(
      DEFAULT_SETTING_VALUES.business_time_zone,
    );
    const beta = await updateSetting(betaAdmin, {
      settingKey: 'business_time_zone',
      value: { timeZone: 'America/Los_Angeles' },
      changeNote: 'the other workspace',
    });
    expect(beta.ok).toBe(true);
    if (!beta.ok) return;
    // Version numbering is per workspace and per key; beta's first change is its
    // version 1 even though alpha is already on 2.
    expect(beta.value.current.version).toBe(1);
    expect((await readSetting(admin, 'business_time_zone')).version).toBe(2);
  });

  it('serializes two admins saving the same slice at the same instant', async () => {
    // Two backend connections, two *transactions*, one advisory lock. The lock is
    // `pg_advisory_xact_lock`, so it is held for the transaction and not for the
    // statement — which is why each call is wrapped here exactly as `runCommand`
    // wraps it in production, with the receipt and the mutation in one transaction
    // (5.3). Outside a transaction the guard still refuses safely with
    // `setting_version_conflict`; it simply does not queue.
    const second = await database.appRuntimeSession();
    const other = repositoryContext(admin.scope, second);

    // `sending_enabled` is the one slice no earlier test in this file has written, so
    // the two saves really are version 1 and version 2. It was `postal_footer` until
    // migration 0015 removed that slice. Since lane g71 an enable names a stored,
    // passing release record bound to the running API, so both references are stored
    // first and both saves say which API image they are.
    await storeFixtureRecord(database.session, 'rehearsal-2026-09-20-a');
    await storeFixtureRecord(database.session, 'rehearsal-2026-09-20-b');
    const [left, right] = await Promise.all([
      withTransaction(database.session, async () => await updateSetting(admin, {
        settingKey: 'sending_enabled',
        value: { enabled: true, releaseGateReference: 'rehearsal-2026-09-20-a' },
        changeNote: 'first save',
        runningApiDigest: FIXTURE_API_DIGEST,
      })),
      withTransaction(second, async () => await updateSetting(other, {
        settingKey: 'sending_enabled',
        value: { enabled: true, releaseGateReference: 'rehearsal-2026-09-20-b' },
        changeNote: 'second save',
        runningApiDigest: FIXTURE_API_DIGEST,
      })),
    ]);

    expect(left.ok, 'the first save').toBe(true);
    expect(right.ok, 'the second save').toBe(true);
    const versions = [left.ok ? left.value.current.version : 0, right.ok ? right.value.current.version : 0].sort();
    expect(versions).toEqual([1, 2]);

    const currentRows = await database.session.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM workspace_settings
        WHERE workspace_id = $1 AND setting_key = 'sending_enabled' AND superseded_at IS NULL`,
      [seeded.alpha.workspaceId],
    );
    expect(currentRows.rows[0]?.count).toBe('1');
  });
});

describe('what a stored setting means', () => {
  it('needs both switches before production sending is on', () => {
    const on = { enabled: true, releaseGateReference: 'rehearsal-2026-09-20' };
    expect(effectiveSendingEnabled(true, on)).toBe(true);
    expect(effectiveSendingEnabled(false, on)).toBe(false);
    expect(effectiveSendingEnabled(true, { enabled: false, releaseGateReference: null })).toBe(false);
    // An unreadable setting is "no". Configuration that governs outbound mail fails
    // to the safe side.
    expect(effectiveSendingEnabled(true, { enabled: 'yes' })).toBe(false);
    expect(effectiveSendingEnabled(true, undefined)).toBe(false);
    expect(effectiveSendingEnabled(true, DEFAULT_SETTING_VALUES.sending_enabled)).toBe(false);
  });

  it('does not own the sending caps or the domain guard', () => {
    // 12.7's ramp is computed from healthy sending days and 12.6's guard is a
    // reviewed policy change; both live on G7-2's `mailbox_send_ramp` and
    // `sending_domains`, where a CHECK holds 100 and a command holds 75. A second
    // implementation here could disagree with the constraint, and the constraint is
    // the one that stops a send.
    expect(SETTING_KEYS).not.toContain('sending_limits');
    expect(Object.keys(DEFAULT_SETTING_VALUES)).not.toContain('sending_limits');
  });

  it('does not own the holiday calendar', () => {
    // 11.2's business-day delay freezes the calendar *version* on to every stored
    // due instant, so the calendar needs an immutable version and a table of its
    // own. That is G8's `workspace_holiday_calendars` (migration 0012), and this
    // store must not be a second answer to the same question.
    expect(SETTING_KEYS).not.toContain('holiday_calendar');
    expect(Object.keys(DEFAULT_SETTING_VALUES)).not.toContain('holiday_calendar');
  });
});

describe('what a sending pause cannot reach', () => {
  /**
   * Specification 10.1: "A sending pause does not stop Gmail synchronization,
   * opt-out processing, Today construction, or manual calling unless calling is
   * separately paused."
   *
   * G4's `test/policy/policy.test.ts` proves the manual-calling half against a real
   * database. This is the structural half, and it is the stronger one: the reason a
   * pause cannot stop synchronization, opt-out processing or Today construction is
   * that `blocked_action_kinds` has no word for any of them. There is no action kind
   * a pause could name that would reach them, so no future pause scope can either.
   */
  it('has no vocabulary for synchronization, opt-out processing or Today construction', () => {
    expect([...ALL_BLOCKED_ACTION_KINDS].sort()).toEqual([
      'call_task',
      'dial_authorization',
      'email_send',
      'enrollment_advance',
      'research',
    ]);
    for (const forbidden of ['mail_sync', 'opt_out', 'today_build', 'suppression']) {
      expect([...ALL_BLOCKED_ACTION_KINDS], forbidden).not.toContain(forbidden);
    }
  });

  it('blocks exactly one action kind per channel, and email reaches only sending', () => {
    expect(CHANNEL_BLOCKED_ACTION_KINDS.email).toEqual(['email_send']);
    // Only a call pause -- or a pause over all automation -- reaches dialling.
    expect(CHANNEL_BLOCKED_ACTION_KINDS.call).toEqual(['call_task', 'dial_authorization']);
    expect(CHANNEL_BLOCKED_ACTION_KINDS.email).not.toContain('dial_authorization');
    expect(CHANNEL_BLOCKED_ACTION_KINDS.research).toEqual(['research']);
  });
});

describe('the key set', () => {
  it('names only keys the migration s CHECK allows', () => {
    // The *last* migration that writes the CHECK wins, because a later one may narrow
    // it: migration 0013 created it with five keys and 0015 replaced it with four when
    // the postal footer stopped being a slice. Two of those four are retired and the
    // CHECK keeps allowing them until a later migration narrows it, so the active keys
    // are a subset of the allowance rather than equal to it. Sorting the file names rather than
    // naming one is also why a renumber during development does not break this: the
    // coordinator assigns migration numbers.
    const files = readdirSync(MIGRATION)
      .filter(name => name.endsWith('.sql'))
      .sort();
    const blocks = files
      .map(name => /workspace_settings_key_known\s*\n\s*CHECK \(setting_key IN \(([^)]*)\)\)/u.exec(
        readFileSync(`${MIGRATION}${name}`, 'utf8'),
      )?.[1])
      .filter((block): block is string => block !== undefined);
    expect(blocks.length, 'no migration declares workspace_settings_key_known').toBeGreaterThan(0);
    const keys = [...(blocks.at(-1) ?? '').matchAll(/'([a-z_]+)'/gu)].map(match => match[1]);
    for (const key of SETTING_KEYS) expect(keys, key).toContain(key);
  });
});
