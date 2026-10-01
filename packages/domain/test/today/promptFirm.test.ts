import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CLUSTER_URL_ENVIRONMENT_VARIABLE, asSession, createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { withTransaction, type SessionQueryable } from '../../db/queryable.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { databaseNow } from '../../policy/clock.ts';
import { createFirm } from '../../crm/firms.ts';
import { updateFirmBasics } from '../../crm/firmBasics.ts';
import { buildTodaySnapshot, refreshTodayForFirm } from '../../today/build.ts';
import { readTodayFirm, readTodayList } from '../../today/dto.ts';
import { businessDateOf } from '../../today/snapshots.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { stageIdByKey } from '../db/support/crmFixtures.ts';

/**
 * Slice S2: "a newly added firm becomes a usable card without waiting overnight", and the
 * fix for a card that cannot be called yet is made from the card.
 *
 * Until S2 a firm reached Today only at the 05:00 build, so a firm added at 10:00 had no
 * card until the next morning. `createFirm` now runs the build's own sources for that one
 * firm in its transaction (`refreshTodayForFirm`), and `updateFirmBasics` does the same
 * after it records a number, a state or a zone. The build and a refresh are ordered by an
 * advisory lock, so a build cannot cancel a task committed between its reads and its
 * reconciliation; the two concurrency cases prove the wait in both directions.
 *
 * No real business name or number. The numbers are in the NANP 555-01XX fictional block.
 */

let database: TestDatabase;
let seeded: TwoWorkspaces;
let other: pg.Client;
let otherSession: SessionQueryable;
let counter = 0;

const as = (session: SessionQueryable, role: 'salesperson' | 'admin' = 'salesperson'): RepositoryContext =>
  repositoryContext(
    workspaceScope(seeded.alpha.workspaceId, {
      kind: 'user',
      userId: role === 'admin' ? seeded.alpha.admin.userId : seeded.alpha.salesperson.userId,
      role,
    }),
    session,
  );
const salesperson = (): RepositoryContext => as(database.session);
const worker = (session: SessionQueryable = database.session): RepositoryContext =>
  repositoryContext(workspaceScope(seeded.alpha.workspaceId, { kind: 'system', component: 'worker' }), session);

async function addFirm(session: SessionQueryable = database.session): Promise<string> {
  counter += 1;
  const created = await createFirm(as(session), {
    name: `Prompt Test Property Management ${String(counter)}`,
    assignedUserId: seeded.alpha.salesperson.userId,
  });
  if (!created.ok) throw new Error(created.reason);
  return created.value.id;
}

async function itemStatus(firmId: string): Promise<string | null> {
  const { rows } = await database.session.query<{ status: string }>(
    `SELECT status FROM today_items WHERE workspace_id = $1 AND firm_id = $2 AND item_key = 'firm:' || $2::text`,
    [seeded.alpha.workspaceId, firmId],
  );
  return rows[0]?.status ?? null;
}

