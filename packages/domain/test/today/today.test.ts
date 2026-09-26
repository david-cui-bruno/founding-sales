import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import type { SessionQueryable } from '../../db/queryable.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { databaseNow } from '../../policy/clock.ts';
import { listApplicableHolds } from '../../policy/holds.ts';
import { completeCallback, createCallback } from '../../dial/callbacks.ts';
import { reassignFirm } from '../../crm/firms.ts';
import { localParts } from '../../src/rules/localClock.ts';
import { buildTodaySnapshot } from '../../today/build.ts';
import { readTodayFirm, readTodayList } from '../../today/dto.ts';
import { businessDateOf, listTodayItems, upsertTodayItem } from '../../today/snapshots.ts';
import { DEFAULT_SNOOZE_REASON, cancelTodaySnooze, snoozeTodayItem } from '../../today/snooze.ts';
import { TODAY_ALGORITHM_VERSION } from '../../today/types.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';

/**
 * The Today list against a real PostgreSQL (specification 8.2, 8.3, Appendix A,
 * Appendix D, Appendix G 8 and 33).
 *
 * Everything here is a rule the database has to keep whatever the application does:
 * one card per firm, the card's lane taken from its unfinished items, the promotion
 * committed with the event that caused it, the transfer that moves work rather than
 * copying it, and two workspaces that never see each other's lists.
 *
 * Every instant is computed from the database's own clock and the workspace's own
 * zone rather than written down. The callback promotion trigger asks the database
 * what today is, so a fixture with a hard-coded date would test agreement with a
 * calendar rather than agreement with the trigger.
 *
 * No real business name, address or number appears. `example.test` is reserved by
 * RFC 6761; the numbers are in the NANP 555-01XX fictional block.
 */

let database: TestDatabase;
let seeded: TwoWorkspaces;
let crm: SeededCrm;
let now = '';
let businessDate = '';

const contextFor = (
  workspaceId: string,
  userId: string,
  role: 'admin' | 'salesperson',
  db: SessionQueryable = database.session,
): RepositoryContext => repositoryContext(workspaceScope(workspaceId, { kind: 'user', userId, role }), db);

const salesperson = (): RepositoryContext =>
  contextFor(seeded.alpha.workspaceId, seeded.alpha.salesperson.userId, 'salesperson');
const admin = (): RepositoryContext => contextFor(seeded.alpha.workspaceId, seeded.alpha.admin.userId, 'admin');
const betaSalesperson = (): RepositoryContext =>
  contextFor(seeded.beta.workspaceId, seeded.beta.salesperson.userId, 'salesperson');
const worker = (workspaceId: string): RepositoryContext =>
  repositoryContext(workspaceScope(workspaceId, { kind: 'system', component: 'worker' }), database.session);

/** `HH:MM` on the workspace's current business date, as a UTC instant. */
async function localInstant(time: string): Promise<string> {
  const { rows } = await database.session.query<{ at: Date }>(
    `SELECT (($2::date + $3::time) AT TIME ZONE w.business_time_zone) AS at
       FROM workspaces w WHERE w.id = $1`,
    [seeded.alpha.workspaceId, businessDate, time],
  );
  const at = rows[0]?.at;
  if (at === undefined) throw new Error('no instant');
  return at.toISOString();
}

const inDays = (days: number): string => new Date(Date.parse(now) + days * 86_400_000).toISOString();

async function clearToday(): Promise<void> {
  await database.session.query('DELETE FROM today_items');
  await database.session.query('DELETE FROM today_snoozes');
  await database.session.query('DELETE FROM today_snapshots');
  await database.session.query('DELETE FROM callbacks');
}

async function buildBoth(): Promise<void> {
  for (const workspaceId of [seeded.alpha.workspaceId, seeded.beta.workspaceId]) {
    await buildTodaySnapshot(worker(workspaceId), { businessDate, now });
  }
}

/**
 * A confirmed callback, created the way section 9.1 creates one.
 *
 * The local fields are the due instant's own wall clock in the source zone. Until lane
 * g79 this fixture sent 14:00 beside whatever instant the test wanted, and the server
 * stored both without noticing they disagreed — audit item C18. `createCallback` now
 * resolves the local fields itself and refuses a `dueAt` that is not their answer.
 */
