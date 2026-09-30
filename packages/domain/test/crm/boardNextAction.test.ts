import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { readPipelineBoardForActor } from '../../crm/board.ts';
import { readNextActions } from '../../crm/boardNextAction.ts';
import { openOpportunity } from '../../crm/pipeline.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedSequences, type SeededSequences } from '../sequences/support/sequenceFixtures.ts';

/**
 * A board card's next action (Kanban slice K, fold 1): one test per source and one for
 * the earliest-wins rule. Times are fixed; `NOW` is what the read is given.
 */
describe('the board card next action', () => {
  let database: TestDatabase;
  let seeded: TwoWorkspaces;
  let sequences: SeededSequences;
  let admin: RepositoryContext;
  let counter = 0;
  const NOW = new Date('2026-10-01T12:00:00.000Z');

  const q = async <T extends Record<string, unknown>>(sql: string, values: readonly unknown[]): Promise<T[]> =>
    (await database.session.query<T>(sql, [...values])).rows;

  async function firm(): Promise<{ firmId: string; contactId: string; opportunityId: string }> {
    counter += 1;
    const w = seeded.alpha;
    const firmId = (await q<{ id: string }>(
      'INSERT INTO firms (workspace_id, name, assigned_user_id) VALUES ($1, $2, $3) RETURNING id',
      [w.workspaceId, `Next Action Firm ${String(counter)}`, w.salesperson.userId],
    ))[0]?.id ?? '';
    const contactId = (await q<{ id: string }>(
      'INSERT INTO contacts (workspace_id, firm_id, full_name) VALUES ($1, $2, $3) RETURNING id',
      [w.workspaceId, firmId, 'Dana Example'],
    ))[0]?.id ?? '';
    const opened = await openOpportunity(admin, { firmId, stageKey: 'new' });
    if (!opened.ok) throw new Error(opened.reason);
    return { firmId, contactId, opportunityId: opened.value.id };
  }

  const callback = async (firmId: string, dueAt: string, status = 'open'): Promise<void> => {
    const w = seeded.alpha;
    await q(
      `INSERT INTO callbacks (workspace_id, firm_id, assigned_user_id, requested_local_date, source_time_zone, due_at,
                              status, confirmed_at, confirmed_by_user_id, completed_at, completed_by_user_id)
       VALUES ($1, $2, $3, DATE '2026-10-06', 'America/New_York', $4::timestamptz, $5, now(), $3,
               CASE WHEN $5 = 'completed' THEN now() END, CASE WHEN $5 = 'completed' THEN $3::uuid END)`,
      [w.workspaceId, firmId, w.salesperson.userId, dueAt, status],
    );
  };

  const step = async (
    f: { firmId: string; contactId: string; opportunityId: string },
    channel: 'email' | 'call_task',
    dueAt: string,
    state = 'pending',
    enrollmentState = 'active',
  ): Promise<void> => {
    const w = seeded.alpha;
    const s = sequences.alpha;
    const enrollmentId = (await q<{ id: string }>(
      `INSERT INTO sequence_enrollments
         (workspace_id, sequence_version_id, opportunity_id, firm_id, contact_id, assigned_user_id, state,
          ended_at, end_reason, firm_time_zone, holiday_calendar_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $7 IN ('completed','stopped') THEN now() END,
               CASE WHEN $7 IN ('completed','stopped') THEN 'human_reply' END, 'America/New_York', $8) RETURNING id`,
      [w.workspaceId, s.publishedVersionId, f.opportunityId, f.firmId, f.contactId, w.salesperson.userId, enrollmentState, s.calendarVersion],
    ))[0]?.id ?? '';
    await q(
      `INSERT INTO step_executions
         (workspace_id, enrollment_id, step_id, firm_id, contact_id, channel, ordinal, state,
          due_at, not_before, original_due_at, source_zone, rule_version, hold_reason_code)
       VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8::timestamptz, $8::timestamptz, $8::timestamptz,
               'America/New_York', 'elapsed.1', CASE WHEN $7 = 'held' THEN 'daily_cap' END)`,
      [w.workspaceId, enrollmentId, channel === 'email' ? s.emailStepId : s.callStepId, f.firmId, f.contactId, channel, state, dueAt],
    );
  };

  const meeting = async (f: { firmId: string; contactId: string; opportunityId: string }, startsAt: string, state = 'booked'): Promise<void> => {
    counter += 1;
    await q(
      `INSERT INTO meetings (workspace_id, booking_uid, current_booking_uid, firm_id, contact_id, opportunity_id, state,
                             starts_at, ends_at, last_event_at)
       VALUES ($1, $2, $2, $3, $4, $5, $6, $7::timestamptz, $7::timestamptz + interval '30 minutes', now())`,
      [seeded.alpha.workspaceId, `next${String(counter)}`, f.firmId, f.contactId, f.opportunityId, state, startsAt],
    );
  };

  const queued = async (firmId: string, dueAt: string, date = '2026-10-01', kind = 'call_due', status = 'open'): Promise<void> => {
    counter += 1;
    await q(
      `INSERT INTO today_items (workspace_id, snapshot_date, firm_id, item_key, kind, due_at, status, source_kind)
       VALUES ($1, $2::date, $3, $4, $5, $6::timestamptz, $7, 'firm')`,
      [seeded.alpha.workspaceId, date, firmId, `q:${String(counter)}`, kind, dueAt, status],
    );
  };

  const nextOf = async (firmId: string) => (await readNextActions(admin, NOW))[firmId] ?? null;

  beforeAll(async () => {
    database = await createTestDatabase();
    seeded = await seedTwoWorkspaces(database.session);
    sequences = await seedSequences(database.session, seeded);
    admin = repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.admin.userId, role: 'admin' }),
      database.session,
    );
  }, 120_000);
  afterAll(async () => {
    await database.drop();
  });

  it('is null for a firm with nothing next', async () => {
    const f = await firm();
    expect(await nextOf(f.firmId)).toBeNull();
    expect((await readPipelineBoardForActor(admin)).cards[f.firmId]?.nextAction).toBeNull();
  });

  it('source 1: an open callback, "Call back" (a completed one is not next)', async () => {
    const f = await firm();
    await callback(f.firmId, '2026-10-06T18:00:00.000Z', 'completed');
    expect(await nextOf(f.firmId)).toBeNull();
    await callback(f.firmId, '2026-10-06T18:00:00.000Z');
    expect(await nextOf(f.firmId)).toEqual({ kind: 'callback', label: 'Call back', dueAt: '2026-10-06T18:00:00.000Z' });
    expect((await readPipelineBoardForActor(admin)).cards[f.firmId]?.nextAction).toMatchObject({ label: 'Call back' });
  });

  it('source 2: the pending step of an active enrollment, labelled by channel; held or stopped ones are not next', async () => {
    const email = await firm();
    await step(email, 'email', '2026-10-03T14:00:00.000Z');
    expect(await nextOf(email.firmId)).toEqual({ kind: 'follow_up_email', label: 'Follow-up e-mail', dueAt: '2026-10-03T14:00:00.000Z' });
    const call = await firm();
    await step(call, 'call_task', '2026-10-03T15:00:00.000Z');
    expect(await nextOf(call.firmId)).toMatchObject({ kind: 'call', label: 'Call' });
    const notNext = await firm();
    await step(notNext, 'email', '2026-10-03T14:00:00.000Z', 'held');
    await step(notNext, 'email', '2026-10-03T14:00:00.000Z', 'pending', 'stopped');
    expect(await nextOf(notNext.firmId)).toBeNull();
  });

  it('source 3: an upcoming booked or rescheduled meeting, "Demo"; a past or cancelled one is not next', async () => {
    const f = await firm();
    await meeting(f, '2026-09-30T15:00:00.000Z');
    await meeting(f, '2026-10-05T15:00:00.000Z', 'cancelled');
    expect(await nextOf(f.firmId)).toBeNull();
    await meeting(f, '2026-10-07T15:00:00.000Z', 'rescheduled');
    expect(await nextOf(f.firmId)).toEqual({ kind: 'demo', label: 'Demo', dueAt: '2026-10-07T15:00:00.000Z' });
  });

  it('source 4: an open call item in the newest Today snapshot, "Call"; other kinds and older snapshots are not', async () => {
    const f = await firm();
    await queued(f.firmId, '2026-10-01T13:00:00.000Z', '2026-10-01', 'email_due');
    await queued(f.firmId, '2026-10-01T13:00:00.000Z', '2026-10-01', 'call_due', 'cancelled');
    expect(await nextOf(f.firmId)).toBeNull();
    await queued(f.firmId, '2026-10-01T16:00:00.000Z');
    expect(await nextOf(f.firmId)).toEqual({ kind: 'call', label: 'Call', dueAt: '2026-10-01T16:00:00.000Z' });
    // A newer snapshot exists for another firm: this firm's item is from an older one now.
    const other = await firm();
    await queued(other.firmId, '2026-10-02T16:00:00.000Z', '2026-10-02');
    expect(await nextOf(f.firmId)).toBeNull();
    expect(await nextOf(other.firmId)).toMatchObject({ kind: 'call' });
  });

  it('the earliest wins across sources, an overdue one counts, and a tie goes callback, step, demo, queue', async () => {
    const f = await firm();
    await meeting(f, '2026-10-08T15:00:00.000Z');
    await step(f, 'email', '2026-10-06T15:00:00.000Z');
    await callback(f.firmId, '2026-10-07T15:00:00.000Z');
    expect(await nextOf(f.firmId)).toMatchObject({ kind: 'follow_up_email', dueAt: '2026-10-06T15:00:00.000Z' });
    // Overdue is still next, and earlier than everything above.
    await callback(f.firmId, '2026-09-29T15:00:00.000Z');
    expect(await nextOf(f.firmId)).toMatchObject({ kind: 'callback', dueAt: '2026-09-29T15:00:00.000Z' });

    const tie = await firm();
    await meeting(tie, '2026-10-09T15:00:00.000Z');
    await step(tie, 'call_task', '2026-10-09T15:00:00.000Z');
    expect(await nextOf(tie.firmId)).toMatchObject({ kind: 'call' });
    await callback(tie.firmId, '2026-10-09T15:00:00.000Z');
    expect(await nextOf(tie.firmId)).toMatchObject({ kind: 'callback' });
  });

  it('never reads another workspace', async () => {
    const all = await readNextActions(admin, NOW);
    const betaFirms = await q<{ id: string }>('SELECT id FROM firms WHERE workspace_id = $1', [seeded.beta.workspaceId]);
    for (const b of betaFirms) expect(all[b.id]).toBeUndefined();
  });
});
