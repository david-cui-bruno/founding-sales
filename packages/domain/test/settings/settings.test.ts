import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ALERT_THRESHOLD_TERRAFORM_VARIABLES,
  DEFAULT_ALERT_THRESHOLDS,
  DEFAULT_SETTING_VALUES,
  HARD_MAILBOX_DAILY_CEILING,
  SETTING_KEYS,
} from '@fss/contracts';
import { withTransaction } from '../../db/queryable.ts';
import { createTestDatabase, type TestDatabase } from '../../db/testing/index.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import {
  alertThresholdsOf,
  effectiveDomainRecipientGuard,
  effectiveMailboxDailyCap,
  effectiveSendingEnabled,
  holidayCalendarOf,
  readCurrentSettings,
  readSetting,
  readSettingHistory,
  updateSetting,
} from '../../settings/index.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';

/**
 * Versioned administrative configuration (specification 10.1, 13.3, 16.2).
 *
 * The two-workspace fixture is the frame, as it is for every database test here: the
 * same key set exists in both, and a change in one is invisible in the other.
 *
 * The last two tests in this file are contract tests rather than behaviour tests.
 * One reads `infra/modules/alerts/variables.tf` and fails when a threshold default
 * here disagrees with the Terraform default there — 13.3's thresholds are one set of
 * numbers, and two copies of one set of numbers drift. The other reads the migration
 * and fails when its CHECK and `SETTING_KEYS` disagree about which keys exist.
 */