async function seedCallback(
  context: RepositoryContext,
  input: { readonly firmId: string; readonly contactId?: string; readonly dueAt: string },
): Promise<string> {
  const wall = localParts(input.dueAt, 'America/New_York');
  const created = await createCallback(context, {
    firmId: input.firmId,
    ...(input.contactId === undefined ? {} : { contactId: input.contactId }),
    assignedUserId: seeded.alpha.salesperson.userId,
    localDate: wall.date,
    localTime: `${String(wall.hour).padStart(2, '0')}:${String(wall.minute).padStart(2, '0')}`,
    sourceTimeZone: 'America/New_York',
    dueAt: input.dueAt,
  });
  if (!created.ok) throw new Error(`the callback fixture was refused: ${created.reason}`);
  return created.value.id;
}

beforeAll(async () => {
  database = await createTestDatabase();
  seeded = await seedTwoWorkspaces(database.session);
  crm = await seedCrm(database.session, seeded);
  now = await databaseNow(salesperson());
  businessDate = await businessDateOf(salesperson(), now);
});

afterAll(async () => {
  await database.drop();
});

describe('the business date comes from the workspace zone', () => {
  it('uses the configurable workspace business zone, not the host, and not UTC', async () => {
    const context = salesperson();
    // 00:30 UTC on the 22nd is still the 21st in America/New_York (Appendix D).
    expect(await businessDateOf(context, '2026-09-22T00:30:00.000Z')).toBe('2026-09-21');
    await database.session.query('UPDATE workspaces SET business_time_zone = $2 WHERE id = $1', [
      seeded.alpha.workspaceId,
      'Europe/London',
    ]);
    expect(await businessDateOf(context, '2026-09-22T00:30:00.000Z')).toBe('2026-09-22');
    await database.session.query('UPDATE workspaces SET business_time_zone = $2 WHERE id = $1', [
      seeded.alpha.workspaceId,
      'America/New_York',
    ]);
  });
});

describe('scenario 33: many contacts at one firm are one card', () => {
  beforeAll(async () => {
    await clearToday();
    // Four more people at the seeded firm, each with a due email of their own.
    for (const name of ['Alex Placeholder', 'Bailey Placeholder', 'Casey Placeholder', 'Drew Placeholder']) {
      await database.session.query('INSERT INTO contacts (workspace_id, firm_id, full_name) VALUES ($1, $2, $3)', [
        seeded.alpha.workspaceId,
        crm.alpha.firmId,
        name,
      ]);
    }
    await buildBoth();

    const { rows } = await database.session.query<{ id: string }>(
      'SELECT id FROM contacts WHERE workspace_id = $1 AND firm_id = $2 ORDER BY full_name',
      [seeded.alpha.workspaceId, crm.alpha.firmId],
    );
    const context = worker(seeded.alpha.workspaceId);
    let minute = 0;
    for (const row of rows) {
      minute += 1;
      await upsertTodayItem(context, {
        businessDate,
        firmId: crm.alpha.firmId,
        contactId: row.id,
        itemKey: `step-execution:${row.id}`,
        kind: 'email_due',
        dueAt: await localInstant(`09:0${String(minute)}`),
        sourceKind: 'step_execution',
        automated: true,
      });
    }
  });

  it('shows the firm once, with the aggregate counts on its card', async () => {
    const list = await readTodayList(salesperson(), { now });
    const cards = list.cards.filter(card => card.firmId === crm.alpha.firmId);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.counts).toEqual({ replies: 0, emailsDue: 5, callsDue: 0 });
  });

  it('expands to one task per contact, ordered by lane then due instant', async () => {
    const page = await readTodayFirm(salesperson(), { firmId: crm.alpha.firmId, now });
    // Five people with an email due, plus the firm's own new-firm task.
    expect(page?.tasks).toHaveLength(6);
    const emails = page?.tasks.filter(task => task.kind === 'email_due') ?? [];
    expect(emails).toHaveLength(5);
    expect(new Set(emails.map(task => task.contactId)).size).toBe(5);

    // Lane precedence first: the new-firm task is the oldest instant on the card and
    // is still last, because lane 4 comes after lane 3.
    expect(page?.tasks.at(-1)?.kind).toBe('new_firm');
    const dueAts = emails.map(task => task.dueAt);
    expect([...dueAts].sort()).toEqual(dueAts);
  });

  it('keeps the firm visible while one unfinished item remains', async () => {
    const items = await listTodayItems(salesperson(), { businessDate, firmId: crm.alpha.firmId });
    const first = items[0];
    expect(first).toBeDefined();
    await database.session.query(
      "UPDATE today_items SET status = 'completed', completed_at = now() WHERE workspace_id = $1 AND id = $2",
      [seeded.alpha.workspaceId, first?.id],
    );
    const after = await readTodayList(salesperson(), { now });
    expect(after.cards.find(entry => entry.firmId === crm.alpha.firmId)?.counts.emailsDue).toBe(4);
  });

  it('never leaks into the other workspace, whose firm has the same name', async () => {
    const beta = await readTodayList(betaSalesperson(), { now });
    expect(beta.cards.map(card => card.firmId)).not.toContain(crm.alpha.firmId);
    expect(beta.cards.every(card => card.counts.emailsDue === 0)).toBe(true);
  });
});

