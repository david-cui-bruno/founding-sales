import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SENDING_STOP_LINE } from '@fss/contracts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';
import { seedContact, seedFirm, seedFollowUpPermission } from './support/crmSeed.ts';
import { startIntegrationServer, type IntegrationServer } from './support/integrationServer.ts';

/**
 * Cal.com depth (slice M1), every step a real HTTP request through the real server:
 * Cal.com's JSON signed as Cal.com signs it, the Mac's commands and reads with a real
 * session.
 *
 *   * an unmatched booking listed, matched to a firm in one command, and the booking's
 *     effects applied exactly as a matched webhook's: Demo booked, prospecting stopped,
 *     the agreed follow-up left running;
 *   * reschedules delivered out of order, a cancelled demo booked again, a cancellation
 *     that does not restart prospecting, a no-show and its reversal;
 *   * and no reminder: Callie enqueues nothing to the attendee on a booking or a
 *     reschedule — Cal.com sends those.
 */

describe('Cal.com depth, over HTTP', () => {
  let fixture: AuthFixture;
  let server: IntegrationServer;
  let adminToken = '';
  let salespersonToken = '';
  let sequenceVersionId = '';
  let firms = 0;
  let uids = 0;

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

  async function get(path: string, token: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(`${server.origin}${path}`, { headers: { authorization: `Bearer ${token}` } });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  const resultOf = (answer: { body: Record<string, unknown> }): Record<string, unknown> =>
    (answer.body['result'] ?? {}) as Record<string, unknown>;

  async function calcom(body: unknown): Promise<Record<string, unknown>> {
    const raw = JSON.stringify(body);
    const response = await fetch(`${server.origin}/integrations/calcom/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cal-signature-256': server.calcomSign(Buffer.from(raw)) },
      body: raw,
    });
    expect(response.status).toBe(200);
    return (await response.json()) as Record<string, unknown>;
  }

  const uid = (): string => {
    uids += 1;
    return `depth${String(uids)}x`;
  };

  const booking = (trigger: string, createdAt: string, bookingUid: string, attendee: string, extra: Record<string, unknown> = {}) => ({
    triggerEvent: trigger,
    createdAt,
    payload: {
      uid: bookingUid,
      startTime: '2026-10-14T15:00:00.000Z',
      endTime: '2026-10-14T15:30:00.000Z',
      organizer: { email: 'david@usecallie.example' },
      attendees: [{ email: attendee, name: 'A Partner' }],
      ...extra,
    },
  });

  interface World {
    readonly firmId: string;
    readonly attendee: string;
    readonly followUpId: string;
    readonly prospectingId: string;
    readonly opportunityId: string;
    readonly contactId: string;
  }

  /**
   * A firm assigned to the salesperson with an open opportunity; the partner who will
   * book (with an address, and an agreed follow-up running), and a colleague on a cold
   * prospecting enrollment the booking must stop.
   */
  async function firmWithWork(options: { readonly withAddress?: boolean } = {}): Promise<World> {
    firms += 1;
    const slug = `depth${String(firms)}`;
    const attendee = `partner@${slug}-law.example`;
    const firmId = await seedFirm(fixture, {
      name: `Depth ${slug} Law`,
      regionCode: 'RI',
      postalCode: '02903',
      assignedUserId: fixture.alpha.salesperson.userId,
    });
    expect((await api('/firms/resolve-zone', adminToken, command({ firmId }))).status).toBe(200);
    const contactId = await seedContact(fixture, { firmId, fullName: 'Dana Example' });
    if (options.withAddress !== false) {
      const route = await api(
        '/contacts/routes/add',
        salespersonToken,
        command({ firmId, contactId, routeKind: 'email', value: attendee, source: 'salesperson', technicalValidation: 'passed', associationConfidence: 0.95 }),
      );
      expect(route.status, route.text).toBe(200);
    }
    const opened = await api('/opportunities/open', salespersonToken, command({ firmId }));
    expect(opened.status, opened.text).toBe(200);
    const opportunityId = String(resultOf(opened)['id']);
    const permissionId = await seedFollowUpPermission(fixture, { firmId, contactId, opportunityId, sequenceVersionId });
    const enrolled = await api(
      '/enrollments/enroll',
      salespersonToken,
      command({ sequenceVersionId, opportunityId, firmId, contactId, originKind: 'follow_up', permissionId }),
    );
    expect(enrolled.status, enrolled.text).toBe(200);
    const followUpId = String(resultOf(enrolled)['enrollmentId']);
    const colleagueId = await seedContact(fixture, { firmId, fullName: 'Robin Example' });
    const { rows } = await fixture.db.query<{ id: string }>(
      `INSERT INTO sequence_enrollments
         (workspace_id, sequence_version_id, opportunity_id, firm_id, contact_id, assigned_user_id,
          firm_time_zone, holiday_calendar_version, origin_kind)
       SELECT workspace_id, sequence_version_id, opportunity_id, firm_id, $2, assigned_user_id,
              firm_time_zone, holiday_calendar_version, 'prospecting'
         FROM sequence_enrollments WHERE id = $1
       RETURNING id`,
      [followUpId, colleagueId],
    );
    return { firmId, attendee, followUpId, prospectingId: rows[0]?.id ?? '', opportunityId, contactId };
  }

  async function enrollmentStates(world: World): Promise<{ followUp: string; prospecting: string }> {
    const { rows } = await fixture.db.query<{ id: string; state: string }>('SELECT id, state FROM sequence_enrollments WHERE id = ANY($1::uuid[])', [
      [world.followUpId, world.prospectingId],
    ]);
    const state = (id: string): string => rows.find(row => row.id === id)?.state ?? 'missing';
    return { followUp: state(world.followUpId), prospecting: state(world.prospectingId) };
  }

  async function stageOf(opportunityId: string): Promise<string | undefined> {
    const { rows } = await fixture.db.query<{ key: string }>(
      'SELECT s.key FROM opportunities o JOIN pipeline_stages s ON s.workspace_id = o.workspace_id AND s.id = o.stage_id WHERE o.id = $1',
      [opportunityId],
    );
    return rows[0]?.key;
  }

  async function firmMeetings(firmId: string): Promise<{ state: string; startsAt: string }[]> {
    const answer = await get(`/meetings/firm?firmId=${firmId}`, salespersonToken);
    expect(answer.status).toBe(200);
    return (answer.body['meetings'] as { state: string; startsAt: string }[]).map(entry => ({ state: entry.state, startsAt: entry.startsAt }));
  }

  beforeAll(async () => {
    fixture = await createAuthFixture();
    server = await startIntegrationServer(fixture);
    adminToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;
    salespersonToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)).accessToken;
    const saved = await api('/settings/update', adminToken, command({ settingKey: 'calendar_integration', value: { integration: 'calcom' } }));
    expect(saved.status, saved.text).toBe(200);

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
    const sequence = await api('/sequences/create', adminToken, command({ name: 'Overview follow-up' }));
    const draft = await api(
      '/sequences/versions/draft',
      adminToken,
      command({
        sequenceId: String(resultOf(sequence)['id']),
        steps: [{ ordinal: 1, channel: 'email', delay: { unit: 'elapsed', hours: 0 }, templateVersionId: String(resultOf(template)['id']) }],
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

  // ---- resolving an unmatched booking -----------------------------------------------
  it('lists an unmatched booking and matches it to its firm as a matched webhook would apply it', async () => {
    const world = await firmWithWork({ withAddress: false });
    const id = uid();
    const received = await calcom(booking('BOOKING_CREATED', '2026-09-30T16:00:00.000Z', id, 'newperson@elsewhere.example'));
    expect(received).toMatchObject({ outcome: 'unmatched', meetingState: 'booked' });
    expect(await enrollmentStates(world)).toEqual({ followUp: 'active', prospecting: 'active' });

    const listed = await get('/meetings/unmatched', salespersonToken);
    expect(listed.status).toBe(200);
    const entry = (listed.body['meetings'] as { meetingId: string; attendeeEmail: string; reason: string }[]).find(
      row => row.attendeeEmail === 'newperson@elsewhere.example',
    );
    expect(entry).toMatchObject({ reason: 'firm_unmatched' });

    const matched = await api('/meetings/match', salespersonToken, command({ meetingId: entry?.meetingId, firmId: world.firmId }));
    expect(matched.status, matched.text).toBe(200);
    expect(resultOf(matched)).toMatchObject({ firmId: world.firmId, state: 'booked', stage: 'moved' });
    expect(await stageOf(world.opportunityId)).toBe('demo_booked');
    expect(await enrollmentStates(world)).toEqual({ followUp: 'active', prospecting: 'stopped' });
    expect(await firmMeetings(world.firmId)).toEqual([{ state: 'booked', startsAt: '2026-10-14T15:00:00.000Z' }]);
    const after = await get('/meetings/unmatched', salespersonToken);
    expect((after.body['meetings'] as { meetingId: string }[]).map(row => row.meetingId)).not.toContain(entry?.meetingId);

    // A second match is refused with its code; so is a firm that is somebody else's.
    const again = await api('/meetings/match', salespersonToken, command({ meetingId: entry?.meetingId, firmId: world.firmId }));
    expect(again).toMatchObject({ status: 409, body: { reason: 'meeting_already_matched' } });
    const other = await seedFirm(fixture, { name: 'Not Yours Law', assignedUserId: fixture.alpha.admin.userId });
    await calcom(booking('BOOKING_CREATED', '2026-09-30T16:05:00.000Z', uid(), 'another@elsewhere.example'));
    const pending = (await get('/meetings/unmatched', salespersonToken)).body['meetings'] as { meetingId: string; attendeeEmail: string }[];
    const theirs = pending.find(row => row.attendeeEmail === 'another@elsewhere.example');
    const refused = await api('/meetings/match', salespersonToken, command({ meetingId: theirs?.meetingId, firmId: other }));
    expect(refused).toMatchObject({ status: 409, body: { reason: 'not_assigned' } });
  });

  // ---- conflicts and rescheduling -----------------------------------------------------
  it('follows reschedules A→B→C delivered out of order to C s time', async () => {
    const world = await firmWithWork();
    const [a, b, c] = [uid(), uid(), uid()];
    await calcom(booking('BOOKING_CREATED', '2026-09-30T17:00:00.000Z', a, world.attendee));
    // B→C arrives before A→B.
    await calcom(
      booking('BOOKING_RESCHEDULED', '2026-09-30T17:20:00.000Z', c, world.attendee, {
        rescheduleUid: b,
        startTime: '2026-10-16T18:00:00.000Z',
        endTime: '2026-10-16T18:30:00.000Z',
      }),
    );
    await calcom(
      booking('BOOKING_RESCHEDULED', '2026-09-30T17:10:00.000Z', b, world.attendee, {
        rescheduleUid: a,
        startTime: '2026-10-15T18:00:00.000Z',
        endTime: '2026-10-15T18:30:00.000Z',
      }),
    );
    expect(await firmMeetings(world.firmId)).toEqual([{ state: 'rescheduled', startsAt: '2026-10-16T18:00:00.000Z' }]);
    expect(await enrollmentStates(world)).toEqual({ followUp: 'active', prospecting: 'stopped' });
  });

  it('keeps a cancelled demo cancelled, books the new one, and does not restart prospecting', async () => {
    const world = await firmWithWork();
    const [first, second] = [uid(), uid()];
    await calcom(booking('BOOKING_CREATED', '2026-09-30T18:00:00.000Z', first, world.attendee));
    expect(await enrollmentStates(world)).toEqual({ followUp: 'active', prospecting: 'stopped' });
    await calcom(booking('BOOKING_CANCELLED', '2026-09-30T18:10:00.000Z', first, world.attendee));

    // The cancellation restarts nothing: prospecting stays stopped, the opportunity stays manual.
    expect(await enrollmentStates(world)).toEqual({ followUp: 'active', prospecting: 'stopped' });
    const { rows: mode } = await fixture.db.query<{ control_mode: string }>('SELECT control_mode FROM opportunities WHERE id = $1', [world.opportunityId]);
    expect(mode[0]?.control_mode).toBe('manual');
    const { rows: live } = await fixture.db.query<{ count: string }>(
      "SELECT count(*) AS count FROM sequence_enrollments WHERE firm_id = $1 AND origin_kind IN ('prospecting', 'cold_legacy') AND ended_at IS NULL",
      [world.firmId],
    );
    expect(Number(live[0]?.count)).toBe(0);

    // Booked again, as a new booking.
    await calcom(booking('BOOKING_CREATED', '2026-09-30T18:20:00.000Z', second, world.attendee, { startTime: '2026-10-21T15:00:00.000Z', endTime: '2026-10-21T15:30:00.000Z' }));
    expect(await firmMeetings(world.firmId)).toEqual([
      { state: 'booked', startsAt: '2026-10-21T15:00:00.000Z' },
      { state: 'cancelled', startsAt: '2026-10-14T15:00:00.000Z' },
    ]);
    expect(await stageOf(world.opportunityId)).toBe('demo_booked');
  });

  it('marks a no-show and takes it back', async () => {
    const world = await firmWithWork();
    const id = uid();
    await calcom(booking('BOOKING_CREATED', '2026-09-30T19:00:00.000Z', id, world.attendee));
    await calcom({
      triggerEvent: 'BOOKING_NO_SHOW_UPDATED',
      createdAt: '2026-10-14T16:00:00.000Z',
      payload: { bookingUid: id, attendees: [{ email: world.attendee, noShow: true }] },
    });
    expect((await firmMeetings(world.firmId))[0]?.state).toBe('no_show');
    await calcom({
      triggerEvent: 'BOOKING_NO_SHOW_UPDATED',
      createdAt: '2026-10-14T16:05:00.000Z',
      payload: { bookingUid: id, attendees: [{ email: world.attendee, noShow: false }] },
    });
    expect((await firmMeetings(world.firmId))[0]?.state).toBe('booked');
  });

  // ---- no reminder of Callie's own ------------------------------------------------------
  it('enqueues no e-mail, no step and no job for the attendee on a booking or a reschedule', async () => {
    const world = await firmWithWork();
    // As text: a JavaScript Date would drop the microseconds and let the rows made just
    // before this instant count as made after it.
    const { rows: clock } = await fixture.db.query<{ at: string }>('SELECT clock_timestamp()::text AS at');
    const since = clock[0]?.at ?? '';
    const [a, b] = [uid(), uid()];
    await calcom(booking('BOOKING_CREATED', '2026-09-30T20:00:00.000Z', a, world.attendee));
    await calcom(booking('BOOKING_RESCHEDULED', '2026-09-30T20:10:00.000Z', b, world.attendee, { rescheduleUid: a, startTime: '2026-10-22T15:00:00.000Z', endTime: '2026-10-22T15:30:00.000Z' }));
    expect(await firmMeetings(world.firmId)).toEqual([{ state: 'rescheduled', startsAt: '2026-10-22T15:00:00.000Z' }]);

    // By identity: nothing addressed to, about, or queued for the person who booked.
    const { rows: outbound } = await fixture.db.query<{ id: string }>(
      `SELECT id FROM outbound_messages
        WHERE workspace_id = $1 AND created_at >= $2::timestamptz
          AND (lower(recipient_address) = $3 OR contact_id = $4 OR subject ILIKE '%' || $3 || '%')`,
      [fixture.alpha.workspaceId, since, world.attendee, world.contactId],
    );
    expect(outbound).toEqual([]);
    const { rows: steps } = await fixture.db.query<{ id: string }>(
      'SELECT id FROM step_executions WHERE workspace_id = $1 AND contact_id = $2 AND created_at >= $3::timestamptz',
      [fixture.alpha.workspaceId, world.contactId, since],
    );
    expect(steps).toEqual([]);
    const { rows: jobs } = await fixture.db.query<{ kind: string }>(
      `SELECT kind FROM jobs
        WHERE workspace_id = $1 AND created_at >= $2::timestamptz
          AND (payload::text ILIKE '%' || $3 || '%' OR payload::text LIKE '%' || $4 || '%'
               OR payload::text LIKE '%' || $5 || '%' OR payload::text LIKE '%' || $6 || '%')`,
      [fixture.alpha.workspaceId, since, world.attendee, world.contactId, world.followUpId, world.firmId],
    );
    expect(jobs).toEqual([]);
    const { rows: enrollments } = await fixture.db.query<{ id: string }>(
      'SELECT id FROM sequence_enrollments WHERE firm_id = $1 AND created_at >= $2::timestamptz',
      [world.firmId, since],
    );
    expect(enrollments).toEqual([]);
  });
});
