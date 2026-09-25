import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  enrollmentsResponseSchema,
  sequenceVersionsResponseSchema,
  sequencesResponseSchema,
  templateVersionsResponseSchema,
  wireDrift,
} from '@fss/contracts';
import { SENDING_STOP_LINE } from '@fss/domain';
import { localNoopSuppressionJournal } from '../src/journal/index.ts';
import { dispatch, type ApiRequest } from '../src/server.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';

/**
 * The sequence, template and enrollment endpoints, through the real dispatcher with
 * real sessions (specification 11, 14.1).
 *
 * The rules have their own tests against a real PostgreSQL in `@fss/domain`. What is
 * proved here is the wiring, and four pieces of it are this lane's:
 *
 *   * publishing and approving are admin commands, and a salesperson is refused by
 *     the domain rather than by the route — so the refusal arrives as a *receipt*,
 *     which is what makes a replay answer the same way;
 *   * an approval that fails carries its issues, because an author who is told
 *     "unapproved" and not why has been told nothing;
 *   * enrolling is a command with a receipt, and a replay under the same id returns
 *     the first answer rather than enrolling twice;
 *   * every path in the family refuses an unauthenticated caller.
 *
 * No real business name, address or number appears. The footer's sign-off is
 * obviously fictional, and since migration 0015 the footer has no address in it at
 * all (`docs/decisions/g20-automated-email-carries-no-postal-address.md`).
 */

const SIGN_OFF = 'Sam Example\nCallie';

