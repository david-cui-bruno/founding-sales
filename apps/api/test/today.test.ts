import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repositoryContext, workspaceScope } from '@fss/domain/db';
import { buildTodaySnapshot, businessDateOf, promoteTodayItem } from '@fss/domain/today';
import { localNoopSuppressionJournal } from '../src/journal/index.ts';
import { dispatch, type ApiRequest } from '../src/server.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';

/**
 * The Today endpoints, through the real dispatcher with real sessions
 * (specification 8.2, 14.1, Appendix F).
 *
 * The rules have their own tests against a real PostgreSQL in `@fss/domain`; what is
 * proved here is the wiring, and four pieces of it are this lane's alone:
 *
 *   * the list comes back in exactly the shape the Mac's encrypted cache accepts, so
 *     a field added on this side is a parse failure on that one rather than something
 *     that ends up on a laptop (5.3);
 *   * a colleague's card is `not_found` and not a redacted card;
 *   * the snooze is a command with a receipt, and a replay returns the first answer
 *     rather than snoozing again (5.3);
 *   * the same endpoint holds an automated send instead of snoozing it, and the
 *     *server* decides which, because a client that had the choice would be the thing
 *     that let a send go out on time with nobody expecting it (8.2).
 *
 * No real business name or number appears; `example.test` is reserved by RFC 6761 and
 * the numbers are in the NANP 555-01XX fictional block.
 */