describe('determinism', () => {
  it('two builds from the same data produce the same list', async () => {
    const first = await readTodayList(salesperson(), { now });
    await buildBoth();
    expect(await readTodayList(salesperson(), { now })).toEqual(first);
  });

  it('a rebuild never reshuffles the cards', async () => {
    const before = (await readTodayList(salesperson(), { now })).cards.map(card => card.firmId);
    for (let attempt = 0; attempt < 3; attempt += 1) await buildBoth();
    expect((await readTodayList(salesperson(), { now })).cards.map(card => card.firmId)).toEqual(before);
  });

  it('a rebuild does not reopen a finished task', async () => {
    const items = await listTodayItems(salesperson(), {
      businessDate,
      firmId: crm.alpha.firmId,
      includeFinished: true,
    });
    expect(items.some(item => item.status === 'completed')).toBe(true);
  });
});

describe('promotions commit with their source event (8.2, Appendix A)', () => {
  let callbackDueAt = '';

  beforeAll(async () => {
    await clearToday();
    await buildBoth();
    callbackDueAt = await localInstant('16:00');
  });

  it('a callback confirmed today puts its firm in the callback lane at once', async () => {
    const before = await readTodayList(salesperson(), { now });
    expect(before.cards.find(card => card.firmId === crm.alpha.firmId)?.lane).toBe('new_firm');

    await seedCallback(salesperson(), {
      firmId: crm.alpha.firmId,
      contactId: crm.alpha.contactId,
      dueAt: callbackDueAt,
    });

    const card = (await readTodayList(salesperson(), { now })).cards.find(
      entry => entry.firmId === crm.alpha.firmId,
    );
    expect(card?.lane).toBe('callback');
    expect(card?.dueAt).toBe(callbackDueAt);
  });

  it('rolls the Today entry back with the transaction that created the callback', async () => {
    const rolledBack = await localInstant('17:30');
    await database.session.query('BEGIN');
    await seedCallback(salesperson(), { firmId: crm.alpha.firmId, dueAt: rolledBack });
    await database.session.query('ROLLBACK');

    const items = await listTodayItems(salesperson(), { businessDate, firmId: crm.alpha.firmId });
    expect(items.some(item => item.dueAt === rolledBack)).toBe(false);
  });

  it('completing the callback takes its task off the list', async () => {
    const { rows } = await database.session.query<{ id: string }>(
      "SELECT id FROM callbacks WHERE workspace_id = $1 AND status = 'open' ORDER BY due_at LIMIT 1",
      [seeded.alpha.workspaceId],
    );
    const callbackId = rows[0]?.id ?? '';
    expect(await completeCallback(salesperson(), { callbackId })).toMatchObject({ ok: true });

    const items = await listTodayItems(salesperson(), {
      businessDate,
      firmId: crm.alpha.firmId,
      includeFinished: true,
    });
    expect(items.find(item => item.itemKey === `callback:${callbackId}`)?.status).toBe('completed');
  });

  it('a promoted reply takes the firm to the reply lane over everything else', async () => {
    // Latest instant on the card, and still first: lane precedence beats the clock.
    const late = await localInstant('23:00');
    await upsertTodayItem(worker(seeded.alpha.workspaceId), {
      businessDate,
      firmId: crm.alpha.firmId,
      contactId: crm.alpha.contactId,
      itemKey: 'reply-message:g7-placeholder',
      kind: 'reply',
      dueAt: late,
      sourceKind: 'reply_message',
    });
    const card = (await readTodayList(salesperson(), { now })).cards.find(
      entry => entry.firmId === crm.alpha.firmId,
    );
    expect(card?.lane).toBe('reply');
    expect(card?.dueAt).toBe(late);
    expect(card?.counts.replies).toBe(1);
  });

  it('a rebuild leaves the promoted reply alone: no source of this build produced it', async () => {
    await buildBoth();
    const items = await listTodayItems(salesperson(), { businessDate, firmId: crm.alpha.firmId });
    expect(items.find(item => item.itemKey === 'reply-message:g7-placeholder')?.status).toBe('open');
  });
});