const ALERT_VARIABLES_TF = fileURLToPath(
  new URL('../../../../infra/modules/alerts/variables.tf', import.meta.url),
);
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

  it('refuses a salesperson and writes nothing', async () => {
    const outcome = await updateSetting(salesperson, {
      settingKey: 'sending_limits',
      value: { perMailboxDailyCap: 10, domainRecipientsPer24h: 4000 },
      changeNote: 'trying it on',
    });
    expect(outcome).toEqual({ ok: false, reason: 'admin_only' });
    expect((await readSetting(admin, 'sending_limits')).version).toBe(0);
  });

  it('refuses a value its key does not accept, including one that would raise a guard', async () => {
    const malformed = await updateSetting(admin, {
      settingKey: 'sending_limits',
      value: { perMailboxDailyCap: 'ten', domainRecipientsPer24h: 4000 },
      changeNote: 'a string is not a cap',
    });
    expect(malformed).toEqual({ ok: false, reason: 'invalid_value' });

    // 12.7's hard ceiling and 12.6's domain guard are maxima in the schema, so a
    // request past either is malformed rather than merely refused.
    const overCeiling = await updateSetting(admin, {
      settingKey: 'sending_limits',
      value: { perMailboxDailyCap: HARD_MAILBOX_DAILY_CEILING + 1, domainRecipientsPer24h: 4000 },
      changeNote: 'past the ceiling',
    });
    expect(overCeiling).toEqual({ ok: false, reason: 'invalid_value' });

    const overGuard = await updateSetting(admin, {
      settingKey: 'sending_limits',
      value: { perMailboxDailyCap: null, domainRecipientsPer24h: 4001 },
      changeNote: 'past the guard',
    });
    expect(overGuard).toEqual({ ok: false, reason: 'invalid_value' });

    expect((await readSetting(admin, 'sending_limits')).version).toBe(0);
  });

  it('versions every change, supersedes the previous one and keeps the history', async () => {
    const first = await updateSetting(admin, {
      settingKey: 'sending_limits',
      value: { perMailboxDailyCap: 10, domainRecipientsPer24h: 4000 },
      changeNote: 'ramp week one',
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.current.version).toBe(1);
    expect(first.value.previousVersion).toBe(0);

    const second = await updateSetting(admin, {
      settingKey: 'sending_limits',
      value: { perMailboxDailyCap: 5, domainRecipientsPer24h: 2000 },
      changeNote: 'lowered after a bounce',
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.current.version).toBe(2);
    expect(second.value.previousVersion).toBe(1);

    const history = await readSettingHistory(admin, 'sending_limits');
    expect(history.map(entry => entry.version)).toEqual([2, 1]);
    expect(history[0]?.supersededAt).toBeNull();
    expect(history[1]?.supersededAt).not.toBeNull();
    expect(history[1]?.changeNote).toBe('ramp week one');
    expect(history.every(entry => entry.changedByUserId === seeded.alpha.admin.userId)).toBe(true);

    // At most one current version per key. The partial unique index is the invariant;
    // this asserts the command respects it rather than relying on it.
    const currentRows = await database.session.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM workspace_settings
        WHERE workspace_id = $1 AND setting_key = 'sending_limits' AND superseded_at IS NULL`,
      [seeded.alpha.workspaceId],
    );
    expect(currentRows.rows[0]?.count).toBe('1');
  });

  it('keeps the other workspace at its default', async () => {
    expect((await readSetting(betaAdmin, 'sending_limits')).version).toBe(0);
    expect((await readSetting(betaAdmin, 'sending_limits')).value).toEqual(
      DEFAULT_SETTING_VALUES.sending_limits,
    );
    const beta = await updateSetting(betaAdmin, {
      settingKey: 'sending_limits',
      value: { perMailboxDailyCap: 25, domainRecipientsPer24h: 4000 },
      changeNote: 'the other workspace',
    });
    expect(beta.ok).toBe(true);
    if (!beta.ok) return;
    // Version numbering is per workspace and per key; beta's first change is its
    // version 1 even though alpha is already on 2.
    expect(beta.value.current.version).toBe(1);
    expect((await readSetting(admin, 'sending_limits')).version).toBe(2);
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

  it('serializes two admins saving the same slice at the same instant', async () => {
    // Two backend connections, two *transactions*, one advisory lock. The lock is
    // `pg_advisory_xact_lock`, so it is held for the transaction and not for the
    // statement — which is why each call is wrapped here exactly as `runCommand`
    // wraps it in production, with the receipt and the mutation in one transaction
    // (5.3). Outside a transaction the guard still refuses safely with
    // `setting_version_conflict`; it simply does not queue.
    const second = await database.appRuntimeSession();
    const other = repositoryContext(admin.scope, second);

    const [left, right] = await Promise.all([
      withTransaction(database.session, async () => await updateSetting(admin, {
        settingKey: 'postal_footer',
        value: {
          organizationName: 'Callie',
          addressLine: '1 Example Street',
          locality: 'Providence',
          regionCode: 'RI',
          postalCode: '02903',
          countryCode: 'US',
        },
        changeNote: 'first save',
      })),
      withTransaction(second, async () => await updateSetting(other, {
        settingKey: 'postal_footer',
        value: {
          organizationName: 'Callie',
          addressLine: '2 Example Street',
          locality: 'Providence',
          regionCode: 'RI',
          postalCode: '02903',
          countryCode: 'US',
        },
        changeNote: 'second save',
      })),
    ]);

    expect(left.ok, 'the first save').toBe(true);
    expect(right.ok, 'the second save').toBe(true);
    const versions = [left.ok ? left.value.current.version : 0, right.ok ? right.value.current.version : 0].sort();
    expect(versions).toEqual([1, 2]);

    const currentRows = await database.session.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM workspace_settings
        WHERE workspace_id = $1 AND setting_key = 'postal_footer' AND superseded_at IS NULL`,
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

  it('takes the lower of the ramp and the configured cap, and never exceeds the ceiling', () => {
    const configured = { perMailboxDailyCap: 5, domainRecipientsPer24h: 4000 };
    expect(effectiveMailboxDailyCap(35, configured)).toBe(5);
    // An admin cannot configure their way past a ramp that has not advanced.
    expect(effectiveMailboxDailyCap(5, { perMailboxDailyCap: 75, domainRecipientsPer24h: 4000 })).toBe(5);
    expect(effectiveMailboxDailyCap(35, { perMailboxDailyCap: null, domainRecipientsPer24h: 4000 })).toBe(35);
    expect(effectiveMailboxDailyCap(500, { perMailboxDailyCap: null, domainRecipientsPer24h: 4000 })).toBe(
      HARD_MAILBOX_DAILY_CEILING,
    );
    expect(effectiveMailboxDailyCap(35, 'nonsense')).toBe(35);
  });

  it('reads the domain guard, defaulting to 12.6 s 4,000', () => {
    expect(effectiveDomainRecipientGuard({ perMailboxDailyCap: null, domainRecipientsPer24h: 1000 })).toBe(1000);
    expect(effectiveDomainRecipientGuard(null)).toBe(4000);
  });

  it('names the holiday calendar after the setting version that produced it', () => {
    const calendar = holidayCalendarOf({ dates: ['2026-12-25', '2026-07-04'] }, 3);
    expect(calendar).toEqual({ version: 'workspace.3', dates: ['2026-07-04', '2026-12-25'] });
    expect(holidayCalendarOf('nonsense', 0)).toEqual({ version: 'workspace.0', dates: [] });
  });

  it('falls back to the release thresholds when the stored value cannot be read', () => {
    expect(alertThresholdsOf({})).toEqual(DEFAULT_ALERT_THRESHOLDS);
    expect(alertThresholdsOf({ ...DEFAULT_ALERT_THRESHOLDS, canaryStaleSeconds: 600 }).canaryStaleSeconds).toBe(600);
    // The warning threshold must stay below the critical one, or the pair is refused.
    expect(
      alertThresholdsOf({ ...DEFAULT_ALERT_THRESHOLDS, oldestJobAgeWarningSeconds: 1200 }),
    ).toEqual(DEFAULT_ALERT_THRESHOLDS);
  });
});

describe('the thresholds are one set of numbers', () => {
  it('agrees with the Terraform defaults the alarms are built from', () => {
    const text = readFileSync(ALERT_VARIABLES_TF, 'utf8');
    let compared = 0;
    for (const [field, variable] of Object.entries(ALERT_THRESHOLD_TERRAFORM_VARIABLES)) {
      if (variable === null) continue;
      const block = text.slice(text.indexOf(`variable "${variable}" {`));
      const value = /default\s+= (\d+)/u.exec(block)?.[1];
      expect(value, `${variable} has no default in variables.tf`).toBeDefined();
      expect(Number(value), variable).toBe(DEFAULT_ALERT_THRESHOLDS[field as keyof typeof DEFAULT_ALERT_THRESHOLDS]);
      compared += 1;
    }
    // Eight of the ten fields are Terraform variables. The Today deadline is a
    // workspace-local time of day and the held fraction is a literal inside a
    // metric-math expression; neither has a variable to compare with.
    expect(compared, 'the Terraform comparison covered nothing').toBe(8);
  });

  it('keeps the migration s key set equal to SETTING_KEYS', () => {
    // Located by suffix rather than by number: the coordinator assigns migration
    // numbers and a lane develops against the final one while renumbering locally.
    const file = readdirSync(MIGRATION).find(name => name.endsWith('_dashboard.sql'));
    expect(file, 'the settings migration is not in packages/domain/db/migrations').toBeDefined();
    const migration = readFileSync(`${MIGRATION}${file ?? ''}`, 'utf8');
    const block = /workspace_settings_key_known\s*\n\s*CHECK \(setting_key IN \(([^)]*)\)\)/u.exec(migration)?.[1];
    expect(block, 'the CHECK is no longer where this test looks for it').toBeDefined();
    const keys = [...(block ?? '').matchAll(/'([a-z_]+)'/gu)].map(match => match[1]);
    expect(keys.sort()).toEqual([...SETTING_KEYS].sort());
  });
});
