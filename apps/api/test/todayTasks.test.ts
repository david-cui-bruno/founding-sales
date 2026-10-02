import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { todayFirmResponseSchema, todayListResponseSchema } from '@fss/contracts';
import { repositoryContext, workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import { buildTodaySnapshot } from '@fss/domain/today/build.ts';
import { businessDateOf } from '@fss/domain/today/snapshots.ts';
import { localNoopSuppressionJournal } from '../src/journal/index.ts';
import { dispatch, type ApiRequest } from '../src/server.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';
import { seedContact, seedFirm } from './support/crmSeed.ts';
import {
  todayFirmResponseSchema as legacyTodayFirmResponseSchema,
  todayListResponseSchema as legacyTodayListResponseSchema,
} from './support/today134dc811.ts';

/**
 * Slice 3a, lane B — B-10: Today's call tasks, negotiated, read by the legacy parser.
 *
 * A call task (`call_tasks`, migration 0036) is a Today item of kind `task` in the due-work
 * lane. The installed desktop's contract (134dc811, frozen in `support/today134dc811.ts`)
 * has no such kind, so `include=tasks` is negotiated on both reads: without it a task is in
 * no card, count or expansion — a firm with nothing else open has no card, and a firm with
 * other work keeps the lane and instant that work gives it. With it the task is there, with
 * its id and words, and `POST /today/tasks/complete` marks it done.
 *
 * Two firms: Alpha has a task and the new-firm item every unopened firm has; Bravo, whose
 * only opportunity was lost, has nothing but its task.
 */
describe('B-10: Today tasks, negotiated, against the legacy parser', () => {
  let fixture: AuthFixture;
  let token: string;
  let alphaId: string;
  let bravoId: string;
  let alphaTaskId: string;
  let bravoTaskId: string;
  let alphaCreatedAt: string;

  const options = () => ({
    session: fixture.db,
    supportedClientVersions: fixture.deps.config.supportedClientVersions,
    sendingEnabled: false,
    auth: fixture.deps,
    upgradeUrl: 'https://callie.example/downloads/mac',
    suppressionJournal: localNoopSuppressionJournal(),
  });

  const call = async (
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    query = '',
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const request: ApiRequest = {
      method,
      path,
      query: new URLSearchParams(query),
      headers: { authorization: `Bearer ${token}` },
      body,
    };
    const result = await dispatch(request, options());
    return { status: result.status, body: JSON.parse(JSON.stringify(result.body ?? null)) as Record<string, unknown> };
  };
  const list = async (query = '') => await call('GET', '/today', undefined, query);
  const expand = async (firmId: string, extra: Record<string, unknown> = {}) =>
    await call('POST', '/today/firm', { firmId, cardVersion: 2, ...extra });
  const cardsOf = (answer: { body: Record<string, unknown> }) => answer.body['cards'] as Record<string, unknown>[];

  const worker = () =>
    repositoryContext(workspaceScope(fixture.alpha.workspaceId, { kind: 'system', component: 'worker' }), fixture.db);

  async function insertTask(firmId: string, contactId: string | null, text: string, dueAt: string): Promise<string> {
    const { rows } = await fixture.db.query<{ id: string }>(
      `INSERT INTO call_tasks (workspace_id, firm_id, contact_id, quote_key, text, due_at, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7) RETURNING id`,
      [
        fixture.alpha.workspaceId,
        firmId,
        contactId,
        `task:${randomUUID().replaceAll('-', '').slice(0, 16)}`,
        text,
        dueAt,
        fixture.alpha.salesperson.userId,
      ],
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('no task');
    return id;
  }

  beforeAll(async () => {
    fixture = await createAuthFixture();
    token = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)).accessToken;
    const assignedUserId = fixture.alpha.salesperson.userId;

    alphaId = await seedFirm(fixture, { name: 'Alpha Tasks Test Firm', regionCode: 'RI', assignedUserId });
    const alphaContact = await seedContact(fixture, { firmId: alphaId, fullName: 'Dana Example' });
    bravoId = await seedFirm(fixture, { name: 'Bravo Tasks Test Firm', regionCode: 'RI', assignedUserId });
    // Bravo's only opportunity was lost: no new-firm item, so its task is all it has.
    const { rows: stages } = await fixture.db.query<{ id: string }>(
      'SELECT id FROM pipeline_stages WHERE workspace_id = $1 ORDER BY position LIMIT 1',
      [fixture.alpha.workspaceId],
    );
    const { rows: lost } = await fixture.db.query<{ id: string }>(
      `INSERT INTO opportunities (workspace_id, firm_id, stage_id, control_mode_changed_at, opened_at, status, closed_at, close_reason)
       VALUES ($1, $2, $3, TIMESTAMPTZ '2026-09-01 12:00:00+00', TIMESTAMPTZ '2026-09-01 12:00:00+00', 'lost',
               TIMESTAMPTZ '2026-09-02 12:00:00+00', 'Not a fit this year')
       RETURNING id`,
      [fixture.alpha.workspaceId, bravoId, stages[0]?.id],
    );
    await fixture.db.query(
      `INSERT INTO opportunity_stage_events (workspace_id, opportunity_id, firm_id, to_stage_id, actor_kind, occurred_at)
       VALUES ($1, $2, $3, $4, 'system', TIMESTAMPTZ '2026-09-01 12:00:00+00')`,
      [fixture.alpha.workspaceId, lost[0]?.id, bravoId, stages[0]?.id],
    );

    const { rows: clock } = await fixture.db.query<{ now: Date; created_at: Date }>(
      'SELECT now() AS now, created_at FROM firms WHERE workspace_id = $1 AND id = $2',
      [fixture.alpha.workspaceId, alphaId],
    );
    const now = clock[0]?.now ?? new Date();
    alphaCreatedAt = (clock[0]?.created_at ?? now).toISOString();
    // Due an hour ago: earlier than Alpha's new-firm item, and due work outranks a new firm,
    // so with tasks Alpha's card is the task's; without, it is the new firm's.
    const dueAt = new Date(now.getTime() - 3_600_000).toISOString();
    alphaTaskId = await insertTask(alphaId, alphaContact, 'Send overview to Dana Example', dueAt);
    bravoTaskId = await insertTask(bravoId, null, 'Send the pricing sheet', dueAt);
    const businessDate = await businessDateOf(worker(), now.toISOString());
    await buildTodaySnapshot(worker(), { businessDate, now: now.toISOString() });
  });

  afterAll(async () => {
    await fixture.stop();
  });

  it('without include=tasks: the legacy parser reads the list and the expansion, and no task is in any card, count or expansion', async () => {
    const answer = await list();
    expect(answer.status).toBe(200);
    const parsed = legacyTodayListResponseSchema.parse(answer.body);
    expect(parsed.cards.map(card => card.firmId)).toEqual([alphaId]);
    // Alpha's card is its new-firm item's: the lane and instant a task-free day gives it.
    expect(parsed.cards[0]).toMatchObject({ lane: 'new_firm', dueAt: alphaCreatedAt, counts: { replies: 0, emailsDue: 0, callsDue: 0 } });

    for (const extra of [{}, { cardVersion: undefined }]) {
      const page = await expand(alphaId, extra);
      expect(page.status).toBe(200);
      const card = legacyTodayFirmResponseSchema.parse(page.body);
      expect(card.lane).toBe('new_firm');
      expect(card.tasks.map(task => task.kind)).toEqual(['new_firm']);
      expect(JSON.stringify(page.body)).not.toContain(alphaTaskId);
    }
    // Bravo has nothing but a task: no card.
    expect((await expand(bravoId)).status).toBe(404);
    // An unknown include is ignored, not a task.
    expect(cardsOf(await list('include=everything')).map(card => card['firmId'])).toEqual([alphaId]);
  });

  it('with include=tasks: both reads carry the tasks, which the legacy parser could not read', async () => {
    const answer = await list('include=tasks');
    expect(answer.status).toBe(200);
    const parsed = todayListResponseSchema.parse(answer.body);
    expect(new Set(parsed.cards.map(card => card.firmId))).toEqual(new Set([alphaId, bravoId]));
    for (const card of parsed.cards) expect(card.lane).toBe('due_work');

    const page = await expand(alphaId, { include: ['tasks'] });
    expect(page.status).toBe(200);
    const card = todayFirmResponseSchema.parse(page.body);
    expect(card.lane).toBe('due_work');
    expect(card.tasks.map(task => [task.kind, task.callTaskId, task.taskText])).toEqual([
      ['task', alphaTaskId, 'Send overview to Dana Example'],
      ['new_firm', null, null],
    ]);
    // What an installed desktop would refuse — which is why it is negotiated.
    expect(legacyTodayFirmResponseSchema.safeParse(page.body).success).toBe(false);
    expect((await expand(bravoId, { include: ['tasks'] })).status).toBe(200);
    // `include` is a closed vocabulary on the POST.
    expect((await expand(alphaId, { include: ['everything'] })).status).toBe(400);
  });

  it('completing a task marks it done, finishes its item, and replays the same answer for the same command id', async () => {
    const body = { commandId: randomUUID(), clientVersion: CURRENT_CLIENT_VERSION, taskId: bravoTaskId };
    const done = await call('POST', '/today/tasks/complete', body);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const result = done.body['result'] as Record<string, unknown>;
    expect(result['taskId']).toBe(bravoTaskId);
    const replay = await call('POST', '/today/tasks/complete', body);
    expect(replay.status).toBe(200);
    expect(replay.body['replayed']).toBe(true);
    expect(replay.body['result']).toEqual(result);

    const { rows } = await fixture.db.query<{ status: string; completed: boolean }>(
      'SELECT status, completed_at IS NOT NULL AS completed FROM call_tasks WHERE id = $1',
      [bravoTaskId],
    );
    expect(rows[0]).toEqual({ status: 'done', completed: true });
    const { rows: items } = await fixture.db.query<{ status: string }>(
      'SELECT status FROM today_items WHERE workspace_id = $1 AND item_key = $2',
      [fixture.alpha.workspaceId, `call-task:${bravoTaskId}`],
    );
    expect(items.map(item => item.status)).toEqual(['completed']);
    // Bravo's only work is finished: no card even with tasks; Alpha's task is still there.
    expect(cardsOf(await list('include=tasks')).map(card => card['firmId'])).toEqual([alphaId]);
    // A different command id on a done task answers its instant.
    const again = await call('POST', '/today/tasks/complete', { ...body, commandId: randomUUID() });
    expect((again.body['result'] as Record<string, unknown>)['completedAt']).toBe(result['completedAt']);
  });
});
