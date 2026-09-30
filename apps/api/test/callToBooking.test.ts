import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SENDING_STOP_LINE } from '@fss/contracts';
import { repositoryContext, workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import { recordOpportunityValue } from '@fss/domain/crm/stageEvidence.ts';
import { CHANNEL_ACTION_KINDS, composeEligibility } from '@fss/domain/sequences/eligibility.ts';
import { nextUnfinishedExecution, readEnrollment } from '@fss/domain/sequences/rows.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';
import { seedContact, seedFirm } from './support/crmSeed.ts';
import {
  INSIDE_CALLING_WINDOW,
  PUBLIC_ORIGIN,
  startIntegrationServer,
  type IntegrationServer,
} from './support/integrationServer.ts';

/**
 * The call-to-booking walking skeleton (slice W, acceptance 1, 2, 3 and 7), every step a
 * real HTTP request through the real server: the Mac's JSON commands with a real session,
 * Twilio's form callbacks signed as Twilio signs them, Cal.com's JSON signed as Cal.com
 * signs it.
 *
 *   researched firm → POST /calls/session → TwiML <Dial> → status callbacks (settled) →
 *   POST /calls/log interested + one e-mail → the permission and a prepared follow-up the
 *   pause holds → Cal.com BOOKING_CREATED → Demo booked with its evidence, prospecting
 *   stopped → the board card.
 */

const PHONE = '+14015550187';
const CALLER_ID = '+14015550100';
const ATTENDEE = 'partner@lenox-law.example';

describe('the call-to-booking walking skeleton, over HTTP', () => {
  let fixture: AuthFixture;
  let server: IntegrationServer;
  let adminToken = '';
  let salespersonToken = '';
  let firmId = '';
  let contactId = '';
  let routeId = '';
  let identityId = '';
  let opportunityId = '';
  let templateVersionId = '';
  let sequenceVersionId = '';

  const command = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    commandId: randomUUID(),
    clientVersion: CURRENT_CLIENT_VERSION,
    ...extra,
  });

  async function api(path: string, token: string, body: unknown = {}): Promise<{ status: number; text: string; body: Record<string, unknown> }> {
    const response = await fetch(`${server.origin}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) as Record<string, unknown> };
  }

  const resultOf = (answer: { body: Record<string, unknown> }): Record<string, unknown> =>
    (answer.body['result'] ?? {}) as Record<string, unknown>;

  /** A Twilio callback: the form, signed over the pinned external URL and the sorted parameters. */
  async function twilio(
    path: string,
    params: Record<string, string>,
    tamper: { readonly signedUrl?: string; readonly signedParams?: Record<string, string> } = {},
  ): Promise<{ status: number; text: string; contentType: string | null }> {
    const signature = server.twilioSign(tamper.signedUrl ?? `${PUBLIC_ORIGIN}${path}`, tamper.signedParams ?? params);
    const response = await fetch(`${server.origin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature },
      body: new URLSearchParams(params).toString(),
    });
    return { status: response.status, text: await response.text(), contentType: response.headers.get('content-type') };
  }

  async function calcom(body: unknown, tamper?: (raw: string) => string): Promise<{ status: number; body: Record<string, unknown> }> {
    const raw = JSON.stringify(body);
    const signature = server.calcomSign(Buffer.from(raw));
    const response = await fetch(`${server.origin}/integrations/calcom/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cal-signature-256': signature },
      body: tamper === undefined ? raw : tamper(raw),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  const callSid = (): string => `CA${randomBytes(16).toString('hex')}`;
  const voiceParams = (sessionId: string, sid: string, identity?: string): Record<string, string> => ({
    AccountSid: server.accountSid,
    CallSid: sid,
    From: identity ?? `client:${fixture.alpha.salesperson.userId}`,
    Caller: identity ?? `client:${fixture.alpha.salesperson.userId}`,
    sessionId,
  });

  async function newSession(): Promise<string> {
    const created = await api(
      '/calls/session',
      salespersonToken,
      command({ firmId, contactId, routeId, routeVersion: 1, callingIdentityId: identityId }),
    );
    expect(created.status, created.text).toBe(200);
    // The renderer never receives the number: not in the result, not anywhere in the body.
    expect(created.text).not.toContain(PHONE);
    expect(created.text).not.toContain(PHONE.slice(1));
    return String(resultOf(created)['sessionId']);
  }

  beforeAll(async () => {
    fixture = await createAuthFixture();
    server = await startIntegrationServer(fixture, { callerIdE164: CALLER_ID });
    adminToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;
    salespersonToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)).accessToken;

    // David's switches, through the settings command an admin uses.
    for (const [settingKey, value] of [
      ['calling_provider', { provider: 'twilio' }],
      ['calendar_integration', { integration: 'calcom' }],
      ['telephony_budget', { dailyCeilingCents: 500, maxMinutesPerCall: 30, unitPriceMicros: 14_000 }],
    ] as const) {
      const saved = await api('/settings/update', adminToken, command({ settingKey, value }));
      expect(saved.status, saved.text).toBe(200);
    }

    // A researched firm: the zone resolved, a website, a person, a number, an address,
    // an open opportunity in Interested and research's estimated monthly value.
    firmId = await seedFirm(fixture, {
      name: 'Lenox Test Law',
      regionCode: 'RI',
      postalCode: '02903',
      website: 'https://www.lenox-law.example',
      assignedUserId: fixture.alpha.salesperson.userId,
    });
    expect((await api('/firms/resolve-zone', adminToken, command({ firmId }))).status).toBe(200);
    contactId = await seedContact(fixture, { firmId, fullName: 'Dana Example' });
    const phone = await api(
      '/contacts/routes/add',
      salespersonToken,
      command({ firmId, contactId, routeKind: 'phone', value: PHONE, source: 'salesperson', technicalValidation: 'passed', associationConfidence: 0.95 }),
    );
    expect(phone.status, phone.text).toBe(200);
    routeId = String(resultOf(phone)['id']);
    const email = await api(
      '/contacts/routes/add',
      salespersonToken,
      command({ firmId, contactId, routeKind: 'email', value: ATTENDEE, source: 'salesperson', technicalValidation: 'passed', associationConfidence: 0.95 }),
    );
    expect(email.status, email.text).toBe(200);
    const identity = await api('/calling-identities/register', salespersonToken, command({ e164: CALLER_ID }));
    expect(identity.status, identity.text).toBe(200);
    identityId = String((resultOf(identity)['identity'] as { id?: string } | undefined)?.id);
    expect((await api('/postures/allow', adminToken, command({ states: ['RI'], confirmed: true }))).status).toBe(200);
    const opened = await api('/opportunities/open', salespersonToken, command({ firmId }));
    expect(opened.status, opened.text).toBe(200);
    opportunityId = String(resultOf(opened)['id']);
    const system = repositoryContext(workspaceScope(fixture.alpha.workspaceId, { kind: 'system', component: 'worker' }), fixture.db);
    expect((await recordOpportunityValue(system, { opportunityId, monthlyCents: 29_900, kind: 'estimated', source: 'research' })).ok).toBe(true);

    // The overview David promises on the call: approved bytes, and the one-step
    // sequence a single-email permission may run.
    const template = await api(
      '/templates/create',
      adminToken,
      command({
        name: 'Overview',
        subject: 'A question about {firm_name}',
        body: `Hello {contact_first_name},\n\nA note about {firm_name}.\n\nSam Example\nCallie\n${SENDING_STOP_LINE}`,
        footerSignOff: 'Sam Example\nCallie',
        requiredVariables: ['firm_name', 'contact_first_name'],
        approve: true,
      }),
    );
    expect(template.status, template.text).toBe(200);
    templateVersionId = String(resultOf(template)['id']);
    const sequence = await api('/sequences/create', adminToken, command({ name: 'Overview follow-up' }));
    const draft = await api(
      '/sequences/versions/draft',
      adminToken,
      command({
        sequenceId: String(resultOf(sequence)['id']),
        steps: [{ ordinal: 1, channel: 'email', delay: { unit: 'elapsed', hours: 0 }, templateVersionId }],
      }),
    );
    expect(draft.status, draft.text).toBe(200);
    sequenceVersionId = String(resultOf(draft)['sequenceVersionId']);
    expect((await api('/sequences/versions/publish', adminToken, command({ sequenceVersionId }))).status).toBe(200);
  });

  afterAll(async () => {
    await server.close();
    await fixture.stop();
  });

  it('runs a researched firm through a Twilio call to a Cal.com booking and a Demo booked card', async () => {
    // ---- the session: authorized, reserved, no number --------------------------------
    const sessionId = await newSession();
    const reservation = async (): Promise<{ state: string; cents: number; settled_cents: number }> => {
      const { rows } = await fixture.db.query<{ state: string; cents: number; settled_cents: number }>(
        `SELECT r.state, r.cents, r.settled_cents FROM call_sessions s
           JOIN provider_reservations r ON r.workspace_id = s.workspace_id AND r.id = s.reservation_id WHERE s.id = $1`,
        [sessionId],
      );
      return rows[0] ?? { state: 'missing', cents: 0, settled_cents: 0 };
    };
    expect(await reservation()).toMatchObject({ state: 'reserved', cents: 42 });

    // ---- TwiML: the server-resolved number, the verified caller id, recorded ----------
    const parent = callSid();
    const twiml = await twilio('/integrations/twilio/voice', voiceParams(sessionId, parent));
    expect(twiml.status).toBe(200);
    expect(twiml.contentType).toContain('text/xml');
    expect(twiml.text).toContain(`<Dial callerId="${CALLER_ID}" record="record-from-answer-dual" timeLimit="1800"`);
    expect(twiml.text).toContain(`action="${PUBLIC_ORIGIN}/integrations/twilio/status"`);
    expect(twiml.text).toContain(`recordingStatusCallback="${PUBLIC_ORIGIN}/integrations/twilio/recording"`);
    expect(twiml.text).toContain(`<Number statusCallback="${PUBLIC_ORIGIN}/integrations/twilio/status"`);
    expect(twiml.text).toContain(`>${PHONE}</Number>`);
    expect(await reservation()).toMatchObject({ state: 'calling' });

    // ---- the status callbacks, as the dialled leg reports them ------------------------
    const child = callSid();
    for (const [status, extra] of [
      ['ringing', {}],
      ['in-progress', {}],
      ['completed', { CallDuration: '125' }],
    ] as const) {
      const answer = await twilio('/integrations/twilio/status', {
        AccountSid: server.accountSid,
        CallSid: child,
        ParentCallSid: parent,
        CallStatus: status,
        ...extra,
      });
      expect(answer.status, status).toBe(200);
    }
    // The <Dial action> arrives too, and changes nothing that is already recorded.
    expect(
      (
        await twilio('/integrations/twilio/status', {
          AccountSid: server.accountSid,
          CallSid: parent,
          DialCallSid: child,
          DialCallStatus: 'completed',
          DialCallDuration: '125',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await twilio('/integrations/twilio/recording', {
          AccountSid: server.accountSid,
          CallSid: parent,
          RecordingSid: `RE${randomBytes(16).toString('hex')}`,
          RecordingUrl: `https://api.twilio.com/2010-04-01/Accounts/${server.accountSid}/Recordings/RE1`,
          RecordingDuration: '120',
          RecordingStatus: 'completed',
        })
      ).status,
    ).toBe(200);
    const { rows: sessions } = await fixture.db.query<{ status: string; dial_call_sid: string; recording_path: string }>(
      'SELECT status, dial_call_sid, recording_path FROM call_sessions WHERE id = $1',
      [sessionId],
    );
    expect(sessions[0]).toMatchObject({ status: 'completed', dial_call_sid: child });
    expect(sessions[0]?.recording_path).toContain('/Recordings/RE1');
    expect(await reservation()).toMatchObject({ state: 'estimated', settled_cents: 5 });

    // ---- David logs the outcome: interested, one e-mail -------------------------------
    const logged = await api(
      '/calls/log',
      salespersonToken,
      command({ firmId, contactId, callSessionId: sessionId, outcome: 'interested', followUpPermission: { scope: 'single_email', templateVersionId } }),
    );
    expect(logged.status, logged.text).toBe(200);
    const permissionId = String(resultOf(logged)['followUpPermissionId']);
    expect(permissionId).toMatch(/^[0-9a-f-]{36}$/u);
    const { rows: linked } = await fixture.db.query<{ call_log_id: string | null }>(
      'SELECT call_log_id FROM call_sessions WHERE id = $1',
      [sessionId],
    );
    expect(linked[0]?.call_log_id).toBe(resultOf(logged)['callLogId']);

    // ---- the prepared follow-up, held by the pause as production is ---------------------
    const enrolled = await api(
      '/enrollments/enroll',
      salespersonToken,
      command({ sequenceVersionId, opportunityId, firmId, contactId, originKind: 'follow_up', permissionId }),
    );
    expect(enrolled.status, enrolled.text).toBe(200);
    const followUpEnrollmentId = String(resultOf(enrolled)['enrollmentId']);
    expect((await api('/pauses/open', adminToken, command({ scopeKind: 'channel', channel: 'email', reasonNote: 'sending stays paused' }))).status).toBe(200);
    const worker = repositoryContext(workspaceScope(fixture.alpha.workspaceId, { kind: 'system', component: 'worker' }), fixture.db);
    const enrollment = await readEnrollment(worker, { enrollmentId: followUpEnrollmentId });
    const execution = await nextUnfinishedExecution(worker, followUpEnrollmentId);
    if (enrollment === null || execution === null) throw new Error('the follow-up has no step');
    const held = await composeEligibility().evaluate(worker, {
      execution,
      opportunityId: enrollment.opportunityId,
      firmId: enrollment.firmId,
      contactId: enrollment.contactId,
      ownerUserId: enrollment.assignedUserId,
      channel: execution.channel,
      actionKind: CHANNEL_ACTION_KINDS[execution.channel],
      now: new Date().toISOString(),
    });
    expect(held).toMatchObject({ ok: false, reasonCode: 'scoped_pause' });

    // A cold prospecting enrollment of a colleague at the same firm (one active enrollment
    // per person), which the booking must stop.
    const colleagueId = await seedContact(fixture, { firmId, fullName: 'Robin Example' });
    const { rows: prospecting } = await fixture.db.query<{ id: string }>(
      `INSERT INTO sequence_enrollments
         (workspace_id, sequence_version_id, opportunity_id, firm_id, contact_id, assigned_user_id,
          firm_time_zone, holiday_calendar_version, origin_kind)
       SELECT workspace_id, sequence_version_id, opportunity_id, firm_id, $2, assigned_user_id,
              firm_time_zone, holiday_calendar_version, 'cold_legacy'
         FROM sequence_enrollments WHERE id = $1
       RETURNING id`,
      [followUpEnrollmentId, colleagueId],
    );
    const prospectingId = prospecting[0]?.id ?? '';

    // ---- Cal.com: the booking -----------------------------------------------------------
    const booked = await calcom({
      triggerEvent: 'BOOKING_CREATED',
      createdAt: '2026-09-30T16:00:00.000Z',
      payload: {
        uid: 'lenoxdemo1',
        startTime: '2026-10-06T15:00:00.000Z',
        endTime: '2026-10-06T15:30:00.000Z',
        organizer: { email: 'david@usecallie.example' },
        attendees: [{ email: ATTENDEE, name: 'Dana Example' }],
      },
    });
    expect(booked).toMatchObject({ status: 200, body: { status: 'accepted', duplicate: false, outcome: 'applied', meetingState: 'booked' } });

    const { rows: stage } = await fixture.db.query<{ key: string }>(
      `SELECT s.key FROM opportunities o JOIN pipeline_stages s ON s.workspace_id = o.workspace_id AND s.id = o.stage_id WHERE o.id = $1`,
      [opportunityId],
    );
    expect(stage[0]?.key).toBe('demo_booked');
    const { rows: evidence } = await fixture.db.query<{ evidence_kind: string; reason: string }>(
      `SELECT x.evidence_kind, e.reason FROM opportunity_stage_evidence x
         JOIN opportunity_stage_events e ON e.workspace_id = x.workspace_id AND e.id = x.stage_event_id
        WHERE x.opportunity_id = $1`,
      [opportunityId],
    );
    expect(evidence).toEqual([{ evidence_kind: 'meeting.booked', reason: 'evidence:meeting.booked' }]);
    const { rows: states } = await fixture.db.query<{ id: string; state: string }>(
      'SELECT id, state FROM sequence_enrollments WHERE id = ANY($1::uuid[]) ORDER BY id',
      [[followUpEnrollmentId, prospectingId]],
    );
    expect(Object.fromEntries(states.map(row => [row.id, row.state]))).toEqual({
      [followUpEnrollmentId]: 'active',
      [prospectingId]: 'stopped',
    });

    // ---- the board --------------------------------------------------------------------
    const board = await api('/pipeline/board', salespersonToken, {});
    expect(board.status).toBe(200);
    const columns = board.body['columns'] as { stage: { key: string; displayName: string }; firms: { id: string }[] }[];
    expect(columns.map(column => column.stage.displayName)).toEqual(['Interested', 'Demo booked', 'Decision pending', 'Onboarding', 'Live']);
    expect(columns.find(column => column.firms.some(entry => entry.id === firmId))?.stage.key).toBe('demo_booked');
    const card = (board.body['cards'] as Record<string, Record<string, unknown>>)[firmId];
    expect(card).toMatchObject({
      value: { monthlyCents: 29_900, kind: 'estimated' },
      meeting: { state: 'booked', startsAt: '2026-10-06T15:00:00.000Z' },
      evidence: { kind: 'meeting.booked' },
    });

    // ---- the funnel ---------------------------------------------------------------------
    const { rows: facts } = await fixture.db.query<{ kind: string }>(
      "SELECT kind FROM funnel_facts WHERE workspace_id = $1 AND kind IN ('call.placed', 'call.connected', 'meeting.booked') ORDER BY kind",
      [fixture.alpha.workspaceId],
    );
    expect(facts.map(row => row.kind)).toEqual(['call.connected', 'call.placed', 'meeting.booked']);
  });

  it('refuses a replayed TwiML request and a second use of a session', async () => {
    const sessionId = await newSession();
    const sid = callSid();
    expect((await twilio('/integrations/twilio/voice', voiceParams(sessionId, sid))).text).toContain('<Dial');
    const replay = await twilio('/integrations/twilio/voice', voiceParams(sessionId, sid));
    const secondUse = await twilio('/integrations/twilio/voice', voiceParams(sessionId, callSid()));
    for (const answer of [replay, secondUse]) {
      expect(answer.status).toBe(200);
      expect(answer.text).toContain('<Say>');
      expect(answer.text).toContain('<Hangup/>');
      expect(answer.text).not.toContain(PHONE);
    }
  });

  it('refuses a session for another identity than the token s', async () => {
    const sessionId = await newSession();
    const answer = await twilio('/integrations/twilio/voice', voiceParams(sessionId, callSid(), `client:${fixture.alpha.admin.userId}`));
    expect(answer.text).toContain('<Hangup/>');
    expect(answer.text).not.toContain(PHONE);
  });

  it('refuses an expired session', async () => {
    const sessionId = await newSession();
    await fixture.db.query("UPDATE call_sessions SET expires_at = now() - INTERVAL '1 second' WHERE id = $1", [sessionId]);
    const answer = await twilio('/integrations/twilio/voice', voiceParams(sessionId, callSid()));
    expect(answer.text).toContain('<Hangup/>');
  });

  it('answers a signed callback for an unknown Call SID with 200, and logs it', async () => {
    const answer = await twilio('/integrations/twilio/status', {
      AccountSid: server.accountSid,
      CallSid: callSid(),
      CallStatus: 'completed',
    });
    expect(answer.status).toBe(200);
    expect(server.log.lines.some(line => line['event'] === 'twilio_callback_unknown_sid')).toBe(true);
  });

  // ---- acceptance 7: the ingress -------------------------------------------------------
  it('refuses a Twilio request whose body was tampered with after signing', async () => {
    const sessionId = await newSession();
    const params = voiceParams(sessionId, callSid());
    const answer = await twilio('/integrations/twilio/voice', { ...params, From: 'client:somebody-else' }, { signedParams: params });
    expect(answer.status).toBe(401);
    expect(answer.text).not.toContain(PHONE);
  });

  it('refuses a Twilio request signed for another URL', async () => {
    const sessionId = await newSession();
    const params = voiceParams(sessionId, callSid());
    for (const signedUrl of [
      `${PUBLIC_ORIGIN}/integrations/twilio/voice?extra=1`,
      `https://attacker.example/integrations/twilio/voice`,
      `http://127.0.0.1:${String(server.port)}/integrations/twilio/voice`,
    ]) {
      expect((await twilio('/integrations/twilio/voice', params, { signedUrl })).status, signedUrl).toBe(401);
    }
  });

  it('builds the signed URL from the pinned origin, never from the Host header', async () => {
    const sessionId = await newSession();
    const params = voiceParams(sessionId, callSid());
    const signature = server.twilioSign('https://evil.example/integrations/twilio/voice', params);
    const response = await fetch(`${server.origin}/integrations/twilio/voice`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': signature,
        'x-forwarded-host': 'evil.example',
        'x-forwarded-proto': 'https',
      },
      body: new URLSearchParams(params).toString(),
    });
    expect(response.status).toBe(401);
  });

  it('refuses the wrong content type on each integration path, and a form everywhere else', async () => {
    const json = await fetch(`${server.origin}/integrations/twilio/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(json.status).toBe(415);
    const form = await fetch(`${server.origin}/integrations/calcom/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'a=b',
    });
    expect(form.status).toBe(415);
    const elsewhere = await fetch(`${server.origin}/calls/log`, {
      method: 'POST',
      headers: { authorization: `Bearer ${salespersonToken}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'a=b',
    });
    expect(elsewhere.status).toBe(415);
  });

  it('refuses an oversized integration body', async () => {
    const big = 'x'.repeat(70 * 1024);
    const twilioAnswer = await fetch(`${server.origin}/integrations/twilio/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `CallSid=${big}`,
    });
    expect(twilioAnswer.status).toBe(413);
    const calcomAnswer = await fetch(`${server.origin}/integrations/calcom/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ padding: big }),
    });
    expect(calcomAnswer.status).toBe(413);
  });

  // ---- acceptance 3: Cal.com --------------------------------------------------------------
  const booking = (trigger: string, createdAt: string, uid: string, extra: Record<string, unknown> = {}) => ({
    triggerEvent: trigger,
    createdAt,
    payload: {
      uid,
      startTime: '2026-10-07T15:00:00.000Z',
      endTime: '2026-10-07T15:30:00.000Z',
      attendees: [{ email: 'someone@elsewhere.example' }],
      ...extra,
    },
  });

  it('refuses a Cal.com delivery whose body was tampered with, and writes nothing', async () => {
    const answer = await calcom(booking('BOOKING_CREATED', '2026-09-30T17:00:00.000Z', 'tampered1'), raw =>
      raw.replace('tampered1', 'tampered2'),
    );
    expect(answer.status).toBe(401);
    const { rows } = await fixture.db.query<{ count: string }>(
      "SELECT count(*) AS count FROM meetings WHERE booking_uid IN ('tampered1', 'tampered2')",
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });

  it('applies a duplicate delivery once', async () => {
    const event = booking('BOOKING_CREATED', '2026-09-30T17:05:00.000Z', 'dupe1');
    expect((await calcom(event)).body).toMatchObject({ duplicate: false });
    expect((await calcom(event)).body).toMatchObject({ duplicate: true });
  });

  it('keeps a meeting cancelled when its create arrives after the cancel', async () => {
    expect((await calcom(booking('BOOKING_CANCELLED', '2026-09-30T18:00:00.000Z', 'ooo1'))).body).toMatchObject({ meetingState: 'cancelled' });
    expect((await calcom(booking('BOOKING_CREATED', '2026-09-30T17:59:00.000Z', 'ooo1'))).body).toMatchObject({
      outcome: 'stale',
      meetingState: 'cancelled',
    });
  });

  it('records a reschedule with the new start, and a no-show mark and unmark back to booked', async () => {
    await calcom(booking('BOOKING_CREATED', '2026-09-30T18:10:00.000Z', 'resched1'));
    const moved = await calcom(
      booking('BOOKING_RESCHEDULED', '2026-09-30T18:20:00.000Z', 'resched2', {
        rescheduleUid: 'resched1',
        startTime: '2026-10-09T13:00:00.000Z',
        endTime: '2026-10-09T13:30:00.000Z',
      }),
    );
    expect(moved.body).toMatchObject({ meetingState: 'rescheduled' });
    const { rows } = await fixture.db.query<{ starts_at: Date }>("SELECT starts_at FROM meetings WHERE booking_uid = 'resched1'");
    expect(rows[0]?.starts_at.toISOString()).toBe('2026-10-09T13:00:00.000Z');

    await calcom(booking('BOOKING_CREATED', '2026-09-30T18:30:00.000Z', 'noshow1'));
    const mark = await calcom({
      triggerEvent: 'BOOKING_NO_SHOW_UPDATED',
      createdAt: '2026-10-07T16:00:00.000Z',
      payload: { bookingUid: 'noshow1', attendees: [{ email: 'someone@elsewhere.example', noShow: true }] },
    });
    expect(mark.body).toMatchObject({ meetingState: 'no_show' });
    const unmark = await calcom({
      triggerEvent: 'BOOKING_NO_SHOW_UPDATED',
      createdAt: '2026-10-07T16:10:00.000Z',
      payload: { bookingUid: 'noshow1', attendees: [{ email: 'someone@elsewhere.example', noShow: false }] },
    });
    expect(unmark.body).toMatchObject({ meetingState: 'booked' });
  });

  it('mints a Voice access token for this user: outgoing only, an hour at most', async () => {
    const answer = await api('/calls/access-token', salespersonToken, {});
    expect(answer.status).toBe(200);
    const token = String(answer.body['token']);
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as {
      grants: { identity: string; voice: Record<string, unknown> };
      iat: number;
      exp: number;
    };
    expect(payload.grants.identity).toBe(fixture.alpha.salesperson.userId);
    expect(Object.keys(payload.grants.voice)).toEqual(['outgoing']);
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(3600);
    expect(answer.body['identity']).toBe(fixture.alpha.salesperson.userId);
    expect(INSIDE_CALLING_WINDOW).toBeDefined();
  });
  // Last in this block: the suppression is permanent, and every test above needs the firm callable.
  it('refuses at TwiML when a suppression lands after authorization, and at /calls/session after it', async () => {
    const sessionId = await newSession();
    const suppressed = await api(
      '/suppressions/record',
      salespersonToken,
      command({ scope: 'firm', firmId, source: 'prospect_do_not_call' }),
    );
    expect(suppressed.status, suppressed.text).toBe(200);
    const answer = await twilio('/integrations/twilio/voice', voiceParams(sessionId, callSid()));
    expect(answer.text).toContain('<Hangup/>');
    expect(answer.text).not.toContain(PHONE);
    const refused = await api(
      '/calls/session',
      salespersonToken,
      command({ firmId, contactId, routeId, routeVersion: 1, callingIdentityId: identityId }),
    );
    expect(refused).toMatchObject({ status: 409, body: { reason: 'firm_suppressed' } });
  });

});

// ---- acceptance 6: with the defaults, nothing new answers ---------------------------------
describe('the call-to-booking routes with the switches at their defaults', () => {
  let fixture: AuthFixture;
  let server: IntegrationServer;
  let token = '';

  beforeAll(async () => {
    fixture = await createAuthFixture();
    server = await startIntegrationServer(fixture);
    token = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)).accessToken;
  });

  afterAll(async () => {
    await server.close();
    await fixture.stop();
  });

  it('answers 404 on every new route, signed or not', async () => {
    for (const path of ['/calls/session', '/calls/access-token']) {
      const response = await fetch(`${server.origin}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ commandId: randomUUID(), clientVersion: CURRENT_CLIENT_VERSION }),
      });
      expect(response.status, path).toBe(404);
    }
    for (const path of ['/integrations/twilio/voice', '/integrations/twilio/status', '/integrations/twilio/recording']) {
      const params = { AccountSid: server.accountSid, CallSid: `CA${'0'.repeat(32)}` };
      const response = await fetch(`${server.origin}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-twilio-signature': server.twilioSign(`${PUBLIC_ORIGIN}${path}`, params),
        },
        body: new URLSearchParams(params).toString(),
      });
      expect(response.status, path).toBe(404);
    }
    const raw = JSON.stringify({ triggerEvent: 'BOOKING_CREATED', createdAt: '2026-09-30T12:00:00Z', payload: { uid: 'x1' } });
    const calcomAnswer = await fetch(`${server.origin}/integrations/calcom/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cal-signature-256': server.calcomSign(Buffer.from(raw)) },
      body: raw,
    });
    expect(calcomAnswer.status).toBe(404);
  });
});