describe('the sequence, template and enrollment routes', () => {
  let fixture: AuthFixture;
  let adminToken = '';
  let salespersonToken = '';
  let firmId = '';
  let contactId = '';
  let opportunityId = '';
  let templateVersionId = '';
  let sequenceId = '';
  let sequenceVersionId = '';

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
    method: 'GET' | 'POST' = 'POST',
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const request: ApiRequest = {
      method,
      path,
      query: new URLSearchParams(),
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
      body,
    };
    const result = await dispatch(request, options());
    // What a socket carries: JSON, so an instant is a string here as it is on the Mac.
    return { status: result.status, body: JSON.parse(JSON.stringify(result.body ?? null)) as Record<string, unknown> };
  };

  const command = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    commandId: randomUUID(),
    clientVersion: CURRENT_CLIENT_VERSION,
    ...extra,
  });

  const resultOf = (answer: { body: Record<string, unknown> }): Record<string, unknown> =>
    (answer.body['result'] ?? {}) as Record<string, unknown>;

  beforeAll(async () => {
    fixture = await createAuthFixture();
    adminToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;
    salespersonToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson))
      .accessToken;

    const firm = await post(
      '/firms/create',
      adminToken,
      command({
        name: 'Northwind Test Holdings',
        regionCode: 'RI',
        postalCode: '02903',
        assignedUserId: fixture.alpha.salesperson.userId,
      }),
    );
    expect(firm.status).toBe(200);
    firmId = String(resultOf(firm)['id']);
    await fixture.db.query(
      `UPDATE firms SET time_zone = 'America/New_York', time_zone_confidence = 'high',
              time_zone_source = 'postal', time_zone_rule_version = 'firm-zone.1'
        WHERE workspace_id = $1 AND id = $2`,
      [fixture.alpha.workspaceId, firmId],
    );

    const contact = await post(
      '/contacts/create',
      salespersonToken,
      command({ firmId, fullName: 'Dana Example' }),
    );
    expect(contact.status).toBe(200);
    contactId = String(resultOf(contact)['id']);

    const opened = await post('/opportunities/open', salespersonToken, command({ firmId }));
    expect(opened.status).toBe(200);
    opportunityId = String(resultOf(opened)['id']);
    expect(opportunityId).not.toBe('');
  });

  afterAll(async () => {
    await fixture.stop();
  });

  it('refuses every path in this family without a session', async () => {
    for (const path of [
      '/sequences/create',
      '/sequences/versions/publish',
      '/templates/create',
      '/templates/approve',
      '/enrollments/enroll',
    ]) {
      expect((await post(path, null, command())).status, path).toBe(401);
    }
  });

  it('refuses an approval whose body breaks a rule, and says which rules', async () => {
    const created = await post(
      '/templates/create',
      adminToken,
      command({
        name: 'Missing footer',
        subject: 'Hello',
        body: 'No footer here at all.',
        footerSignOff: SIGN_OFF,
        requiredVariables: [],
      }),
    );
    expect(created.status).toBe(200);
    const badId = String(resultOf(created)['id']);

    const approved = await post('/templates/approve', adminToken, command({ templateVersionId: badId }));
    expect(approved.status).toBe(409);
    expect(String(approved.body['reason'] ?? '')).toContain('template_unapproved');
    expect(String(approved.body['reason'] ?? '')).toContain('template_footer_missing');
  });

  it('refuses a create that still names a postal address, rather than dropping the field', async () => {
    // The create body is a strict object, so an older Mac — or anything else built
    // against the pre-0015 contract — is told, not quietly obeyed. An automated email
    // carries no postal address
    // (`docs/decisions/g20-automated-email-carries-no-postal-address.md`).
    const refused = await post(
      '/templates/create',
      adminToken,
      command({
        name: 'Still sending an address',
        subject: 'Hello',
        body: `Hello.\n\n${SIGN_OFF}\n${SENDING_STOP_LINE}`,
        footerSignOff: SIGN_OFF,
        footerPostalAddress: '1 Example Way, Suite 100, Providence, RI 02903',
        requiredVariables: [],
      }),
    );
    expect(refused.status).toBe(400);
    // Redacted: the refusal names no value the caller sent.
    expect(JSON.stringify(refused.body)).not.toContain('1 Example Way');
  });

  it('creates and approves a template a salesperson may not', async () => {
    const body = `Hello {contact_first_name},\n\nA note about {firm_name}.\n\n${SIGN_OFF}\n${SENDING_STOP_LINE}`;
    const payload = {
      name: 'First touch',
      subject: 'A question about {firm_name}',
      body,
      footerSignOff: SIGN_OFF,
      requiredVariables: ['firm_name', 'contact_first_name'],
    };

    const refused = await post('/templates/create', salespersonToken, command(payload));
    expect(refused.status).toBe(409);
    expect(refused.body['reason']).toBe('admin_only');

    const created = await post('/templates/create', adminToken, command(payload));
    expect(created.status).toBe(200);
    templateVersionId = String(resultOf(created)['id']);

    const approved = await post(
      '/templates/approve',
      adminToken,
      command({ templateVersionId }),
    );
    expect(approved.status).toBe(200);
    expect(resultOf(approved)['approvedAt']).not.toBeNull();
  });

  it('publishes a sequence version and refuses a salesperson who tries', async () => {
    const created = await post('/sequences/create', adminToken, command({ name: 'Founding outreach' }));
    expect(created.status).toBe(200);
    sequenceId = String(resultOf(created)['id']);

    const draft = await post(
      '/sequences/versions/draft',
      adminToken,
      command({
        sequenceId,
        steps: [
          { ordinal: 1, channel: 'email', delay: { unit: 'elapsed', hours: 0 }, templateVersionId },
          {
            ordinal: 2,
            channel: 'call_task',
            delay: { unit: 'business_days', days: 2 },
            onNoAnswer: 'advance',
          },
        ],
      }),
    );
    expect(draft.status).toBe(200);
    sequenceVersionId = String(resultOf(draft)['sequenceVersionId']);

    const refused = await post(
      '/sequences/versions/publish',
      salespersonToken,
      command({ sequenceVersionId }),
    );
    expect(refused.status).toBe(409);
    expect(refused.body['reason']).toBe('admin_only');

    const published = await post(
      '/sequences/versions/publish',
      adminToken,
      command({ sequenceVersionId }),
    );
    expect(published.status).toBe(200);
    expect(resultOf(published)['state']).toBe('published');
  });

  it('enrols a contact once, and answers a replay from the receipt', async () => {
    const payload = command({ sequenceVersionId, opportunityId, firmId, contactId });
    const first = await post('/enrollments/enroll', salespersonToken, payload);
    expect(first.status).toBe(200);
    const enrollmentId = String(resultOf(first)['enrollmentId']);
    expect(enrollmentId).not.toBe('');

    // Same command id and same payload: the original result, not a second enrollment.
    const replay = await post('/enrollments/enroll', salespersonToken, payload);
    expect(replay.status).toBe(200);
    expect(resultOf(replay)['enrollmentId']).toBe(enrollmentId);

    const steps = await post('/enrollments/steps', salespersonToken, { enrollmentId });
    expect(steps.status).toBe(200);
    expect((steps.body['steps'] as unknown[]).length).toBe(1);

    const again = await post(
      '/enrollments/enroll',
      salespersonToken,
      command({ sequenceVersionId, opportunityId, firmId, contactId }),
    );
    expect(again.status).toBe(409);
    expect(again.body['reason']).toBe('contact_already_enrolled');
  });

  it('answers every read the sequence editor makes in exactly the shape @fss/contracts declares (lane g78)', async () => {
    // D01 and D02: the Mac's own copies refused every populated version (the step's
    // `sequenceVersionId`) and every populated enrollment list (four missing fields).
    // `wireDrift` is the contract's parse plus the keys a stripping parse would drop, so
    // an undeclared key, a missing one or a value outside a vocabulary fails here.
    const sequences = await post('/sequences', adminToken, undefined, 'GET');
    expect(sequences.status).toBe(200);
    expect(wireDrift(sequencesResponseSchema, sequences.body)).toEqual([]);

    const versions = await post('/sequences/versions', adminToken, { sequenceId });
    expect(versions.status).toBe(200);
    expect(wireDrift(sequenceVersionsResponseSchema, versions.body)).toEqual([]);
    const steps = sequenceVersionsResponseSchema.parse(versions.body).versions.flatMap(version => version.steps);
    // A populated version, or this proves nothing about the step.
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.every(step => step.sequenceVersionId === sequenceVersionId)).toBe(true);

    const templates = await post('/templates', adminToken, {});
    expect(templates.status).toBe(200);
    expect(wireDrift(templateVersionsResponseSchema, templates.body)).toEqual([]);

    const enrollments = await post('/enrollments', salespersonToken, {});
    expect(enrollments.status).toBe(200);
    expect(wireDrift(enrollmentsResponseSchema, enrollments.body)).toEqual([]);
    expect(enrollmentsResponseSchema.parse(enrollments.body).enrollments.length).toBeGreaterThan(0);
  });

  it('answers a path nobody mounted under these roots with not_found', async () => {
    // The LinkedIn task card's three paths went with LinkedIn on 25 September 2026.
    for (const path of [
      '/sequences/nope',
      '/templates/nope',
      '/enrollments/nope',
      '/enrollments/linkedin/complete',
      '/enrollments/linkedin/undo',
      '/enrollments/linkedin/result',
    ]) {
      expect((await post(path, adminToken, command())).status, path).toBe(404);
    }
  });
});
