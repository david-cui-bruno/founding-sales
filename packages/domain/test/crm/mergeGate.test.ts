import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordingSuppressionJournal } from '../../suppression/journal.ts';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { withTransaction } from '../../db/queryable.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { createFirm } from '../../crm/firms.ts';
import { mergeFirms } from '../../crm/merges.ts';
import { sendGateLockName } from '../../policy/sendGate.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';

/**
 * A firm merge takes the send gate before any firm row (call-to-booking review fold 2).
 *
 * The cycle it closes: a Twilio call's consumption holds the gate SHARED and then locks
 * the firm; a merge that locked the firm first and asked for the gate EXCLUSIVE later
 * waited on the consumption while the consumption waited on it. Here a second
 * connection plays the consumption: it holds the gate shared, the merge is observed
 * waiting on it through `pg_blocking_pids`, and the consumption's own firm lock is then
 * granted at once — which it could not be if the merge already held the firm.
 */
describe('mergeFirms and the send gate', () => {
  let database: TestDatabase;
  let seeded: TwoWorkspaces;
  let crm: SeededCrm;

  const admin = (): RepositoryContext =>
    repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.admin.userId, role: 'admin' }),
      database.session,
    );

  beforeAll(async () => {
    database = await createTestDatabase();
    seeded = await seedTwoWorkspaces(database.session);
    crm = await seedCrm(database.session, seeded);
  });

  afterAll(async () => {
    await database.drop();
  });

  it('waits on the gate holding no firm lock, so a consumption holding the gate can still lock the firm', async () => {
    const duplicate = await withTransaction(database.session, async () =>
      await createFirm(admin(), { name: 'Northwind Test Holdings (merge gate)' }),
    );
    if (!duplicate.ok) throw new Error(duplicate.reason);
    const consumption = await database.appRuntimeSession();
    const { rows: pid } = await consumption.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    const consumptionPid = Number(pid[0]?.pid);

    await consumption.query('BEGIN');
    await consumption.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))', [
      sendGateLockName(seeded.alpha.workspaceId),
    ]);
    const merging = withTransaction(database.session, async () =>
      await mergeFirms(admin(), { journal: recordingSuppressionJournal(), sourceFirmId: duplicate.value.id, targetFirmId: crm.alpha.firmId }),
    );
    let blocked = false;
    for (let attempt = 0; attempt < 100 && !blocked; attempt += 1) {
      const { rows } = await consumption.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM pg_stat_activity
          WHERE pid <> pg_backend_pid() AND $1::int = ANY(pg_blocking_pids(pid))`,
        [consumptionPid],
      );
      blocked = Number(rows[0]?.count ?? 0) > 0;
      if (!blocked) await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(blocked).toBe(true);

    // The consumption's next step: the firm row. Granted at once, because the merge is
    // waiting on the gate and holds neither firm.
    await consumption.query("SET LOCAL lock_timeout = '2s'");
    for (const firmId of [duplicate.value.id, crm.alpha.firmId]) {
      const locked = await consumption.query<{ id: string }>(
        'SELECT id FROM firms WHERE workspace_id = $1 AND id = $2 FOR NO KEY UPDATE',
        [seeded.alpha.workspaceId, firmId],
      );
      expect(locked.rows).toHaveLength(1);
    }
    await consumption.query('COMMIT');

    expect(await merging).toMatchObject({ ok: true });
  });
});
