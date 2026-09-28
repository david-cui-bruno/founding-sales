import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dispatch, type ApiRequest } from '../src/server.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';
import { seedContact, seedFirm } from './support/crmSeed.ts';

/**
 * What is left of lane g88's surface, through the real dispatcher: the captured phone
 * number that is usable at once, and the contact patch the Mac sends (the
 * route-usability gap lane g84 reported, and C20).
 *
 * The two endpoints g88 added — the resume review (`/enrollments/resume/preview`) and
 * the phone-number confirmation (`/contacts/routes/confirm`) — went with the 1.0.14
 * minimum (lane W3-C2). A long hold resumes on its own since wave 2 (S4.1), so there is
 * nothing for a person to review, and no installed build confirms a number: since wave
 * 2 (S4.4) a number somebody typed is usable without a second command. The tests for
 * both are gone with them.
 */
describe('lane g88 through the API', () => {
  let fixture: AuthFixture;
  let adminToken = '';
  let salespersonToken = '';
  let firmId = '';
  let contactId = '';

  const options = () => ({
    session: fixture.db,
    supportedClientVersions: fixture.deps.config.supportedClientVersions,
    sendingEnabled: false,
    auth: fixture.deps,
    upgradeUrl: 'https://callie.example/downloads/mac',
  });

  const post = async (path: string, token: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
    const request: ApiRequest = {
      method: 'POST',
      path,
      query: new URLSearchParams(),
      headers: { authorization: `Bearer ${token}` },
      body,
    };
    const result = await dispatch(request, options());
    return { status: result.status, body: JSON.parse(JSON.stringify(result.body)) as Record<string, unknown> };
  };
  const command = (extra: Readonly<Record<string, unknown>>) => ({
    commandId: randomUUID(),
    clientVersion: CURRENT_CLIENT_VERSION,
    ...extra,
  });
  const result = (answer: { body: Record<string, unknown> }): Record<string, unknown> =>
    (answer.body['result'] ?? {}) as Record<string, unknown>;

  beforeAll(async () => {
    fixture = await createAuthFixture();
    adminToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;
    salespersonToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)).accessToken;

    firmId = await seedFirm(fixture, {
      name: 'Linden Test Advisors',
      regionCode: 'RI',
      postalCode: '02903',
      assignedUserId: fixture.alpha.salesperson.userId,
    });
    await fixture.db.query(
      `UPDATE firms SET time_zone = 'America/New_York', time_zone_confidence = 'high',
              time_zone_source = 'postal', time_zone_rule_version = 'firm-zone.1'
        WHERE workspace_id = $1 AND id = $2`,
      [fixture.alpha.workspaceId, firmId],
    );
    contactId = await seedContact(fixture, { firmId, fullName: 'Rowan Placeholder', title: 'Principal' });
    await post('/opportunities/open', salespersonToken, command({ firmId }));
  });

  afterAll(async () => {
    await fixture.stop();
  });

  it('adds a captured phone number usable at once (wave 2, S4.4)', async () => {
    const added = await post(
      '/contacts/routes/add',
      salespersonToken,
      command({ firmId, contactId, routeKind: 'phone', value: '+14015550142', source: 'import' }),
    );
    expect(added.status).toBe(200);
    expect([result(added)['eligibility'], result(added)['version']]).toEqual(['usable', 1]);
  });

  it('clears a contact’s title when the patch says null', async () => {
    const cleared = await post('/contacts/update', salespersonToken, command({ contactId, patch: { fullName: 'Rowan Placeholder', title: null } }));
    expect(cleared.status).toBe(200);
    const { rows } = await fixture.db.query<{ title: string | null }>('SELECT title FROM contacts WHERE id = $1', [contactId]);
    expect(rows[0]?.title).toBeNull();
  });
});
