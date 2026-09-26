import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  enrollmentsResponseSchema,
  resumePreviewResponseSchema,
  sequenceVersionsResponseSchema,
  sequencesResponseSchema,
  templateCommandResultSchema,
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
    expect(resultOf(approved)['warnings']).toEqual([]);
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
      }),
    );
    expect(created.status).toBe(200);
    const expected = ['template_body_multiple_urls', 'template_body_too_long', 'template_pricing_or_guarantee_language'];
    expect(templateCommandResultSchema.parse(resultOf(created)).warnings.sort()).toEqual(expected);

    const approved = await post('/templates/approve', adminToken, command({ templateVersionId: String(resultOf(created)['id']) }));
    expect(approved.status).toBe(200);
    const result = templateCommandResultSchema.parse(resultOf(approved));
    expect(result.approvedAt).not.toBeNull();
    expect(result.warnings.sort()).toEqual(expected);
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

  it('sends a LinkedIn step stored before 25 September 2026 as a removed step, and reviews its held execution as held (lane A2)', async () => {
    // Migration 0018 keeps `linkedin_task` as a removed channel's stored marker (and
    // dropped the message column), so SQL is the only way left to store one: a
    // published version of a call and then a LinkedIn task.
    const workspaceId = fixture.alpha.workspaceId;
    const created = await post('/sequences/create', adminToken, command({ name: 'Stored with LinkedIn' }));
    expect(created.status).toBe(200);
    const storedSequenceId = String(resultOf(created)['id']);
    const { rows: versionRows } = await fixture.db.query<{ id: string }>(
      'INSERT INTO sequence_versions (workspace_id, sequence_id, version) VALUES ($1, $2, 1) RETURNING id',
      [workspaceId, storedSequenceId],
    );
    const storedVersionId = versionRows[0]?.id ?? '';
    await fixture.db.query(
      `INSERT INTO sequence_steps (workspace_id, sequence_version_id, ordinal, channel, delay_unit, delay_amount, on_no_answer)
       VALUES ($1, $2, 1, 'call_task', 'business_days', 0, 'advance')`,
      [workspaceId, storedVersionId],
    );
    const { rows: stepRows } = await fixture.db.query<{ id: string }>(
      `INSERT INTO sequence_steps (workspace_id, sequence_version_id, ordinal, channel, delay_unit, delay_amount)
       VALUES ($1, $2, 2, 'linkedin_task', 'business_days', 2) RETURNING id`,
      [workspaceId, storedVersionId],
    );
    const linkedInStepId = stepRows[0]?.id ?? '';
    await fixture.db.query(
      `UPDATE sequence_versions SET state = 'published', published_at = now(), published_by_user_id = $3
        WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, storedVersionId, fixture.alpha.admin.userId],
    );

    const versions = await post('/sequences/versions', adminToken, { sequenceId: storedSequenceId });
    expect(versions.status).toBe(200);
    // Before lane A2 this was a `channel` outside the contract, and the Mac refused the answer.
    expect(wireDrift(sequenceVersionsResponseSchema, versions.body)).toEqual([]);
    const [version] = sequenceVersionsResponseSchema.parse(versions.body).versions;
    expect(version?.steps.map(step => step.channel)).toEqual(['call_task', 'removed']);
    expect(version?.steps[1]).toEqual({
      id: linkedInStepId,
      sequenceVersionId: storedVersionId,
      ordinal: 2,
      channel: 'removed',
      removedChannel: 'linkedin',
      delay: { unit: 'business_days', days: 2 },
      onNoAnswer: null,
      templateVersionId: null,
    });
    // Nothing the step carried crosses the wire: no message key of any spelling.
    expect(JSON.stringify(versions.body).toLowerCase()).not.toContain('message');

    // A live enrollment whose LinkedIn execution the worker has held.
    const contact = await post('/contacts/create', salespersonToken, command({ firmId, fullName: 'Jordan Placeholder' }));
    expect(contact.status).toBe(200);
    const storedContactId = String(resultOf(contact)['id']);
    const { rows: enrollmentRows } = await fixture.db.query<{ id: string }>(
      `INSERT INTO sequence_enrollments
         (workspace_id, sequence_version_id, opportunity_id, firm_id, contact_id, assigned_user_id,
          started_at, firm_time_zone, holiday_calendar_version)
       VALUES ($1, $2, $3, $4, $5, $6, now() - interval '3 days', 'America/New_York', 'us-federal.2026')
       RETURNING id`,
      [workspaceId, storedVersionId, opportunityId, firmId, storedContactId, fixture.alpha.salesperson.userId],
    );
    const storedEnrollmentId = enrollmentRows[0]?.id ?? '';
    const { rows: executionRows } = await fixture.db.query<{ id: string }>(
      `INSERT INTO step_executions
         (workspace_id, enrollment_id, step_id, firm_id, contact_id, channel, ordinal, state, hold_reason_code,
          due_at, not_before, original_due_at, source_zone, rule_version)
       VALUES ($1, $2, $3, $4, $5, 'linkedin_task', 2, 'held', 'long_hold_review',
               now() - interval '1 day', now() - interval '1 day', now() - interval '1 day', 'America/New_York', 'business_days.1')
       RETURNING id`,
      [workspaceId, storedEnrollmentId, linkedInStepId, firmId, storedContactId],
    );

    const review = await post('/enrollments/resume/preview', salespersonToken, { enrollmentId: storedEnrollmentId });
    expect(review.status).toBe(200);
    expect(wireDrift(resumePreviewResponseSchema, review.body)).toEqual([]);
    const { preview } = resumePreviewResponseSchema.parse(review.body);
    expect(preview.steps).toHaveLength(1);
    expect(preview.steps[0]).toMatchObject({
      stepExecutionId: executionRows[0]?.id,
      ordinal: 2,
      channel: 'removed',
      removedChannel: 'linkedin',
      state: 'held',
      heldReason: 'channel_removed',
    });
    expect(preview.steps[0]?.proposedDueAt).toBe(preview.steps[0]?.dueAt);
  });

  it('edits a published version with a stored LinkedIn step as a new draft without it, numbered 1..n (lane D1)', async () => {
    // "Edit as a new draft" sends `/sequences/versions/draft` with no steps, and the server
    // copies the newest published version. It used to copy the `linkedin_task` step too
    // and refuse the whole draft as `invalid_input`, leaving an empty draft behind.
    const workspaceId = fixture.alpha.workspaceId;
    const storedVersion = async (name: string, channels: readonly ('call_task' | 'linkedin_task')[]): Promise<string> => {
      const created = await post('/sequences/create', adminToken, command({ name }));
      expect(created.status).toBe(200);
      const storedSequenceId = String(resultOf(created)['id']);
      const { rows } = await fixture.db.query<{ id: string }>(
        'INSERT INTO sequence_versions (workspace_id, sequence_id, version) VALUES ($1, $2, 1) RETURNING id',
        [workspaceId, storedSequenceId],
      );
      const versionId = rows[0]?.id ?? '';
      for (const [index, channel] of channels.entries()) {
        await fixture.db.query(
          `INSERT INTO sequence_steps (workspace_id, sequence_version_id, ordinal, channel, delay_unit, delay_amount, on_no_answer)
           VALUES ($1, $2, $3, $4, 'business_days', $5, $6)`,
          [workspaceId, versionId, index + 1, channel, index * 2, channel === 'call_task' ? 'advance' : null],
        );
      }
      await fixture.db.query(
        `UPDATE sequence_versions SET state = 'published', published_at = now(), published_by_user_id = $3
          WHERE workspace_id = $1 AND id = $2`,
        [workspaceId, versionId, fixture.alpha.admin.userId],
      );
      return storedSequenceId;
    };
    const versionsOf = async (storedSequenceId: string) => {
      const answer = await post('/sequences/versions', adminToken, { sequenceId: storedSequenceId });
      expect(answer.status).toBe(200);
      expect(wireDrift(sequenceVersionsResponseSchema, answer.body)).toEqual([]);
      return sequenceVersionsResponseSchema.parse(answer.body).versions;
    };

    // LinkedIn, call, LinkedIn, call: the draft is the two calls, at 1 and 2, with their delays.
    const mixedSequenceId = await storedVersion('LinkedIn between calls', ['linkedin_task', 'call_task', 'linkedin_task', 'call_task']);
    const draft = await post('/sequences/versions/draft', adminToken, command({ sequenceId: mixedSequenceId }));
    expect(draft.status).toBe(200);
    expect(resultOf(draft)['version']).toBe(2);
    const [newest, published] = await versionsOf(mixedSequenceId);
    expect(newest?.id).toBe(resultOf(draft)['sequenceVersionId']);
    expect(newest?.state).toBe('draft');
    expect(newest?.steps.map(step => [step.ordinal, step.channel, step.delay])).toEqual([
      [1, 'call_task', { unit: 'business_days', days: 2 }],
      [2, 'call_task', { unit: 'business_days', days: 6 }],
    ]);
    // The published version is as it was: its LinkedIn steps are still shown, greyed.
    expect(published?.steps.map(step => step.channel)).toEqual(['removed', 'call_task', 'removed', 'call_task']);

    // Only LinkedIn: a draft may be empty, so the draft has no steps; publishing it is
    // what refuses, for `version_has_no_steps`.
    const onlySequenceId = await storedVersion('Only LinkedIn', ['linkedin_task']);
    const empty = await post('/sequences/versions/draft', adminToken, command({ sequenceId: onlySequenceId }));
    expect(empty.status).toBe(200);
    const [emptyDraft] = await versionsOf(onlySequenceId);
    expect(emptyDraft?.state).toBe('draft');
    expect(emptyDraft?.steps).toEqual([]);
    const publish = await post('/sequences/versions/publish', adminToken, command({ sequenceVersionId: emptyDraft?.id }));
    expect(publish.status).toBe(409);
    expect(publish.body['reason']).toBe('version_has_no_steps');
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
