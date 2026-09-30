import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pipelineBoardResponseSchema } from '@fss/contracts';
import { dispatch, type ApiRequest } from '../src/server.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';
import { seedFirm } from './support/crmSeed.ts';

/**
 * `POST /opportunities/value` (Kanban slice K): a person records an opportunity's monthly
 * value. The rules are the firm-mutation rules `changeStage` uses; what is proved here is
 * the wiring: the envelope, the assignee-or-admin decision, the append-only latest-wins
 * read on the board, the closed bounds, and the replay.
 */
describe('POST /opportunities/value', () => {
  let fixture: AuthFixture;
  let assigneeToken: string;
  let strangerToken: string;
  let adminToken: string;
  let firmId: string;
  let opportunityId: string;

  const post = async (path: string, token: string | null, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
    const request: ApiRequest = {
      method: 'POST',
      path,
      query: new URLSearchParams(),
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
      body,
    };
    const result = await dispatch(request, {
      session: fixture.db,
      supportedClientVersions: fixture.deps.config.supportedClientVersions,
      sendingEnabled: false,
      auth: fixture.deps,
      upgradeUrl: 'https://callie.example/downloads/mac',
    });
    return { status: result.status, body: JSON.parse(JSON.stringify(result.body ?? null)) as Record<string, unknown> };
  };
  const command = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    commandId: randomUUID(),
    clientVersion: CURRENT_CLIENT_VERSION,
    ...extra,
  });
  const valueOnBoard = async (token: string): Promise<unknown> => {
    const board = await post('/pipeline/board', token, {});
    expect(board.status).toBe(200);
    return pipelineBoardResponseSchema.parse(board.body).cards?.[firmId]?.value;
  };

  beforeAll(async () => {
    fixture = await createAuthFixture();
    assigneeToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)).accessToken;
    adminToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;
    const strangerSub = `sub-${randomUUID()}`;
    const strangerEmail = `stranger@${fixture.hostedDomain}`;
    const stranger = await fixture.db.query<{ id: string }>(
      "INSERT INTO users (google_sub, email, display_name) VALUES ($1, $2, 'Stranger') RETURNING id",
      [strangerSub, strangerEmail],
    );
    await fixture.db.query("INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'salesperson')", [
      fixture.alpha.workspaceId,
      stranger.rows[0]?.id ?? '',
    ]);
    strangerToken = (await issueSessionFor(fixture, fixture.alpha, { googleSub: strangerSub, email: strangerEmail }, { deviceLabel: 'The other Mac' })).accessToken;
    firmId = await seedFirm(fixture, { name: 'Valuewind Test Holdings', assignedUserId: fixture.alpha.salesperson.userId });
    const opened = await post('/opportunities/open', assigneeToken, command({ firmId }));
    expect(opened.status).toBe(200);
    opportunityId = (opened.body['result'] as { id: string }).id;
  });

  afterAll(async () => {
    await fixture.stop();
  });

  it('refuses a caller without a session', async () => {
    const answer = await post('/opportunities/value', null, command({ opportunityId, monthlyCents: 100, kind: 'estimated' }));
    expect(answer.status).toBe(401);
  });

  it('records the assignee\'s value, which is then the board card\'s latest, and an admin may replace it', async () => {
    const first = await post('/opportunities/value', assigneeToken, command({ opportunityId, monthlyCents: 120_000, kind: 'estimated' }));
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(await valueOnBoard(assigneeToken)).toEqual({ monthlyCents: 120_000, kind: 'estimated' });

    const agreed = await post('/opportunities/value', adminToken, command({ opportunityId, monthlyCents: 99_900, kind: 'agreed' }));
    expect(agreed.status).toBe(200);
    expect(await valueOnBoard(assigneeToken)).toEqual({ monthlyCents: 99_900, kind: 'agreed' });
    const rows = await fixture.db.query<{ source: string }>('SELECT source FROM opportunity_values WHERE opportunity_id = $1', [opportunityId]);
    expect(rows.rows.map(row => row.source)).toEqual(['person', 'person']);
  });

  it('refuses a salesperson who does not own the firm, and an unknown opportunity', async () => {
    const stranger = await post('/opportunities/value', strangerToken, command({ opportunityId, monthlyCents: 5, kind: 'agreed' }));
    expect(stranger.status).toBe(409);
    expect(stranger.body['reason']).toBe('not_assigned');
    const unknown = await post('/opportunities/value', assigneeToken, command({ opportunityId: randomUUID(), monthlyCents: 5, kind: 'agreed' }));
    expect(unknown.status).toBe(409);
    expect(unknown.body['reason']).toBe('opportunity_unknown');
  });

  it('refuses a malformed body: a fractional, negative or oversized amount, a made-up kind, an extra key', async () => {
    for (const extra of [
      { monthlyCents: 10.5, kind: 'agreed' },
      { monthlyCents: -1, kind: 'agreed' },
      { monthlyCents: 100_000_001, kind: 'agreed' },
      { monthlyCents: 100, kind: 'hoped' },
      { monthlyCents: 100, kind: 'agreed', source: 'research' },
    ]) {
      const answer = await post('/opportunities/value', assigneeToken, command({ opportunityId, ...extra }));
      expect(answer.status, JSON.stringify(extra)).toBe(400);
    }
  });

  it('answers a replayed command id from the receipt without writing a second row', async () => {
    const replayable = command({ opportunityId, monthlyCents: 7_700, kind: 'estimated' });
    const before = await fixture.db.query<{ n: string }>('SELECT count(*)::text AS n FROM opportunity_values WHERE opportunity_id = $1', [opportunityId]);
    expect((await post('/opportunities/value', assigneeToken, replayable)).status).toBe(200);
    const again = await post('/opportunities/value', assigneeToken, replayable);
    expect(again.status).toBe(200);
    expect(again.body['replayed']).toBe(true);
    const after = await fixture.db.query<{ n: string }>('SELECT count(*)::text AS n FROM opportunity_values WHERE opportunity_id = $1', [opportunityId]);
    expect(Number(after.rows[0]?.n) - Number(before.rows[0]?.n)).toBe(1);
  });
});
