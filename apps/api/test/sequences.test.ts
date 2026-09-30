import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  enrollmentMigrateResultSchema,
  enrollmentsResponseSchema,
  sequenceVersionsResponseSchema,
  sequencesResponseSchema,
  templateCommandResultSchema,
  templateSaveResultSchema,
  templateVersionsResponseSchema,
  wireDrift,
} from '@fss/contracts';
import { SENDING_STOP_LINE } from '@fss/domain/src/rules/templates.ts';
import { localNoopSuppressionJournal } from '../src/journal/index.ts';
import { dispatch, type ApiRequest } from '../src/server.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';
import { seedContact, seedFirm } from './support/crmSeed.ts';

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

    firmId = await seedFirm(fixture, {
      name: 'Northwind Test Holdings',
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

    contactId = await seedContact(fixture, { firmId, fullName: 'Dana Example' });

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
      '/enrollments/enroll',
      '/enrollments/migrate',
    ]) {
      expect((await post(path, null, command())).status, path).toBe(401);
    }
  });

  it('refuses an approval whose body breaks a rule, and says which rules', async () => {
    // Save and approve in one command: `/templates/approve` went with the 1.0.14
    // minimum (lane W3-C2), so a refused approval is a refused save and nothing is
    // written.
    const approved = await post(
      '/templates/create',
      adminToken,
      command({
        name: 'A stop line in the wrong place',
        subject: 'Hello',
        // Footerless is approvable since lane W3-F (the footer is composed at send); a
        // stop line that is not the final block is not, because composing would leave two.
        body: `${SENDING_STOP_LINE}\n\nAnd a postscript after it.`,
        footerSignOff: SIGN_OFF,
        requiredVariables: [],
        approve: true,
      }),
    );
    expect(approved.status).toBe(409);
    expect(String(approved.body['reason'] ?? '')).toContain('template_unapproved');
    expect(String(approved.body['reason'] ?? '')).toContain('template_footer_missing');
  });

  it('refuses an approval whose sign-off carries an opt-out link, and names the rule', async () => {
    // The sign-off is a field of its own on this route, so it is bytes no approved body
    // ever carried. Approval checks it with the subject and the body, and answers with
    // the issue rather than `invalid_input`, so the Mac has a sentence to show
    // (review of PR 311, P1-2 and P2).
    const refused = await post(
      '/templates/create',
      adminToken,
      command({
        name: 'A link in the sign-off',
        subject: 'Hello',
        body: 'Hello, a short note.',
        footerSignOff: 'Sam\nUnsubscribe: https://x.example/a',
        requiredVariables: [],
        approve: true,
      }),
    );
    expect(refused.status).toBe(409);
    expect(String(refused.body['reason'] ?? '')).toContain('template_optout_link');

    // The bare word in the same place is not a link, and it approves.
    const approved = await post(
      '/templates/create',
      adminToken,
      command({
        name: 'The word in the sign-off',
        subject: 'Hello',
        body: "Hello. Just reply unsubscribe and I'll stop.",
        footerSignOff: 'Sam Example',
        requiredVariables: [],
        approve: true,
      }),
    );
    expect(approved.status).toBe(200);
    expect(resultOf(approved)['approvedAt']).not.toBeNull();
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

    const created = await post('/templates/create', adminToken, command({ ...payload, approve: true }));
    expect(created.status).toBe(200);
    templateVersionId = String(resultOf(created)['id']);
    expect(resultOf(created)['approvedAt']).not.toBeNull();
    expect(resultOf(created)['warnings']).toEqual([]);
  });

  it('approves a template past the copy limits and answers its warnings', async () => {
    const created = await post(
      '/templates/create',
      adminToken,
      command({
        name: 'Copy advice',
        subject: 'A 20% price cut',
        body: `${'Word '.repeat(90)}See https://one.example.test and https://two.example.test.\n\n${SIGN_OFF}\n${SENDING_STOP_LINE}`,
        footerSignOff: SIGN_OFF,
        requiredVariables: [],
        approve: true,
      }),
    );
    expect(created.status).toBe(200);
    const expected = ['template_body_multiple_urls', 'template_body_too_long', 'template_pricing_or_guarantee_language'];
    const result = templateCommandResultSchema.parse(resultOf(created));
    // The copy rules never refuse: every accepted answer carries them as warnings, and
    // the approval went through with all three of them.
    expect(result.warnings.sort()).toEqual(expected);
    expect(result.approvedAt).not.toBeNull();
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
    const payload = command({ originKind: 'prospecting', sequenceVersionId, opportunityId, firmId, contactId });
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
      command({ originKind: 'prospecting', sequenceVersionId, opportunityId, firmId, contactId }),
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

  it('writes an edit of an approved template as its next version, and saves and approves in one command (send-path v2, S2)', async () => {
    const payload = {
      templateVersionId,
      name: 'First touch',
      subject: 'A question about {firm_name}',
      body: `Hello {contact_first_name},\n\nA corrected note about {firm_name}.\n\n${SIGN_OFF}\n${SENDING_STOP_LINE}`,
      footerSignOff: SIGN_OFF,
      requiredVariables: ['firm_name', 'contact_first_name'],
    };
    expect((await post('/templates/update', salespersonToken, command(payload))).body['reason']).toBe('admin_only');
    const before = templateVersionsResponseSchema
      .parse((await post('/templates', adminToken, {})).body)
      .templates.find(template => template.id === templateVersionId);
    expect(before?.approvedAt).not.toBeNull();

    // A plain save of an approved version is its next version, pending approval; the
    // approved one is untouched. The answer carries warnings and issues.
    const saved = await post('/templates/update', adminToken, command(payload));
    expect(saved.status).toBe(200);
    const result = templateSaveResultSchema.parse(resultOf(saved));
    expect(result).toMatchObject({ templateId: before?.templateId, version: (before?.version ?? 0) + 1, issues: [], warnings: [] });
    expect(result.id).not.toBe(templateVersionId);
    expect(result.approvedAt).toBeNull();

    // Save and approve with a rule broken: refused with every issue, and nothing written.
    const refused = await post(
      '/templates/update',
      adminToken,
      command({ ...payload, body: `${SENDING_STOP_LINE}\n\nAnd a postscript after it.`, approve: true }),
    );
    expect(refused.status).toBe(409);
    expect(refused.body['reason']).toBe('template_unapproved:template_footer_missing');
    const listed = templateVersionsResponseSchema.parse((await post('/templates', adminToken, {})).body);
    expect(listed.templates.find(template => template.id === templateVersionId)).toEqual(before);
    expect(listed.templates.filter(template => template.templateId === before?.templateId)).toHaveLength(2);

    // A new template saved and approved in one command.
    const { templateVersionId: _edited, ...text } = payload;
    const created = await post('/templates/create', adminToken, command({ ...text, name: 'One command', approve: true }));
    expect(created.status).toBe(200);
    expect(templateSaveResultSchema.parse(resultOf(created)).approvedAt).not.toBeNull();
  });

  it('writes an edit of a published version’s steps to a new draft version and leaves the published one as it was (send-path v2, S2)', async () => {
    const before = sequenceVersionsResponseSchema
      .parse((await post('/sequences/versions', adminToken, { sequenceId })).body)
      .versions.find(entry => entry.id === sequenceVersionId);
    expect(before?.state).toBe('published');
    const steps = [
      { ordinal: 1, channel: 'email', delay: { unit: 'elapsed', hours: 0 }, templateVersionId },
      { ordinal: 2, channel: 'call_task', delay: { unit: 'business_days', days: 5 }, onNoAnswer: 'advance' },
    ];
    const saved = await post('/sequences/versions/steps', adminToken, command({ sequenceVersionId, steps }));
    expect(saved.status).toBe(200);
    const answer = resultOf(saved);
    expect(answer).toMatchObject({ steps: 2, version: (before?.version ?? 0) + 1, newVersion: true });
    const versions = sequenceVersionsResponseSchema.parse(
      (await post('/sequences/versions', adminToken, { sequenceId })).body,
    ).versions;
    expect(versions.find(entry => entry.id === sequenceVersionId)).toEqual(before);
    const draft = versions.find(entry => entry.id === answer['sequenceVersionId']);
    expect(draft?.state).toBe('draft');
    expect(draft?.steps[1]?.delay).toEqual({ unit: 'business_days', days: 5 });

    // A second edit of the published version while that draft exists is refused, naming
    // the draft (`draft_exists:<version>:<id>`), and the draft is left as it was.
    const again = await post('/sequences/versions/steps', adminToken, command({ sequenceVersionId, steps: [steps[0]] }));
    expect(again.status).toBe(409);
    expect(again.body['reason']).toBe(`draft_exists:${String(draft?.version)}:${String(draft?.id)}`);
    const after = sequenceVersionsResponseSchema
      .parse((await post('/sequences/versions', adminToken, { sequenceId })).body)
      .versions.find(entry => entry.id === draft?.id);
    expect(after).toEqual(draft);
  });

  it('migrates an enrollment to the newly published version by supersede, audited, and answers a replay from the receipt (send-path v2, S2)', async () => {
    const versions = sequenceVersionsResponseSchema.parse(
      (await post('/sequences/versions', adminToken, { sequenceId })).body,
    ).versions;
    const draft = versions.find(entry => entry.state === 'draft');
    expect(draft).toBeDefined();
    const published = await post('/sequences/versions/publish', adminToken, command({ sequenceVersionId: draft?.id }));
    expect(published.status).toBe(200);
    // One current version per sequence: publishing retired the one it replaced.
    const states = sequenceVersionsResponseSchema
      .parse((await post('/sequences/versions', adminToken, { sequenceId })).body)
      .versions.map(entry => [entry.id, entry.state]);
    expect(states).toEqual([
      [draft?.id, 'published'],
      [sequenceVersionId, 'retired'],
    ]);
    const enrolled = enrollmentsResponseSchema
      .parse((await post('/enrollments', salespersonToken, { contactId, liveOnly: true })).body)
      .enrollments.find(entry => entry.sequenceVersionId === sequenceVersionId);
    expect(enrolled).toBeDefined();
    const payload = { enrollmentId: enrolled?.id, targetSequenceVersionId: draft?.id, changeNote: 'Corrected cadence.' };

    // Another workspace's administrator cannot see it; nobody without a session can ask.
    const betaAdmin = (await issueSessionFor(fixture, fixture.beta, fixture.beta.admin)).accessToken;
    const hidden = await post('/enrollments/migrate', betaAdmin, command(payload));
    expect(hidden.status).toBe(409);
    expect(hidden.body['reason']).toBe('enrollment_unknown');
    expect((await post('/enrollments/migrate', null, command(payload))).status).toBe(401);
    expect((await post('/enrollments/migrate', salespersonToken, command({ ...payload, extra: true }))).status).toBe(400);

    const first = command(payload);
    const migrated = await post('/enrollments/migrate', salespersonToken, first);
    expect(migrated.status).toBe(200);
    // The contract's fields, and `rescheduledTo` beside them (PR 335 review, P1-6): null
    // here, because nothing was completed and the first step keeps its plan.
    const { rescheduledTo, ...declared } = resultOf(migrated);
    expect(rescheduledTo).toBeNull();
    expect(wireDrift(enrollmentMigrateResultSchema, declared)).toEqual([]);
    const result = enrollmentMigrateResultSchema.parse(resultOf(migrated));
    expect(result).toMatchObject({ oldEnrollmentId: enrolled?.id, carriedOrdinals: [], nextOrdinal: 1 });

    const replay = await post('/enrollments/migrate', salespersonToken, first);
    expect(replay.status).toBe(200);
    expect(resultOf(replay)).toEqual(resultOf(migrated));

    const listed = enrollmentsResponseSchema.parse((await post('/enrollments', salespersonToken, { contactId, liveOnly: false })).body).enrollments;
    expect(listed.find(entry => entry.id === result.oldEnrollmentId)).toMatchObject({ state: 'stopped', endReason: 'migration_superseded' });
    expect(listed.find(entry => entry.id === result.newEnrollmentId)).toMatchObject({ state: 'active', sequenceVersionId: draft?.id });

    const { rows } = await fixture.db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_events
        WHERE workspace_id = $1 AND action = 'enrollment.migrated' AND subject_id = $2`,
      [fixture.alpha.workspaceId, result.newEnrollmentId],
    );
    expect(rows[0]?.count).toBe('1');
  });

  it('leaves no draft behind when it refuses one (lane D1)', async () => {
    const created = await post('/sequences/create', adminToken, command({ name: 'Refused draft' }));
    expect(created.status).toBe(200);
    const refusedSequenceId = String(resultOf(created)['id']);
    // An email step with no template is refused; before lane D1 its version row stayed.
    const refused = await post(
      '/sequences/versions/draft',
      adminToken,
      command({ sequenceId: refusedSequenceId, steps: [{ ordinal: 1, channel: 'email', delay: { unit: 'elapsed', hours: 0 } }] }),
    );
    expect(refused.status).toBe(409);
    expect(refused.body['reason']).toBe('invalid_input');
    const versions = await post('/sequences/versions', adminToken, { sequenceId: refusedSequenceId });
    expect(sequenceVersionsResponseSchema.parse(versions.body).versions).toEqual([]);
  });

  it('answers a second draft request with the draft already there, not a 500', async () => {
    const created = await post('/sequences/create', adminToken, command({ name: 'Two drafts' }));
    expect(created.status).toBe(200);
    const twoDraftsSequenceId = String(resultOf(created)['id']);
    const first = await post('/sequences/versions/draft', adminToken, command({ sequenceId: twoDraftsSequenceId }));
    expect(first.status).toBe(200);
    // A second command id, so this is a second request and not a replay of the first.
    const second = await post('/sequences/versions/draft', adminToken, command({ sequenceId: twoDraftsSequenceId }));
    expect(second.status).toBe(200);
    expect(second.body['replayed']).toBe(false);
    expect(resultOf(second)).toEqual(resultOf(first));
    const versions = await post('/sequences/versions', adminToken, { sequenceId: twoDraftsSequenceId });
    expect(sequenceVersionsResponseSchema.parse(versions.body).versions.map(version => version.state)).toEqual(['draft']);
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
