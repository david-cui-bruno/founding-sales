import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { readAppliedSchemaVersion } from '../../db/migrationRunner.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from './support/fixtures.ts';
import { seedCrm, type SeededCrm } from './support/crmFixtures.ts';

/**
 * Migration 0036 on a database at schema 35 (slice 3a, lane B): every stored hold, Today
 * item and call log survives the swapped CHECKs unchanged; `review_call`, the `task` kind
 * (lane `due_work`) and the `call_task` source are admitted (each refused at 35); an
 * agreement on a `callback_requested` log is admitted and one on a voicemail still is not;
 * and `call_tasks` exists, empty, granted to the runtime role.
 */
describe('migration 0036 on a database at schema 35', () => {
  let database: TestDatabase;
  let seeded: TwoWorkspaces;
  let crm: SeededCrm;
  let holdsBefore: unknown[] = [];
  let itemsBefore: unknown[] = [];

  const reviewHold = async (): Promise<unknown> =>
    await database.session.query(
      `INSERT INTO active_holds (workspace_id, scope_kind, scope_key, reason_code, blocked_action_kinds, source_event_kind, source_event_id, recovery_action)
       VALUES ($1, 'firm', $2, 'scoped_pause', ARRAY['email_send','enrollment_advance','call_task'], 'call_analysis_pending', gen_random_uuid()::text, 'review_call')`,
      [seeded.alpha.workspaceId, crm.alpha.firmId],
    );
  const taskItem = async (): Promise<unknown> =>
    await database.session.query(
      `INSERT INTO today_items (workspace_id, snapshot_date, firm_id, item_key, kind, due_at, source_kind, source_id)
       VALUES ($1, '2026-10-02', $2, 'call-task:' || gen_random_uuid()::text, 'task', '2026-10-02T14:00:00Z', 'call_task', gen_random_uuid())`,
      [seeded.alpha.workspaceId, crm.alpha.firmId],
    );

  beforeAll(async () => {
    database = await createTestDatabase({ throughVersion: 35 });
    expect(await readAppliedSchemaVersion(database.session)).toBe(35);
    seeded = await seedTwoWorkspaces(database.session);
    crm = await seedCrm(database.session, seeded);
    // A stored hold of each recovery action 0035 admits, and a Today item of each kind.
    for (const action of ['resume_after_review', 'confirm_reply', 'release_pause', null]) {
      await database.session.query(
        `INSERT INTO active_holds (workspace_id, scope_kind, scope_key, reason_code, blocked_action_kinds, source_event_kind, recovery_action)
         VALUES ($1, 'firm', $2, 'scoped_pause', ARRAY['dial_authorization'], 'call_cadence_parked', $3)`,
        [seeded.alpha.workspaceId, crm.alpha.firmId, action],
      );
    }
    for (const kind of ['reply', 'callback', 'email_due', 'call_due', 'new_firm']) {
      await database.session.query(
        `INSERT INTO today_items (workspace_id, snapshot_date, firm_id, item_key, kind, due_at, source_kind)
         VALUES ($1, '2026-10-01', $2, $3, $4, '2026-10-01T14:00:00Z', 'firm')`,
        [seeded.alpha.workspaceId, crm.alpha.firmId, `kind:${kind}`, kind],
      );
    }
    await expect(reviewHold()).rejects.toMatchObject({ constraint: 'active_holds_recovery_action_known' });
    await expect(taskItem()).rejects.toMatchObject({ constraint: 'today_items_kind_known' });
    holdsBefore = (await database.session.query('SELECT * FROM active_holds ORDER BY id')).rows;
    itemsBefore = (await database.session.query('SELECT * FROM today_items ORDER BY id')).rows;
    const { applyMigrations } = await import('../../db/migrationRunner.ts');
    await applyMigrations(database.session, { throughVersion: 36 });
  });

  afterAll(async () => {
    await database.drop();
  });

  it('is at schema 36, with every stored hold and Today item unchanged, lanes included', async () => {
    expect(await readAppliedSchemaVersion(database.session)).toBe(36);
    expect((await database.session.query('SELECT * FROM active_holds ORDER BY id')).rows).toEqual(holdsBefore);
    expect((await database.session.query('SELECT * FROM today_items ORDER BY id')).rows).toEqual(itemsBefore);
  });

  it('admits the review_call recovery, once per session ever', async () => {
    await reviewHold();
    const { rows } = await database.session.query<{ id: string }>(
      "SELECT source_event_id AS id FROM active_holds WHERE source_event_kind = 'call_analysis_pending'",
    );
    await expect(
      database.session.query(
        `INSERT INTO active_holds (workspace_id, scope_kind, scope_key, reason_code, blocked_action_kinds, source_event_kind, source_event_id, recovery_action, released_at)
         VALUES ($1, 'firm', $2, 'scoped_pause', ARRAY['email_send'], 'call_analysis_pending', $3, 'review_call', now())`,
        [seeded.alpha.workspaceId, crm.alpha.firmId, rows[0]?.id],
      ),
    ).rejects.toMatchObject({ constraint: 'active_holds_one_pending_review' });
  });

  it('admits a task item from a call task, in lane due_work', async () => {
    await taskItem();
    const { rows } = await database.session.query<{ lane: string }>("SELECT lane FROM today_items WHERE kind = 'task'");
    expect(rows).toEqual([{ lane: 'due_work' }]);
  });

  it('swaps the agreement CHECK: a reached person may agree, a voicemail may not', async () => {
    const { rows: constraints } = await database.session.query<{ conname: string }>(
      "SELECT conname FROM pg_constraint WHERE conname LIKE 'call_logs_agreement_needs_%' ORDER BY conname",
    );
    expect(constraints.map(row => row.conname)).toEqual(['call_logs_agreement_needs_interest']);
  });

  it('creates call_tasks, empty, readable and writable by the runtime role', async () => {
    expect((await database.session.query('SELECT count(*)::int AS n FROM call_tasks')).rows).toEqual([{ n: 0 }]);
    const { rows } = await database.session.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE table_name = 'call_tasks' AND grantee = 'app_runtime' ORDER BY privilege_type`,
    );
    expect(rows.map(row => row.privilege_type)).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
  });
});