describe('the Today routes', () => {
  let fixture: AuthFixture;
  let assigneeToken: string;
  let adminToken: string;
  let strangerToken: string;
  let assigneeUserId: string;
  let firmId: string;
  let contactId: string;
  let businessDate = '';
  let manualItemId = '';
  let automatedItemId = '';

  const options = () => ({
    session: fixture.db,
    supportedClientVersions: fixture.deps.config.supportedClientVersions,
    sendingEnabled: false,
    expectedSystemGeneration: null,
    auth: fixture.deps,
    upgradeUrl: 'https://callie.example/downloads/mac',
    suppressionJournal: localNoopSuppressionJournal(),
  });

  const post = async (
    path: string,
    token: string | null,
    body: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const request: ApiRequest = {
      method: 'POST',
      path,
      query: new URLSearchParams(),
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
      body,
    };
    const result = await dispatch(request, options());
    return { status: result.status, body: result.body as Record<string, unknown> };
  };

  const get = async (path: string, token: string | null): Promise<{ status: number; body: Record<string, unknown> }> => {
    const result = await dispatch(
      {
        method: 'GET',
        path,
        query: new URLSearchParams(),
        headers: token === null ? {} : { authorization: `Bearer ${token}` },
        body: undefined,
      },
      options(),
    );
    return { status: result.status, body: result.body as Record<string, unknown> };
  };

  const command = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    commandId: randomUUID(),
    clientVersion: CURRENT_CLIENT_VERSION,
    ...extra,
  });

  const resultOf = (answer: { body: Record<string, unknown> }): Record<string, unknown> =>
    (answer.body['result'] ?? {}) as Record<string, unknown>;

  const worker = () =>
    repositoryContext(
      workspaceScope(fixture.alpha.workspaceId, { kind: 'system', component: 'worker' }),
      fixture.db,
    );

  beforeAll(async () => {
    fixture = await createAuthFixture();
    assigneeUserId = fixture.alpha.salesperson.userId;
    assigneeToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)).accessToken;
    adminToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;

    const strangerSub = `sub-${randomUUID()}`;
    const strangerEmail = `stranger-today@${fixture.hostedDomain}`;
    const stranger = await fixture.db.query<{ id: string }>(
      "INSERT INTO users (google_sub, email, display_name) VALUES ($1, $2, 'Stranger') RETURNING id",
      [strangerSub, strangerEmail],
    );
    await fixture.db.query(
      "INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'salesperson')",
      [fixture.alpha.workspaceId, stranger.rows[0]?.id],
    );
    strangerToken = (
      await issueSessionFor(fixture, fixture.alpha, { googleSub: strangerSub, email: strangerEmail }, {
        deviceLabel: 'Other Mac',
      })
    ).accessToken;

    const created = await post(
      '/firms/create',
      adminToken,
      command({ name: 'Northwind Test Holdings', regionCode: 'RI', assignedUserId: assigneeUserId }),
    );
    expect(created.status).toBe(200);
    firmId = String(resultOf(created)['id']);
    const contact = await post('/contacts/create', assigneeToken, command({ firmId, fullName: 'Dana Example' }));
    expect(contact.status).toBe(200);
    contactId = String(resultOf(contact)['id']);

    const clock = await fixture.db.query<{ now: Date }>('SELECT now() AS now');
    const now = (clock.rows[0]?.now ?? new Date()).toISOString();
    businessDate = await businessDateOf(worker(), now);
    await buildTodaySnapshot(worker(), { businessDate, now });

    manualItemId = await promoteTodayItem(worker(), {
      businessDate,
      firmId,
      contactId,
      itemKey: 'step-execution:manual-call',
      kind: 'call_due',
      dueAt: now,
      sourceKind: 'step_execution',
      automated: false,
    });
    automatedItemId = await promoteTodayItem(worker(), {
      businessDate,
      firmId,
      contactId,
      itemKey: 'step-execution:automated-email',
      kind: 'email_due',
      dueAt: now,
      sourceKind: 'step_execution',
      automated: true,
    });
  });

  afterAll(async () => {
    await fixture.stop();
  });

  it('refuses every path in this lane without a session', async () => {
    expect((await get('/today', null)).status).toBe(401);
    for (const path of ['/today/firm', '/today/snooze', '/today/snooze/cancel']) {
      expect((await post(path, null, command())).status, path).toBe(401);
    }
  });

  it('answers the list in the shape the Mac caches, and nothing else', async () => {
    const answer = await get('/today', assigneeToken);
    expect(answer.status).toBe(200);
    expect(Object.keys(answer.body).sort()).toEqual([
      'businessTimeZone',
      'cards',
      'snapshotDate',
      'workspaceId',
    ]);
    expect(answer.body['snapshotDate']).toBe(businessDate);
    expect(answer.body['businessTimeZone']).toBe('America/New_York');

    const cards = answer.body['cards'] as Record<string, unknown>[];
    expect(cards).toHaveLength(1);
    const card = cards[0] ?? {};
    expect(Object.keys(card).sort()).toEqual(['counts', 'dueAt', 'firmId', 'firmName', 'lane']);
    expect(card['firmId']).toBe(firmId);
    expect(card['counts']).toEqual({ replies: 0, emailsDue: 1, callsDue: 1, linkedInDue: 0 });
  });

  it('expands a card into its contact tasks', async () => {
    const answer = await post('/today/firm', assigneeToken, { firmId });
    expect(answer.status).toBe(200);
    const tasks = answer.body['tasks'] as Record<string, unknown>[];
    expect(tasks).toHaveLength(3);
    expect(tasks.filter(task => task['automated'] === true)).toHaveLength(1);
  });

  it('gives a colleague nothing at all, rather than a redacted card', async () => {
    const list = await get('/today', strangerToken);
    expect(list.status).toBe(200);
    expect(list.body['cards']).toEqual([]);
    // Not a 403: a refusal that named the firm would say a colleague has work on it.
    expect((await post('/today/firm', strangerToken, { firmId })).status).toBe(404);
  });

  it('gives an admin every list', async () => {
    const answer = await get('/today', adminToken);
    expect((answer.body['cards'] as unknown[]).length).toBe(1);
    expect((await post('/today/firm', adminToken, { firmId })).status).toBe(200);
  });

  it('refuses a malformed expansion and a wrong method', async () => {
    expect((await post('/today/firm', assigneeToken, { firm: firmId })).status).toBe(400);
    expect((await post('/today', assigneeToken, {})).status).toBe(405);
    expect((await get('/today/firm', assigneeToken)).status).toBe(405);
  });

  it('snoozes a manual task, and replays the same answer for the same command id', async () => {
    const returnAt = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const body = command({ itemId: manualItemId, reason: 'Waiting on their board', returnAt });
    const first = await post('/today/snooze', assigneeToken, body);
    expect(first.status).toBe(200);
    expect(resultOf(first)['outcome']).toBe('snoozed');

    const replay = await post('/today/snooze', assigneeToken, body);
    expect(replay.status).toBe(200);
    expect(replay.body['replayed']).toBe(true);
    expect(resultOf(replay)['outcome']).toBe('snoozed');

    // One snooze row, not two.
    const { rows } = await fixture.db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM today_snoozes WHERE workspace_id = $1',
      [fixture.alpha.workspaceId],
    );
    expect(rows[0]?.count).toBe('1');
  });

  it('refuses a snooze with no reason before it reaches the domain at all', async () => {
    const returnAt = new Date(Date.now() + 2 * 86_400_000).toISOString();
    expect(
      (await post('/today/snooze', assigneeToken, command({ itemId: manualItemId, reason: '  ', returnAt }))).status,
    ).toBe(400);
  });

  it('holds an automated send rather than snoozing it, and the server decides which', async () => {
    const returnAt = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const answer = await post(
      '/today/snooze',
      assigneeToken,
      command({ itemId: automatedItemId, reason: 'Their office is closed this week', returnAt }),
    );
    expect(answer.status).toBe(200);
    // The request said nothing about a hold. The item's `automated` column did.
    expect(resultOf(answer)['outcome']).toBe('held');
    expect(resultOf(answer)['blockedActionKind']).toBe('email_send');
  });

  it('refuses a snooze of a task that is not open, as a value with a reason', async () => {
    const returnAt = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const answer = await post(
      '/today/snooze',
      assigneeToken,
      command({ itemId: automatedItemId, reason: 'Again', returnAt }),
    );
    expect(answer.status).toBe(409);
    expect(answer.body['reason']).toBe('item_not_open');
  });

  it('cancels a snooze and puts the task back', async () => {
    const { rows } = await fixture.db.query<{ id: string }>(
      'SELECT id FROM today_snoozes WHERE workspace_id = $1 AND cancelled_at IS NULL LIMIT 1',
      [fixture.alpha.workspaceId],
    );
    const answer = await post('/today/snooze/cancel', assigneeToken, command({ snoozeId: rows[0]?.id }));
    expect(answer.status).toBe(200);

    const list = await get('/today', assigneeToken);
    const card = (list.body['cards'] as Record<string, unknown>[])[0] ?? {};
    expect(card['counts']).toMatchObject({ callsDue: 1 });
  });

  it('refuses a snooze id that is nobody’s', async () => {
    const answer = await post(
      '/today/snooze/cancel',
      assigneeToken,
      command({ snoozeId: '00000000-0000-4000-8000-000000000000' }),
    );
    expect(answer.status).toBe(409);
    expect(answer.body['reason']).toBe('snooze_unknown');
  });
});