const waitingOnAdvisory = async (pid: number, observer: SessionQueryable): Promise<boolean> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const { rows } = await observer.query<{ waiting: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid = $1 AND NOT granted AND locktype = 'advisory') AS waiting`,
      [pid],
    );
    if (rows[0]?.waiting === true) return true;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return false;
};
const pidOf = async (session: SessionQueryable): Promise<number> =>
  Number((await session.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid);

beforeAll(async () => {
  database = await createTestDatabase();
  seeded = await seedTwoWorkspaces(database.session);
  const url = new URL((process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE] ?? '').trim());
  url.pathname = `/${database.name}`;
  other = new pg.Client({ connectionString: url.toString() });
  other.on('error', () => undefined);
  await other.connect();
  otherSession = asSession(other as unknown as Parameters<typeof asSession>[0]);
});

afterAll(async () => {
  await other?.end().catch(() => undefined);
  await database.drop();
});

beforeEach(async () => {
  await database.session.query('DELETE FROM today_items');
  await database.session.query('DELETE FROM today_snapshots');
});

describe('a firm added during the day', () => {
  it('is on today’s list at once, without the morning build, and says what it is missing', async () => {
    const firmId = await addFirm();
    const list = await readTodayList(salesperson(), { now: await databaseNow(salesperson()) });
    const card = list.cards.find(entry => entry.firmId === firmId);
    expect(card).toMatchObject({ lane: 'new_firm', blockers: ['no_phone', 'no_location'] });
    const expanded = await readTodayFirm(salesperson(), { firmId, now: await databaseNow(salesperson()) });
    expect(expanded?.basics).toEqual({ locality: null, regionCode: null, timeZone: null, blockers: ['no_phone', 'no_location'] });
  });

  it('leaves no card when the creation rolls back', async () => {
    let firmId = '';
    await expect(
      withTransaction(database.session, async () => {
        firmId = await addFirm();
        throw new Error('the import row failed');
      }),
    ).rejects.toThrow('the import row failed');
    expect(firmId).not.toBe('');
    expect(await itemStatus(firmId)).toBeNull();
  });

  it('is the row the morning build writes: a build of the same date afterwards changes nothing', async () => {
    const firmId = await addFirm();
    const now = await databaseNow(worker());
    const before = (await database.session.query('SELECT * FROM today_items WHERE firm_id = $1', [firmId])).rows;
    await buildTodaySnapshot(worker(), { businessDate: await businessDateOf(worker(), now), now });
    const after = (await database.session.query('SELECT * FROM today_items WHERE firm_id = $1', [firmId])).rows;
    expect(after.map(row => [row['item_key'], row['status'], row['lane']])).toEqual(
      before.map(row => [row['item_key'], row['status'], row['lane']]),
    );
  });

  it('a refresh of one firm reconciles that firm only', async () => {
    const kept = await addFirm();
    const refreshed = await addFirm();
    // A task the build would no longer produce, on the firm that is not being refreshed:
    // its opportunity was won, so it is not new any more (audit C19).
    await database.session.query(
      `INSERT INTO opportunities (workspace_id, firm_id, stage_id, status, closed_at, control_mode_changed_at)
       VALUES ($1, $2, $3, 'won', now(), now())`,
      [seeded.alpha.workspaceId, kept, await stageIdByKey(database.session, seeded.alpha.workspaceId, 'won')],
    );
    const report = await refreshTodayForFirm(worker(), { firmId: refreshed });
    expect(report.written).toBe(1);
    expect(report.cancelled).toBe(0);
    expect(await itemStatus(kept)).toBe('open');
  });
});

describe('the build and a refresh, concurrently', () => {
  it('a build waits for a firm still being added, and keeps its task', async () => {
    await database.session.query('BEGIN');
    let open = true;
    try {
      const firmId = await addFirm(database.session);
      const now = await databaseNow(worker());
      const businessDate = await businessDateOf(worker(), now);
      const build = withTransaction(otherSession, async () =>
        await buildTodaySnapshot(worker(otherSession), { businessDate, now }),
      );
      // Without the lock the build reads the firms without this one, and its
      // reconciliation would cancel the task the moment this transaction commits.
      expect(await waitingOnAdvisory(await pidOf(otherSession), database.session)).toBe(true);
      await database.session.query('COMMIT');
      open = false;
      await build;
      expect(await itemStatus(firmId)).toBe('open');
    } finally {
      if (open) await database.session.query('ROLLBACK');
    }
  });

  it('a firm added during a build waits for it, then writes its task on top', async () => {
    const now = await databaseNow(worker());
    const businessDate = await businessDateOf(worker(), now);
    await otherSession.query('BEGIN');
    let open = true;
    try {
      await buildTodaySnapshot(worker(otherSession), { businessDate, now });
      let firmId = '';
      const adding = withTransaction(database.session, async () => {
        firmId = await addFirm(database.session);
      });
      expect(await waitingOnAdvisory(await pidOf(database.session), otherSession)).toBe(true);
      await otherSession.query('COMMIT');
      open = false;
      await adding;
      expect(await itemStatus(firmId)).toBe('open');
    } finally {
      if (open) await otherSession.query('ROLLBACK');
    }
  });

  it('two firms added at once do not wait for each other', async () => {
    await database.session.query('BEGIN');
    try {
      await addFirm(database.session);
      const second = await withTransaction(otherSession, async () => await addFirm(otherSession));
      expect(second).toMatch(/^[0-9a-f-]{36}$/u);
    } finally {
      await database.session.query('COMMIT');
    }
  });
});

describe('the firm’s basics, from the card', () => {
  it('records a number, a state and the state’s zone, and the card can be called at once', async () => {
    const firmId = await addFirm();
    const updated = await updateFirmBasics(salesperson(), {
      firmId,
      phone: { number: '(401) 555-0142' },
      locality: 'Providence',
      regionCode: 'ri',
    });
    expect(updated).toMatchObject({
      ok: true,
      value: { firmId, locality: 'Providence', regionCode: 'RI', timeZone: 'America/New_York', blockers: [] },
    });
    const list = await readTodayList(salesperson(), { now: await databaseNow(salesperson()) });
    expect(list.cards.find(card => card.firmId === firmId)?.blockers).toEqual([]);
    const { rows: routes } = await database.session.query<{ e164: string; eligibility: string; contact_id: string | null }>(
      'SELECT e164, eligibility, contact_id FROM phone_routes WHERE firm_id = $1',
      [firmId],
    );
    expect(routes).toEqual([{ e164: '+14015550142', eligibility: 'usable', contact_id: null }]);
    const { rows: audit } = await database.session.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE subject_id = $1 AND action = 'firm.basics_updated'`,
      [firmId],
    );
    expect(audit).toHaveLength(1);
  });

  it('keeps a recorded zone when the state changes, and replaces a number by retiring the old one', async () => {
    const firmId = await addFirm();
    const first = await updateFirmBasics(salesperson(), { firmId, phone: { number: '4015550143' }, regionCode: 'TX', timeZone: 'America/Chicago' });
    expect(first.ok).toBe(true);
    const routeId = first.ok ? first.value.routeId : null;
    const second = await updateFirmBasics(salesperson(), {
      firmId,
      regionCode: 'OK',
      phone: { number: '+14015550144', ...(routeId === null ? {} : { replacesRouteId: routeId }) },
    });
    expect(second).toMatchObject({ ok: true, value: { regionCode: 'OK', timeZone: 'America/Chicago', blockers: [] } });
    const { rows } = await database.session.query<{ e164: string; eligibility: string }>(
      'SELECT e164, eligibility FROM phone_routes WHERE firm_id = $1 ORDER BY e164',
      [firmId],
    );
    expect(rows).toEqual([
      { e164: '+14015550143', eligibility: 'retired' },
      { e164: '+14015550144', eligibility: 'usable' },
    ]);
  });

  it('names every field at fault and writes nothing', async () => {
    const firmId = await addFirm();
    const refused = await updateFirmBasics(salesperson(), {
      firmId,
      phone: { number: '12' },
      regionCode: 'Texas',
      timeZone: 'Mars/Olympus_Mons',
      locality: 'x'.repeat(121),
    });
    expect(refused).toEqual({
      ok: false,
      reason: 'invalid_input',
      issues: [
        { field: 'phone', code: 'phone_invalid' },
        { field: 'locality', code: 'too_long' },
        { field: 'regionCode', code: 'region_code_invalid' },
        { field: 'timeZone', code: 'time_zone_invalid' },
      ],
    });
    const { rows } = await database.session.query<{ region_code: string | null }>('SELECT region_code FROM firms WHERE id = $1', [firmId]);
    expect(rows[0]?.region_code).toBeNull();
  });

  it('is the firm’s assignee’s or an admin’s to change, like every other edit', async () => {
    const created = await createFirm(as(database.session, 'admin'), { name: 'Unassigned Test Realty' });
    if (!created.ok) throw new Error(created.reason);
    expect(await updateFirmBasics(salesperson(), { firmId: created.value.id, regionCode: 'RI' })).toEqual({
      ok: false,
      reason: 'not_assigned',
    });
    expect((await updateFirmBasics(as(database.session, 'admin'), { firmId: created.value.id, regionCode: 'RI' })).ok).toBe(true);
  });
});
