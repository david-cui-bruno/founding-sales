import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { firmListResponseSchema, mergeRefusalSchema, wireDrift } from '@fss/contracts';
import { dispatch, type ApiRequest } from '../src/server.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, OUTDATED_CLIENT_VERSION, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';
import { seedContact, seedFirm } from './support/crmSeed.ts';

/**
 * The CRM endpoints, through the real dispatcher with real sessions.
 *
 * What is proved here is the wiring rather than the rules — the rules have their own
 * tests against a real PostgreSQL in `@fss/domain`. Three things are wiring, and all
 * three have been wrong in a CRM before:
 *
 *   * every mutation is a command, so a replay returns the original result and a
 *     different payload under the same id is refused (5.3);
 *   * an unauthenticated or outdated client reaches no CRM path at all (5.3, G 40);
 *   * the read matrix decides the *shape* of the response, so the colleague's read
 *     has no field the assignee's fields could hide in (Appendix F).
 */
describe('CRM routes', () => {
  let fixture: AuthFixture;
  let assigneeToken: string;
  let strangerToken: string;
  let adminToken: string;
  let assigneeUserId: string;
  let strangerUserId: string;
  let firmId: string;
  let contactId: string;

  const options = () => ({
    session: fixture.db,
    supportedClientVersions: fixture.deps.config.supportedClientVersions,
    sendingEnabled: false,
    expectedSystemGeneration: null,
    auth: fixture.deps,
    upgradeUrl: 'https://callie.example/downloads/mac',
  });

  const post = async (path: string, token: string | null, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
    const request: ApiRequest = {
      method: 'POST',
      path,
      query: new URLSearchParams(),
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
      body,
    };
    const result = await dispatch(request, options());
    return { status: result.status, body: JSON.parse(JSON.stringify(result.body ?? null)) as Record<string, unknown> };
  };

  const get = async (path: string, token: string): Promise<{ status: number; body: Record<string, unknown> }> => {
    const result = await dispatch(
      { method: 'GET', path, query: new URLSearchParams(), headers: { authorization: `Bearer ${token}` }, body: undefined },
      options(),
    );
    return { status: result.status, body: JSON.parse(JSON.stringify(result.body ?? null)) as Record<string, unknown> };
  };

  const command = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    commandId: randomUUID(),
    clientVersion: CURRENT_CLIENT_VERSION,
    ...extra,
  });

  beforeAll(async () => {
    fixture = await createAuthFixture();
    const assignee = await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson);
    const admin = await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin);
    assigneeToken = assignee.accessToken;
    adminToken = admin.accessToken;
    assigneeUserId = fixture.alpha.salesperson.userId;

    // A second salesperson in alpha, so "the other one" is a real member.
    const strangerSub = `sub-${randomUUID()}`;
    const strangerEmail = `stranger@${fixture.hostedDomain}`;
    const stranger = await fixture.db.query<{ id: string }>(
      "INSERT INTO users (google_sub, email, display_name) VALUES ($1, $2, 'Stranger') RETURNING id",
      [strangerSub, strangerEmail],
    );
    strangerUserId = stranger.rows[0]?.id ?? '';
    await fixture.db.query(
      "INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'salesperson')",
      [fixture.alpha.workspaceId, strangerUserId],
    );
    const strangerSession = await issueSessionFor(
      fixture,
      fixture.alpha,
      { googleSub: strangerSub, email: strangerEmail },
      { deviceLabel: 'The other Mac' },
    );
    strangerToken = strangerSession.accessToken;

    firmId = await seedFirm(fixture, {
      name: 'Northwind Test Holdings',
      regionCode: 'RI',
      postalCode: '02903',
      assignedUserId: assigneeUserId,
    });
    contactId = await seedContact(fixture, { firmId, fullName: 'Dana Example', isPrimary: true });
  });

  afterAll(async () => {
    await fixture.stop();
  });

  it('refuses every CRM path without a session', async () => {
    for (const path of ['/contacts/update', '/opportunities/open', '/merges/firms', '/crm/firms/add']) {
      const answer = await post(path, null, command({ name: 'x' }));
      expect(answer.status).toBe(401);
    }
    const read = await dispatch(
      { method: 'GET', path: '/firms', query: new URLSearchParams(), headers: {}, body: undefined },
      options(),
    );
    expect(read.status).toBe(401);
  });

  it('refuses an outdated client and leaves its command id unspent', async () => {
    const commandId = randomUUID();
    const outdated = await post(
      '/contacts/update',
      assigneeToken,
      { commandId, clientVersion: OUTDATED_CLIENT_VERSION, contactId, patch: { title: 'Partner' } },
    );
    expect(outdated.status).toBe(426);
    expect(outdated.body['reason']).toBe('client_upgrade_required');

    // The same id, from an upgraded client, is still free (Appendix G 40).
    const retried = await post(
      '/contacts/update',
      assigneeToken,
      { commandId, clientVersion: CURRENT_CLIENT_VERSION, contactId, patch: { title: 'Partner' } },
    );
    expect(retried.status).toBe(200);
    expect(retried.body['replayed']).toBe(false);
  });

  it('replays a command by id and refuses a different payload under the same id', async () => {
    const commandId = randomUUID();
    const body = { commandId, clientVersion: CURRENT_CLIENT_VERSION, contactId, patch: { title: 'Principal' } };
    const first = await post('/contacts/update', assigneeToken, body);
    expect(first.status).toBe(200);
    expect(first.body['replayed']).toBe(false);

    const replay = await post('/contacts/update', assigneeToken, body);
    expect(replay.body['replayed']).toBe(true);

    const different = await post('/contacts/update', assigneeToken, { ...body, patch: { title: 'Founder' } });
    expect(different.status).toBe(409);
    expect(different.body['reason']).toBe('command_payload_mismatch');
  });

  it('refuses the other salesperson every mutation on a firm that is not theirs', async () => {
    const refused = await post('/contacts/update', strangerToken, command({ contactId, patch: { title: 'Taken' } }));
    expect(refused.status).toBe(409);
    expect(refused.body['reason']).toBe('not_assigned');

    const opened = await post('/opportunities/open', strangerToken, command({ firmId }));
    expect(opened.body['reason']).toBe('not_assigned');
  });

  it('gives the colleague the identity DTO and the assignee the detail DTO', async () => {
    const narrow = await get(`/firms/${firmId}`, strangerToken);
    expect(narrow.status).toBe(200);
    expect(narrow.body['visibility']).toBe('any_active_member');
    expect(Object.keys(narrow.body['firm'] as object)).not.toContain('contacts');

    const wide = await get(`/firms/${firmId}`, assigneeToken);
    expect(wide.body['visibility']).toBe('assigned_or_admin');
    expect(Object.keys(wide.body['firm'] as object)).toContain('contacts');
  });

  it('serves the seeded pipeline to any member', async () => {
    const answer = await get('/pipeline/stages', strangerToken);
    expect(answer.status).toBe(200);
    const stages = answer.body['stages'] as { key: string; terminalKind: string | null }[];
    expect(stages.map(stage => stage.key)).toEqual([
      'new',
      'contacting',
      'engaged',
      'qualified',
      'proposal',
      'won',
      'lost',
    ]);
  });

  it('runs the whole pipeline of a firm through commands', async () => {
    const zone = await post('/firms/resolve-zone', assigneeToken, command({ firmId }));
    expect(zone.status).toBe(200);
    expect((zone.body['result'] as { timeZone: string }).timeZone).toBe('America/New_York');

    const route = await post(
      '/contacts/routes/add',
      assigneeToken,
      command({
        firmId,
        contactId,
        routeKind: 'phone',
        value: '+14015550187',
        source: 'salesperson',
        technicalValidation: 'passed',
        associationConfidence: 0.99,
      }),
    );
    expect(route.status).toBe(200);
    expect((route.body['result'] as { eligibility: string }).eligibility).toBe('usable');

    const opened = await post('/opportunities/open', assigneeToken, command({ firmId }));
    expect(opened.status).toBe(200);
    const opportunityId = (opened.body['result'] as { id: string }).id;

    const moved = await post('/opportunities/stage', assigneeToken, command({ opportunityId, toStageKey: 'contacting' }));
    expect(moved.status).toBe(200);

    const lostWithoutReason = await post('/opportunities/stage', assigneeToken, command({ opportunityId, toStageKey: 'lost' }));
    expect(lostWithoutReason.status).toBe(409);
    expect(lostWithoutReason.body['reason']).toBe('lost_reason_required');

    const lost = await post(
      '/opportunities/stage',
      assigneeToken,
      command({ opportunityId, toStageKey: 'lost', reason: 'chose a competitor' }),
    );
    expect(lost.status).toBe(200);
  });

  it('returns merge conflicts for resolution and accepts the resolved merge', async () => {
    const duplicateId = await seedFirm(fixture, {
      name: 'Northwind Test Holdings (dup)',
      website: 'https://dup.example.test',
      assignedUserId: assigneeUserId,
    });
    await fixture.db.query("UPDATE firms SET website = 'https://northwind.example.test' WHERE id = $1", [firmId]);

    const attempt = command({ sourceFirmId: duplicateId, targetFirmId: firmId });
    const conflicted = await post('/merges/firms', assigneeToken, attempt);
    expect(conflicted.status).toBe(409);
    expect(conflicted.body['reason']).toBe('merge_conflicts');
    expect((conflicted.body['conflicts'] as { field: string }[]).map(conflict => conflict.field)).toContain('website');
    expect(wireDrift(mergeRefusalSchema, conflicted.body)).toEqual([]);

    // D05: the same command id again is a replay, answered from the receipt — and the
    // receipt keeps the conflicts beside the reason (lane g78), so the replay carries
    // the same list rather than a bare code the conflict screen cannot be drawn from.
    const replayed = await post('/merges/firms', assigneeToken, attempt);
    expect(replayed.status).toBe(409);
    expect(replayed.body['replayed']).toBe(true);
    expect(replayed.body['conflicts']).toEqual(conflicted.body['conflicts']);
    expect(wireDrift(mergeRefusalSchema, replayed.body)).toEqual([]);

    const resolved = await post(
      '/merges/firms',
      assigneeToken,
      command({
        sourceFirmId: duplicateId,
        targetFirmId: firmId,
        resolutions: { website: 'https://northwind.example.test' },
      }),
    );
    expect(resolved.status).toBe(200);
    expect((resolved.body['result'] as { sourceId: string }).sourceId).toBe(duplicateId);
  });

  it('never lets a session from the other workspace see this one, even with the same ids', async () => {
    const betaAdmin = await issueSessionFor(fixture, fixture.beta, fixture.beta.admin);
    const crossed = await get(`/firms/${firmId}`, betaAdmin.accessToken);
    expect(crossed.status).toBe(404);

    const list = await get('/firms', betaAdmin.accessToken);
    expect((list.body['firms'] as unknown[]).length).toBe(0);
    const ours = await get('/firms', adminToken);
    expect((ours.body['firms'] as unknown[]).length).toBeGreaterThan(0);
    expect(wireDrift(firmListResponseSchema, ours.body)).toEqual([]);
  });
});
