import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SENDING_STOP_LINE, resumePreviewResponseSchema, wireDrift } from '@fss/contracts';
import { repositoryContext, workspaceScope } from '@fss/domain/db';
import { openHold, releaseHold } from '@fss/domain/policy';
import { dispatch, type ApiRequest } from '../src/server.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';
import { seedContact, seedFirm } from './support/crmSeed.ts';

/**
 * The two endpoints lane g88 added, through the real dispatcher: the resume review and
 * the phone-number confirmation, and the contact patch the Mac now sends (audit G06,
 * C20, and the route-usability gap lane g84 reported).
 *
 * The domain's own files prove the rules (`resumePreview.test.ts`, `routeConfirm.test.ts`).
 * What is proved here is the surface: the review's answer is exactly the contract
 * (`wireDrift` is empty) and it is a read; the confirmation is a command with a receipt,
 * refuses an email address at the door, and says `route_version_stale` for a number the
 * person was not looking at; a title the Mac clears is cleared.
 *
 * **The vacuous-pass trap for the review.** A review of an enrollment that was never held
 * is an empty shift, which any contract parses. The enrollment here lived through a
 * released nine-day pause, and the answer is required to move its step nine days.
 */
describe('lane g88 through the API', () => {
  let fixture: AuthFixture;
  let adminToken = '';
  let salespersonToken = '';
  let firmId = '';
  let contactId = '';
  let enrollmentId = '';

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
    const opportunityId = String(result(await post('/opportunities/open', salespersonToken, command({ firmId })))['id']);

    const signOff = 'Sam Example\nCallie';
    const template = await post(
      '/templates/create',
      adminToken,
      command({
        name: 'First touch',
        subject: 'A question for {firm_name}',
        body: `Hello {contact_first_name},\n\nA short note.\n\n${signOff}\n${SENDING_STOP_LINE}`,
        footerSignOff: signOff,
        requiredVariables: ['firm_name', 'contact_first_name'],
      }),
    );
    const templateVersionId = String(result(template)['id']);
    await post('/templates/approve', adminToken, command({ templateVersionId }));
    const sequenceId = String(result(await post('/sequences/create', adminToken, command({ name: 'Founder plan' })))['id']);
    const draft = await post(
      '/sequences/versions/draft',
      adminToken,
      command({
        sequenceId,
        steps: [
          { ordinal: 1, channel: 'email', delay: { unit: 'business_days', days: 0 }, templateVersionId },
          { ordinal: 2, channel: 'call_task', delay: { unit: 'business_days', days: 2 }, onNoAnswer: 'advance' },
        ],
      }),
    );
    const sequenceVersionId = String(result(draft)['sequenceVersionId']);
    expect((await post('/sequences/versions/publish', adminToken, command({ sequenceVersionId }))).status).toBe(200);
    const enrolled = await post('/enrollments/enroll', salespersonToken, command({ sequenceVersionId, opportunityId, firmId, contactId }));
    expect(enrolled.status).toBe(200);
    enrollmentId = String(result(enrolled)['enrollmentId']);

    // Ten days in, and a nine-day pause of the firm that has since been released.
    await fixture.db.query(`UPDATE sequence_enrollments SET started_at = now() - interval '10 days' WHERE id = $1`, [enrollmentId]);
    const admin = repositoryContext(
      workspaceScope(fixture.alpha.workspaceId, { kind: 'user', userId: fixture.alpha.admin.userId, role: 'admin' }),
      fixture.db,
    );
    const hold = await openHold(admin, {
      scopeKind: 'firm',
      scopeKey: firmId,
      reasonCode: 'scoped_pause',
      blockedActionKinds: ['email_send', 'enrollment_advance'],
      sourceEventKind: 'test.g88',
    });
    await fixture.db.query(`UPDATE active_holds SET started_at = now() - interval '9 days' WHERE id = $1`, [hold]);
    await releaseHold(admin, hold);
  });

  afterAll(async () => {
    await fixture.stop();
  });

  it('answers the resume review exactly as the contract says, and moves the step nine days', async () => {
    const answer = await post('/enrollments/resume/preview', salespersonToken, { enrollmentId });
    expect(answer.status).toBe(200);
    expect(wireDrift(resumePreviewResponseSchema, answer.body)).toEqual([]);
    const { preview } = resumePreviewResponseSchema.parse(answer.body);
    // A long hold resumes on its own since wave 2 (S4.1); the review says so.
    expect(preview.kind).toBe('resume');
    expect(preview.steps).toHaveLength(1);
    const moved = Date.parse(preview.steps[0]?.proposedDueAt ?? '') - Date.parse(preview.steps[0]?.dueAt ?? '');
    expect(moved / 86_400_000).toBeGreaterThan(8.9);

    // A read: nothing was recorded, and the enrollment was not flagged by looking.
    const { rows } = await fixture.db.query<{ state: string; receipts: string }>(
      `SELECT e.state, (SELECT count(*)::text FROM command_receipts r WHERE r.command_kind = 'resume_enrollment') AS receipts
         FROM sequence_enrollments e WHERE e.id = $1`,
      [enrollmentId],
    );
    expect(rows[0]).toEqual({ state: 'active', receipts: '0' });
  });

  it('refuses a malformed review request and an enrollment that is not here', async () => {
    expect((await post('/enrollments/resume/preview', salespersonToken, {})).status).toBe(400);
    expect((await post('/enrollments/resume/preview', salespersonToken, { enrollmentId: randomUUID() })).status).toBe(404);
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

  it('confirms a number an older release stored as a candidate, as a command, and refuses an email address at the door', async () => {
    const { rows } = await fixture.db.query<{ id: string }>(
      `INSERT INTO phone_routes (workspace_id, firm_id, contact_id, e164, source, retrieved_at)
       VALUES ($1, $2, $3, '+14015550141', 'import', now()) RETURNING id`,
      [fixture.alpha.workspaceId, firmId, contactId],
    );
    const routeId = rows[0]?.id ?? '';

    const stale = await post('/contacts/routes/confirm', salespersonToken, command({ routeKind: 'phone', routeId, routeVersion: 2 }));
    expect(stale.status).toBe(409);
    expect(stale.body['reason']).toBe('route_version_stale');

    const body = command({ routeKind: 'phone', routeId, routeVersion: 1 });
    const confirmed = await post('/contacts/routes/confirm', salespersonToken, body);
    expect(confirmed.status).toBe(200);
    expect(result(confirmed)['eligibility']).toBe('usable');
    expect(result(confirmed)['version']).toBe(2);
    const replayed = await post('/contacts/routes/confirm', salespersonToken, body);
    expect(replayed.body['replayed']).toBe(true);

    const email = await post('/contacts/routes/confirm', salespersonToken, command({ routeKind: 'email', routeId, routeVersion: 1 }));
    expect(email.status).toBe(400);
  });

  it('clears a contact’s title when the patch says null', async () => {
    const cleared = await post('/contacts/update', salespersonToken, command({ contactId, patch: { fullName: 'Rowan Placeholder', title: null } }));
    expect(cleared.status).toBe(200);
    const { rows } = await fixture.db.query<{ title: string | null }>('SELECT title FROM contacts WHERE id = $1', [contactId]);
    expect(rows[0]?.title).toBeNull();
  });
});