describe('snooze (8.2)', () => {
  let manualItemId = '';
  let automatedItemId = '';

  beforeAll(async () => {
    await clearToday();
    await buildBoth();
    const context = worker(seeded.alpha.workspaceId);
    manualItemId = await upsertTodayItem(context, {
      businessDate,
      firmId: crm.alpha.firmId,
      itemKey: 'step-execution:manual-call',
      kind: 'call_due',
      dueAt: await localInstant('11:00'),
      sourceKind: 'step_execution',
      automated: false,
    });
    automatedItemId = await upsertTodayItem(context, {
      businessDate,
      firmId: crm.alpha.firmId,
      itemKey: 'step-execution:automated-email',
      kind: 'email_due',
      dueAt: await localInstant('12:00'),
      sourceKind: 'step_execution',
      automated: true,
    });
  });

  it('refuses a snooze with no future return instant', async () => {
    expect(
      await snoozeTodayItem(salesperson(), {
        itemId: manualItemId,
        reason: 'Waiting on their board',
        returnAt: inDays(-1),
      }),
    ).toEqual({ ok: false, reason: 'snooze_return_not_future' });
  });

  it('a manual task still needs its return instant', async () => {
    expect(await snoozeTodayItem(salesperson(), { itemId: manualItemId, reason: 'Waiting on their board' })).toEqual({
      ok: false,
      reason: 'snooze_return_required',
    });
  });

  it('snoozes a manual task without a reason (stored as "snoozed") and takes it off the card until it returns', async () => {
    const outcome = await snoozeTodayItem(salesperson(), { itemId: manualItemId, reason: '   ', returnAt: inDays(2) });
    expect(outcome).toMatchObject({ ok: true, value: { outcome: 'snoozed' } });
    const stored = await database.session.query<{ reason: string }>(
      `SELECT reason FROM today_snoozes WHERE item_key = 'step-execution:manual-call' AND cancelled_at IS NULL`,
    );
    expect(stored.rows.map(row => row.reason)).toEqual([DEFAULT_SNOOZE_REASON]);

    const items = await listTodayItems(salesperson(), { businessDate, firmId: crm.alpha.firmId });
    expect(items.find(item => item.id === manualItemId)?.status).toBe('snoozed');
    expect(
      (await readTodayList(salesperson(), { now })).cards.find(entry => entry.firmId === crm.alpha.firmId)?.counts
        .callsDue,
    ).toBe(0);
  });

  it('an automated send is never snoozed; delaying it records a hold instead', async () => {
    const outcome = await snoozeTodayItem(salesperson(), {
      itemId: automatedItemId,
      reason: 'Their office is closed this week',
      returnAt: inDays(2),
    });
    expect(outcome).toMatchObject({ ok: true, value: { outcome: 'held' } });
    if (!outcome.ok) throw new Error('expected a hold');
    const held = outcome.value;
    if (held.outcome !== 'held') throw new Error('expected a hold');

    const holds = await listApplicableHolds(salesperson(), { actionKind: 'email_send', firmId: crm.alpha.firmId });
    expect(holds.map(hold => hold.id)).toContain(held.holdId);
    expect(holds.find(hold => hold.id === held.holdId)?.reasonCode).toBe('scoped_pause');

    // And no snooze row was written for it: an automated send has no return instant.
    const { rows } = await database.session.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM today_snoozes WHERE workspace_id = $1 AND item_key = 'step-execution:automated-email'",
      [seeded.alpha.workspaceId],
    );
    expect(rows[0]?.count).toBe('0');

    // C22: a pause, not a hidden hold. The task stays on the card, marked
    // with the hold its Resume control releases, and pressing Pause again answers with
    // the same hold rather than stacking a second one.
    const items = await listTodayItems(salesperson(), { businessDate, firmId: crm.alpha.firmId });
    expect(items.find(item => item.id === automatedItemId)?.status).toBe('open');
    const page = await readTodayFirm(salesperson(), { firmId: crm.alpha.firmId, now });
    expect(page?.tasks.find(task => task.itemId === automatedItemId)?.pauseHoldId).toBe(held.holdId);
    const again = await snoozeTodayItem(salesperson(), { itemId: automatedItemId, reason: 'Still closed' });
    expect(again).toMatchObject({ ok: true, value: { outcome: 'held', holdId: held.holdId } });
  });


  it('survives a rebuild: a snoozed task does not come back before its return instant', async () => {
    await buildBoth();
    const items = await listTodayItems(salesperson(), { businessDate, firmId: crm.alpha.firmId });
    expect(items.find(item => item.id === manualItemId)?.status).toBe('snoozed');
  });

  it('cancelling the snooze puts the task back', async () => {
    const { rows } = await database.session.query<{ id: string }>(
      'SELECT id FROM today_snoozes WHERE workspace_id = $1 AND cancelled_at IS NULL LIMIT 1',
      [seeded.alpha.workspaceId],
    );
    expect(await cancelTodaySnooze(salesperson(), { snoozeId: rows[0]?.id ?? '' })).toMatchObject({ ok: true });
    const items = await listTodayItems(salesperson(), { businessDate, firmId: crm.alpha.firmId });
    expect(items.find(item => item.id === manualItemId)?.status).toBe('open');
  });
});

