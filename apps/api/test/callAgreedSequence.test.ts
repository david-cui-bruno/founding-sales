import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SENDING_STOP_LINE, followUpPreviewResponseSchema, loggedCallResultSchema } from '@fss/contracts';
import { repositoryContext, workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import { controlModeSource } from '@fss/domain/sequences/eligibility.ts';
import { listStepExecutions } from '@fss/domain/sequences/rows.ts';
import { consumeTerminalStops } from '@fss/domain/sequences/terminalStops.ts';
import { placeEmailSend } from '@fss/domain/src/rules/sendingWindow.ts';
import { createAuthFixture, type AuthFixture, type SeededWorkspace } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';
import { seedContact, seedFirm } from './support/crmSeed.ts';
import { DESKTOP_VERSION_UNDER_TEST, routeAnswer } from './support/wireThrough.ts';

/**
 * The call card's agreed sequence, end to end through the real routes (send-path v2,
 * slice S3).
 *
 * David, 30 September 2026: *"Include no email / one approved email / an agreed approved
 * sequence in the first calling-to-booking milestone. Show the messages and timing and
 * record the prospect's agreement. Starting an agreed sequence should not require an API
 * command."*
 *
 * So `POST /calls/log` with `{ scope: 'agreed_sequence', sequenceVersionId }` on an
 * interested call must, in one command and in this order after the engaged-call stop:
 * record the agreement on the call log, grant the `agreed_sequence` permission bound to
 * that version, and enrol the contact on it (`origin_kind = 'follow_up'`, the permission
 * bound to the enrollment). The new enrollment has to survive the terminal-stop drain
 * that the same call's manual-mode event feeds; a refused enrolment leaves the permission
 * standing, unbound, and says `follow_up_not_enrolled`.
 *
 * And `POST /calls/follow-up-preview` must say what that enrolment will do — every step,
 * its template and subject, and the instant — with the same arithmetic, so the preview's
 * first due and the enrollment's first due are the same instant.
 *
 * No real person or business appears; `example.test` is reserved by RFC 6761.
 */
describe('an agreed sequence recorded on the call card', () => {
  let fixture: AuthFixture;
  let adminToken = '';
  let salespersonToken = '';
  let betaAdminToken = '';

  const command = (extra: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => ({
    commandId: randomUUID(),
    clientVersion: DESKTOP_VERSION_UNDER_TEST,
    ...extra,
  });
  const post = async (path: string, token: string, body: Readonly<Record<string, unknown>>) =>
    await routeAnswer(fixture, 'POST', path, token, body);
  const result = (answer: { body: unknown }): Record<string, unknown> =>
    ((answer.body as { result?: unknown }).result ?? {}) as Record<string, unknown>;

  /**
   * A published two-step version: an e-mail two business days out and a call task four
   * business days out. Business days, so the workspace's holiday calendar moves them.
   */
  async function publishedVersion(token: string, options: { readonly publish?: boolean } = {}): Promise<string> {
    const template = await post(
      '/templates/create',
      token,
      command({
        name: `Agreed overview ${randomUUID().slice(0, 8)}`,
        subject: 'The overview for {firm_name}',
        body: `Hello {contact_first_name},\n\nThe overview we spoke about.\n\nSam Example\nCallie\n${SENDING_STOP_LINE}`,
        footerSignOff: 'Sam Example\nCallie',
        requiredVariables: ['firm_name', 'contact_first_name'],
        approve: true,
      }),
    );
    expect(template.status, JSON.stringify(template.body)).toBe(200);
    const templateVersionId = String(result(template)['id']);
    const sequence = await post('/sequences/create', token, command({ name: `Agreed plan ${randomUUID().slice(0, 8)}` }));
    expect(sequence.status, JSON.stringify(sequence.body)).toBe(200);
    const draft = await post(
      '/sequences/versions/draft',
      token,
      command({
        sequenceId: String(result(sequence)['id']),
        steps: [
          { ordinal: 1, channel: 'email', delay: { unit: 'business_days', days: 2 }, templateVersionId },
          { ordinal: 2, channel: 'call_task', delay: { unit: 'business_days', days: 4 }, onNoAnswer: 'advance' },
        ],
      }),
    );
    expect(draft.status, JSON.stringify(draft.body)).toBe(200);
    const sequenceVersionId = String(result(draft)['sequenceVersionId']);
    if (options.publish !== false) {
      const published = await post('/sequences/versions/publish', token, command({ sequenceVersionId }));
      expect(published.status, JSON.stringify(published.body)).toBe(200);
    }
    return sequenceVersionId;
  }

  interface Scene {
    readonly firmId: string;
    readonly contactId: string;
    readonly opportunityId: string | null;
  }

  /** A firm assigned to the salesperson, with a zone, a person and (by default) an open opportunity. */
  async function scene(
    name: string,
    options: { readonly zone?: boolean; readonly opportunity?: boolean } = {},
  ): Promise<Scene> {
    const firmId = await seedFirm(fixture, {
      name,
      regionCode: 'RI',
      postalCode: '02903',
      assignedUserId: fixture.alpha.salesperson.userId,
    });
    if (options.zone !== false) {
      await fixture.db.query(
        `UPDATE firms SET time_zone = 'America/New_York', time_zone_confidence = 'high',
                time_zone_source = 'postal', time_zone_rule_version = 'firm-zone.1'
          WHERE workspace_id = $1 AND id = $2`,
        [fixture.alpha.workspaceId, firmId],
      );
    }
    const contactId = await seedContact(fixture, { firmId, fullName: 'Dana Example' });
    let opportunityId: string | null = null;
    if (options.opportunity !== false) {
      const opened = await post('/opportunities/open', salespersonToken, command({ firmId }));
      expect(opened.status, JSON.stringify(opened.body)).toBe(200);
      opportunityId = String(result(opened)['id']);
    }
    return { firmId, contactId, opportunityId };
  }

  async function logInterested(
    at: Scene,
    followUpPermission: Readonly<Record<string, unknown>>,
    extra: Readonly<Record<string, unknown>> = {},
  ) {
    return await post(
      '/calls/log',
      salespersonToken,
      command({ firmId: at.firmId, contactId: at.contactId, outcome: 'interested', followUpPermission, ...extra }),
    );
  }

  const workerContext = (workspace: SeededWorkspace = fixture.alpha) =>
    repositoryContext(workspaceScope(workspace.workspaceId, { kind: 'system', component: 'worker' }), fixture.db);

  async function rowsAt(table: string, firmId: string): Promise<readonly Record<string, unknown>[]> {
    const { rows } = await fixture.db.query<Record<string, unknown>>(
      `SELECT * FROM ${table} WHERE workspace_id = $1 AND firm_id = $2`,
      [fixture.alpha.workspaceId, firmId],
    );
    return rows;
  }

  beforeAll(async () => {
    fixture = await createAuthFixture();
    adminToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;
    salespersonToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)).accessToken;
    betaAdminToken = (await issueSessionFor(fixture, fixture.beta, fixture.beta.admin)).accessToken;
  });

  afterAll(async () => {
    await fixture.stop();
  });

  it('records the agreement, grants the permission, enrols — and the enrollment survives the drain', async () => {
    const sequenceVersionId = await publishedVersion(adminToken);
    const at = await scene('Cedar Test Advisers');

    // A cold prospecting enrollment is live at the firm before the call: the engaged-call
    // stop must end it, and the agreed sequence must replace it rather than be refused.
    const coldVersionId = await publishedVersion(adminToken);
    const cold = await post(
      '/enrollments/enroll',
      salespersonToken,
      command({
        sequenceVersionId: coldVersionId,
        opportunityId: at.opportunityId,
        firmId: at.firmId,
        contactId: at.contactId,
        originKind: 'prospecting',
      }),
    );
    expect(cold.status, JSON.stringify(cold.body)).toBe(200);
    const coldEnrollmentId = String(result(cold)['enrollmentId']);

    const logged = await logInterested(at, { scope: 'agreed_sequence', sequenceVersionId });
    expect(logged.status, JSON.stringify(logged.body)).toBe(200);
    const answer = loggedCallResultSchema.parse(result(logged));
    expect(answer.setManual).toBe(true);
    const enrolled = answer.followUps.find(entry => entry.kind === 'agreed_sequence_enrolled');
    expect(enrolled, JSON.stringify(answer.followUps)).toBeDefined();
    expect(answer.followUps.map(entry => entry.kind)).toEqual(['agreed_sequence_enrolled']);
    const enrollmentId = enrolled?.enrollmentId ?? '';

    // 1. The call log records what was agreed.
    const [log] = await rowsAt('call_logs', at.firmId);
    expect(log).toMatchObject({
      outcome: 'interested',
      agreed_follow_up: 'agreed_sequence',
      agreed_template_version_id: null,
      agreed_sequence_version_id: sequenceVersionId,
    });

    // 2. The permission rests on that log, is bound to the version, and to the enrollment.
    const permissions = await rowsAt('follow_up_permissions', at.firmId);
    expect(permissions).toHaveLength(1);
    expect(permissions[0]).toMatchObject({
      id: answer.followUpPermissionId,
      scope: 'agreed_sequence',
      kind: 'agreed_sequence',
      contact_id: at.contactId,
      call_log_id: log?.['id'],
      sequence_version_id: sequenceVersionId,
      enrollment_id: enrollmentId,
      max_steps: 2,
    });

    // 3. The enrollment is a follow-up on that permission, and the cold one was stopped.
    const enrollments = await rowsAt('sequence_enrollments', at.firmId);
    const agreed = enrollments.find(row => row['id'] === enrollmentId);
    expect(agreed).toMatchObject({
      origin_kind: 'follow_up',
      permission_id: answer.followUpPermissionId,
      sequence_version_id: sequenceVersionId,
      contact_id: at.contactId,
      ended_at: null,
    });
    const coldRow = enrollments.find(row => row['id'] === coldEnrollmentId);
    expect(coldRow?.['end_reason']).toBe('engaged_call');

    // 4. The drain. The call set the opportunity manual, which wrote an
    //    `opportunity.manual_mode` event; the subscriber consumes it and must stop only
    //    what that event owed — the cold enrollment, already ended — and not the one the
    //    same command created after it (S0's scoped terminal stops).
    const report = await consumeTerminalStops(workerContext());
    expect(report.eventsConsumed).toBeGreaterThanOrEqual(1);
    const { rows: after } = await fixture.db.query<{ ended_at: Date | null; state: string }>(
      'SELECT ended_at, state FROM sequence_enrollments WHERE workspace_id = $1 AND id = $2',
      [fixture.alpha.workspaceId, enrollmentId],
    );
    expect(after[0]?.ended_at).toBeNull();
    const { rows: steps } = await fixture.db.query<{ ordinal: number; state: string }>(
      'SELECT ordinal, state FROM step_executions WHERE workspace_id = $1 AND enrollment_id = $2 ORDER BY ordinal',
      [fixture.alpha.workspaceId, enrollmentId],
    );
    expect(steps).toEqual([{ ordinal: 1, state: 'pending' }]);
  });

  it('previews each step at the instant the enrolment then schedules it', async () => {
    // A holiday calendar covering the next week, so a business-day delay that ignored it
    // would land days earlier than the one enrolment computes.
    const dates: string[] = [];
    for (let day = 0; day < 8; day += 1) {
      dates.push(new Date(Date.now() + day * 86_400_000).toISOString().slice(0, 10));
    }
    const holidays = await post('/sequences/holidays', adminToken, command({ version: `s3-${randomUUID().slice(0, 8)}`, dates }));
    expect(holidays.status, JSON.stringify(holidays.body)).toBe(200);

    const sequenceVersionId = await publishedVersion(adminToken);
    const at = await scene('Aspen Test Advisers');
    const logged = await logInterested(at, { scope: 'agreed_sequence', sequenceVersionId });
    expect(logged.status, JSON.stringify(logged.body)).toBe(200);
    const enrollmentId =
      loggedCallResultSchema.parse(result(logged)).followUps.find(entry => entry.kind === 'agreed_sequence_enrolled')
        ?.enrollmentId ?? '';
    const { rows } = await fixture.db.query<{
      started_at: Date;
      holiday_calendar_version: string;
      firm_time_zone: string;
      due_at: Date;
    }>(
      `SELECT e.started_at, e.holiday_calendar_version, e.firm_time_zone, x.due_at
         FROM sequence_enrollments e JOIN step_executions x
           ON x.workspace_id = e.workspace_id AND x.enrollment_id = e.id
        WHERE e.workspace_id = $1 AND e.id = $2 AND x.ordinal = 1`,
      [fixture.alpha.workspaceId, enrollmentId],
    );
    const enrollment = rows[0];
    expect(enrollment).toBeDefined();

    // Anchored where the enrolment anchored, the preview must say the same instant.
    const preview = await post('/calls/follow-up-preview', salespersonToken, {
      firmId: at.firmId,
      contactId: at.contactId,
      sequenceVersionId,
      previewAt: enrollment?.started_at.toISOString(),
    });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    const parsed = followUpPreviewResponseSchema.parse(preview.body);
    expect(parsed.firmTimeZone).toBe(enrollment?.firm_time_zone);
    expect(parsed.holidayCalendarVersion).toBe(enrollment?.holiday_calendar_version);
    expect(parsed.steps.map(step => [step.ordinal, step.channel])).toEqual([
      [1, 'email'],
      [2, 'call_task'],
    ]);
    const first = parsed.steps[0];
    expect(first?.dueAt).toBe(enrollment?.due_at.toISOString());
    // The e-mail's expected instant is the send window's placement of that due.
    expect(first?.estimatedAt).toBe(
      placeEmailSend(enrollment?.due_at.toISOString() ?? '', 'America/New_York', {
        calendar: { version: parsed.holidayCalendarVersion, dates },
      }).sendAt,
    );
    expect(first?.subject).toBe('The overview for {firm_name}');
    expect(first?.templateName).toMatch(/^Agreed overview /u);
    expect(first?.templateApproved).toBe(true);
    // The call task counts toward the agreed scope, so it is listed too, with no template.
    expect(parsed.steps[1]).toMatchObject({ channel: 'call_task', templateVersionId: null, subject: null });
    // The holiday week is honoured: nothing falls inside it.
    for (const step of parsed.steps) {
      expect(dates).not.toContain(step.dueAt.slice(0, 10));
    }

    // Without an anchor it answers for the database's now, and it writes nothing.
    const unanchored = await post('/calls/follow-up-preview', salespersonToken, {
      firmId: at.firmId,
      contactId: at.contactId,
      sequenceVersionId,
    });
    expect(unanchored.status).toBe(200);

    // Put the calendar back to empty for the tests that follow.
    const cleared = await post('/sequences/holidays', adminToken, command({ version: `s3-${randomUUID().slice(0, 8)}`, dates: [] }));
    expect(cleared.status).toBe(200);
  });

  it('refuses a preview the enrolment would refuse, and one about somebody else’s firm', async () => {
    const at = await scene('Birch Test Advisers');
    const draftOnly = await publishedVersion(adminToken, { publish: false });
    const foreign = await publishedVersion(betaAdminToken);
    const published = await publishedVersion(adminToken);
    const ask = async (body: Readonly<Record<string, unknown>>, token = salespersonToken) =>
      await post('/calls/follow-up-preview', token, {
        firmId: at.firmId,
        contactId: at.contactId,
        sequenceVersionId: published,
        ...body,
      });
    const reason = (answer: { body: unknown }) => (answer.body as { reason?: string }).reason;

    const unpublished = await ask({ sequenceVersionId: draftOnly });
    expect([unpublished.status, reason(unpublished)]).toEqual([409, 'version_not_published']);
    const otherWorkspace = await ask({ sequenceVersionId: foreign });
    expect([otherWorkspace.status, reason(otherWorkspace)]).toEqual([409, 'version_unknown']);
    const stranger = await ask({ contactId: randomUUID() });
    expect([stranger.status, reason(stranger)]).toEqual([409, 'contact_unknown']);
    const noZone = await scene('Hazel Test Advisers', { zone: false });
    const zoneless = await ask({ firmId: noZone.firmId, contactId: noZone.contactId });
    expect([zoneless.status, reason(zoneless)]).toEqual([409, 'firm_zone_unknown']);
    // A firm in another workspace is the same answer as one that never existed.
    const missing = await ask({ firmId: randomUUID() });
    expect(missing.status).toBe(404);
  });

  describe('refused before the call log is written', () => {
    async function nothingWritten(firmId: string): Promise<void> {
      for (const table of ['call_logs', 'follow_up_permissions', 'sequence_enrollments']) {
        expect(await rowsAt(table, firmId), table).toHaveLength(0);
      }
    }

    it('an agreement that names nobody', async () => {
      const sequenceVersionId = await publishedVersion(adminToken);
      const at = await scene('Maple Test Advisers');
      const answer = await post(
        '/calls/log',
        salespersonToken,
        command({ firmId: at.firmId, outcome: 'interested', followUpPermission: { scope: 'agreed_sequence', sequenceVersionId } }),
      );
      expect([answer.status, (answer.body as { reason?: string }).reason]).toEqual([409, 'invalid_input']);
      await nothingWritten(at.firmId);
    });

    it('an agreement on an outcome that is not a conversation', async () => {
      const sequenceVersionId = await publishedVersion(adminToken);
      const at = await scene('Rowan Test Advisers');
      const answer = await post(
        '/calls/log',
        salespersonToken,
        command({
          firmId: at.firmId,
          contactId: at.contactId,
          outcome: 'voicemail_left',
          followUpPermission: { scope: 'agreed_sequence', sequenceVersionId },
        }),
      );
      expect([answer.status, (answer.body as { reason?: string }).reason]).toEqual([409, 'invalid_input']);
      await nothingWritten(at.firmId);
    });

    it('a version that is not published', async () => {
      const sequenceVersionId = await publishedVersion(adminToken, { publish: false });
      const at = await scene('Alder Test Advisers');
      const answer = await logInterested(at, { scope: 'agreed_sequence', sequenceVersionId });
      expect([answer.status, (answer.body as { reason?: string }).reason]).toEqual([409, 'version_not_published']);
      await nothingWritten(at.firmId);
    });

    it('another workspace’s version', async () => {
      const sequenceVersionId = await publishedVersion(betaAdminToken);
      const at = await scene('Linden Test Advisers');
      const answer = await logInterested(at, { scope: 'agreed_sequence', sequenceVersionId });
      expect([answer.status, (answer.body as { reason?: string }).reason]).toEqual([409, 'version_unknown']);
      await nothingWritten(at.firmId);
    });
  });

  it('keeps the call, its stop and the permission when the enrolment is refused', async () => {
    // The firm's zone was never established: the grant can still bound the agreement
    // (it assumes the business zone for the expiry), but `enrollContact` refuses to
    // invent due instants — `firm_zone_unknown`. The permission must stand, unbound.
    const sequenceVersionId = await publishedVersion(adminToken);
    const at = await scene('Willow Test Advisers', { zone: false });
    const logged = await logInterested(at, { scope: 'agreed_sequence', sequenceVersionId });
    expect(logged.status, JSON.stringify(logged.body)).toBe(200);
    const answer = loggedCallResultSchema.parse(result(logged));
    expect(answer.followUps).toEqual([{ kind: 'follow_up_not_enrolled', reason: 'firm_zone_unknown' }]);
    expect(answer.setManual).toBe(true);
    expect(answer.followUpPermissionId).not.toBeNull();

    const [log] = await rowsAt('call_logs', at.firmId);
    expect(log?.['agreed_sequence_version_id']).toBe(sequenceVersionId);
    const permissions = await rowsAt('follow_up_permissions', at.firmId);
    expect(permissions).toHaveLength(1);
    expect(permissions[0]).toMatchObject({
      id: answer.followUpPermissionId,
      scope: 'agreed_sequence',
      enrollment_id: null,
      revoked_at: null,
    });
    expect(await rowsAt('sequence_enrollments', at.firmId)).toHaveLength(0);
    const { rows: opportunity } = await fixture.db.query<{ control_mode: string }>(
      'SELECT control_mode FROM opportunities WHERE workspace_id = $1 AND id = $2',
      [fixture.alpha.workspaceId, at.opportunityId],
    );
    expect(opportunity[0]?.control_mode).toBe('manual');
  });

  it('opens the opportunity a firm added from the Mac never had, and enrols on it', async () => {
    // `/crm/firms/add` opens no opportunity, and `enrollContact` needs one. The card must
    // still start what the person agreed to without a command of its own (coordinator's
    // decision, 30 September 2026): `logCallOutcome` opens it — stage New, audited with
    // the call named — in the enrolment's savepoint, then enrols.
    const sequenceVersionId = await publishedVersion(adminToken);
    const added = await post(
      '/crm/firms/add',
      salespersonToken,
      command({
        firm: { name: 'Juniper Test Advisers', timeZone: 'America/New_York' },
        contact: { fullName: 'Robin Example' },
      }),
    );
    expect(added.status, JSON.stringify(added.body)).toBe(200);
    const firmId = String(result(added)['firmId']);
    const contactId = String(result(added)['contactId']);
    expect(await rowsAt('opportunities', firmId)).toHaveLength(0);

    const logged = await logInterested(
      { firmId, contactId, opportunityId: null },
      { scope: 'agreed_sequence', sequenceVersionId },
    );
    expect(logged.status, JSON.stringify(logged.body)).toBe(200);
    const answer = loggedCallResultSchema.parse(result(logged));
    const enrolled = answer.followUps.find(entry => entry.kind === 'agreed_sequence_enrolled');
    expect(answer.followUps.map(entry => entry.kind), JSON.stringify(answer.followUps)).toEqual(['agreed_sequence_enrolled']);

    const opportunities = await rowsAt('opportunities', firmId);
    expect(opportunities).toHaveLength(1);
    expect(opportunities[0]?.['status']).toBe('open');
    // Manual, from the engaged call, exactly as an existing opportunity would have been.
    expect(opportunities[0]?.['control_mode']).toBe('manual');
    expect(opportunities[0]?.['control_mode_origin']).toBe('engaged_call');
    expect(answer.setManual).toBe(false);
    const { rows: stage } = await fixture.db.query<{ key: string }>(
      'SELECT key FROM pipeline_stages WHERE workspace_id = $1 AND id = $2',
      [fixture.alpha.workspaceId, opportunities[0]?.['stage_id']],
    );
    expect(stage[0]?.key).toBe('new');
    const [enrollment] = await rowsAt('sequence_enrollments', firmId);
    expect(enrollment).toMatchObject({
      id: enrolled?.enrollmentId,
      opportunity_id: opportunities[0]?.['id'],
      origin_kind: 'follow_up',
      permission_id: answer.followUpPermissionId,
      ended_at: null,
    });

    // Audited: the ordinary opening, the manual mode, and why — naming the interested call.
    const [log] = await rowsAt('call_logs', firmId);
    const { rows: audits } = await fixture.db.query<{ action: string; detail: Record<string, unknown> }>(
      `SELECT action, detail FROM audit_events
        WHERE workspace_id = $1 AND subject_kind = 'opportunity' AND subject_id = $2 ORDER BY occurred_at, action`,
      [fixture.alpha.workspaceId, opportunities[0]?.['id']],
    );
    expect(audits.map(row => row.action).sort()).toEqual([
      'opportunity.manual',
      'opportunity.opened',
      'opportunity.opened_for_agreed_sequence',
    ]);
    expect(audits.find(row => row.action === 'opportunity.opened_for_agreed_sequence')?.detail).toEqual({
      firmId,
      callLogId: log?.['id'],
      outcome: 'interested',
      sequenceVersionId,
    });

    // The manual-mode event it wrote owes nothing — nothing was live at the firm — and the
    // drain leaves the agreed sequence running with its first step still scheduled.
    const { rows: events } = await fixture.db.query<{ owed_enrollment_ids: string[] | null }>(
      `SELECT owed_enrollment_ids FROM crm_domain_events
        WHERE workspace_id = $1 AND firm_id = $2 AND event_kind = 'opportunity.manual_mode'`,
      [fixture.alpha.workspaceId, firmId],
    );
    expect(events.map(row => row.owed_enrollment_ids)).toEqual([[]]);
    await consumeTerminalStops(workerContext());
    const { rows: after } = await fixture.db.query<{ ended_at: Date | null }>(
      'SELECT ended_at FROM sequence_enrollments WHERE workspace_id = $1 AND id = $2',
      [fixture.alpha.workspaceId, enrolled?.enrollmentId],
    );
    expect(after[0]?.ended_at).toBeNull();
    const { rows: steps } = await fixture.db.query<{ ordinal: number; state: string }>(
      'SELECT ordinal, state FROM step_executions WHERE workspace_id = $1 AND enrollment_id = $2 ORDER BY ordinal',
      [fixture.alpha.workspaceId, enrolled?.enrollmentId],
    );
    expect(steps).toEqual([{ ordinal: 1, state: 'pending' }]);

    // "Still runs": the eligibility rule for a follow-up on a manual opportunity. The
    // control-mode source admits it because the origin is a prospect signal.
    const context = repositoryContext(
      workspaceScope(fixture.alpha.workspaceId, { kind: 'system', component: 'scheduler' }),
      fixture.db,
    );
    const execution = (await listStepExecutions(context, { enrollmentId: enrolled?.enrollmentId ?? '' }))[0];
    if (execution === undefined) throw new Error('no first step');
    const verdict = await controlModeSource().evaluate(context, {
      execution,
      opportunityId: String(opportunities[0]?.['id']),
      firmId,
      contactId,
      ownerUserId: fixture.alpha.salesperson.userId,
      channel: 'email',
      actionKind: 'email_send',
      now: new Date().toISOString(),
    });
    expect(verdict).toEqual({ ok: true });
  });

  it('takes the opened opportunity back when the enrolment is then refused', async () => {
    // No zone: the opportunity would open, the enrolment refuses `firm_zone_unknown`, and
    // the savepoint takes both back — only the call, its stop and the permission remain.
    const sequenceVersionId = await publishedVersion(adminToken);
    const at = await scene('Poplar Test Advisers', { zone: false, opportunity: false });
    const logged = await logInterested(at, { scope: 'agreed_sequence', sequenceVersionId });
    expect(logged.status, JSON.stringify(logged.body)).toBe(200);
    const answer = loggedCallResultSchema.parse(result(logged));
    expect(answer.followUps).toEqual([{ kind: 'follow_up_not_enrolled', reason: 'firm_zone_unknown' }]);
    expect(answer.followUpPermissionId).not.toBeNull();
    expect(await rowsAt('opportunities', at.firmId)).toHaveLength(0);
  });
});