describe('reassignment transfers unfinished entries (Appendix A)', () => {
  beforeAll(async () => {
    await clearToday();
    await buildBoth();
  });

  it('moves the entries to the new assignee rather than copying them', async () => {
    expect((await readTodayList(salesperson(), { now })).cards.some(card => card.firmId === crm.alpha.firmId)).toBe(
      true,
    );

    expect(
      await reassignFirm(admin(), { firmId: crm.alpha.firmId, toUserId: seeded.alpha.admin.userId }),
    ).toMatchObject({ ok: true });

    // One entry, and it is the admin's now.
    const { rows } = await database.session.query<{ count: string; assignee: string | null }>(
      `SELECT count(*)::text AS count, max(assigned_user_id::text) AS assignee
         FROM today_snapshots WHERE workspace_id = $1 AND firm_id = $2`,
      [seeded.alpha.workspaceId, crm.alpha.firmId],
    );
    expect(rows[0]?.count).toBe('1');
    expect(rows[0]?.assignee).toBe(seeded.alpha.admin.userId);

    expect((await readTodayList(salesperson(), { now })).cards.some(card => card.firmId === crm.alpha.firmId)).toBe(
      false,
    );
  });

  it('an admin sees every list; a salesperson sees only their own', async () => {
    const asAdmin = await readTodayList(admin(), { now });
    const asSalesperson = await readTodayList(salesperson(), { now });
    expect(asAdmin.cards.length).toBeGreaterThan(asSalesperson.cards.length);
    expect(asAdmin.cards.some(card => card.firmId === crm.alpha.firmId)).toBe(true);
    // And the colleague cannot expand a card that is no longer theirs.
    expect(await readTodayFirm(salesperson(), { firmId: crm.alpha.firmId, now })).toBeNull();
  });
});

describe('the snapshot itself', () => {
  it('records the algorithm version the job key names', async () => {
    const { rows } = await database.session.query<{ algorithm_version: string }>(
      'SELECT DISTINCT algorithm_version FROM today_snapshots WHERE workspace_id = $1',
      [seeded.alpha.workspaceId],
    );
    expect(rows.map(row => row.algorithm_version)).toEqual([TODAY_ALGORITHM_VERSION]);
  });

  it('agrees with the database about which algorithm version that is', async () => {
    const { rows } = await database.session.query<{ version: string }>(
      'SELECT today_algorithm_version() AS version',
    );
    expect(rows[0]?.version).toBe(TODAY_ALGORITHM_VERSION);
  });

  it('refuses a second card for the same firm on the same date', async () => {
    let thrown: unknown = null;
    try {
      await database.session.query(
        `INSERT INTO today_snapshots (workspace_id, snapshot_date, firm_id, lane, sort_at)
         VALUES ($1, $2::date, $3, 'new_firm', now())`,
        [seeded.alpha.workspaceId, businessDate, crm.alpha.firmId],
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ constraint: 'today_snapshots_pkey' });
  });
});
