import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { withTransaction } from '../../db/queryable.ts';
import { repositoryContext, workspaceScope } from '../../db/workspaceScope.ts';
import {
  BOOKING_ANSWERS_MAX_BYTES,
  BOOKING_ANSWER_VALUE_MAX,
  BOOKING_NOTES_MAX,
  contactLike,
  jsonbTextBytes,
  mergeBookingDetails,
  NO_BOOKING_DETAILS,
  parseApiBookingDetails,
  parseWebhookBookingDetails,
  videoCallUrlOf,
  zoomMeetingIdOfUrl,
  type BookingDetails,
} from '../../meetings/bookingDetails.ts';
import { foldMeetings, MEETING_COLUMNS, parseCalcomEvent, receiveCalcomEvent, type MeetingRow } from '../../meetings/calcom.ts';
import { parseCalcomBooking, reconcileCalcomBookings } from '../../meetings/reconcile.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';

/**
 * Lane M2 (0040): what a booking says besides its times, from Cal.com's webhook and its API,
 * in Cal.com's documented shapes (https://cal.com/docs/developing/guides/automation/webhooks,
 * https://cal.com/docs/api-reference/v2/bookings/get-all-bookings) with synthetic values. No
 * real business or person: every address is `.example`.
 */

// A Zoom passcode, assembled at runtime so no literal looks like a credential.
const PASSCODE = ['Fake', 'Pass', '0040'].join('');
const ZOOM_ID = '81234567890';
const ZOOM_JOIN = `https://us06web.zoom.us/j/${ZOOM_ID}?pwd=${PASSCODE}`;

/** A BOOKING_CREATED payload in Cal.com's shape, with Zoom as the location. */
function createdPayload(uid: string, domain: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    bookerUrl: 'https://cal.example',
    title: 'Callie demo between David and Dana Example',
    startTime: '2026-09-29T15:00:00Z',
    endTime: '2026-09-29T15:30:00Z',
    additionalNotes: 'We manage 300 doors and maintenance requests come in by text.',
    type: 'callie-demo',
    description: 'We manage 300 doors and maintenance requests come in by text.',
    eventTypeId: 123,
    organizer: { id: 1, name: 'David', email: 'host@callie.example', timeZone: 'America/New_York' },
    attendees: [
      { email: `dana@${domain}`, name: 'Dana Example', firstName: 'Dana', lastName: 'Example', timeZone: 'America/New_York' },
      { email: `robin@${domain}`, name: 'Robin Example', firstName: 'Robin', lastName: 'Example', timeZone: 'America/New_York' },
    ],
    customInputs: {},
    responses: {
      name: { label: 'your_name', value: 'Dana Example', isHidden: false },
      email: { label: 'email_address', value: `dana@${domain}`, isHidden: false },
      attendeePhoneNumber: { label: 'phone_number', value: '+14015550100', isHidden: false },
      location: { label: 'location', value: { optionValue: '', value: 'integrations:zoom' }, isHidden: false },
      title: { label: 'what_is_this_meeting_about', isHidden: true },
      notes: { label: 'additional_notes', value: 'We manage 300 doors and maintenance requests come in by text.', isHidden: false },
      guests: { label: 'additional_guests', value: [`robin@${domain}`], isHidden: false },
      rescheduleReason: { label: 'reason_for_reschedule', isHidden: false },
      software: { label: 'Which property management software do you use?', value: 'AppFolio', isHidden: false },
      doors: { label: 'How many doors?', value: 300, isHidden: false },
      channels: { label: 'How do tenants report issues?', value: ['Text', 'Phone'], isHidden: false },
      internal: { label: 'Hidden routing field', value: 'tier-a', isHidden: true },
    },
    userFieldsResponses: {},
    location: 'integrations:zoom',
    iCalUID: `${uid}@cal.example`,
    uid,
    videoCallData: { type: 'zoom_video', id: ZOOM_ID, password: PASSCODE, url: ZOOM_JOIN },
    eventTitle: 'Callie demo',
    eventDescription: '',
    length: 30,
    bookingId: 100,
    metadata: { videoCallUrl: ZOOM_JOIN },
    status: 'ACCEPTED',
    ...extra,
  };
}

describe('booking details: parsing', () => {
  it('reads the webhook payload: title, the first attendee s name, notes, answers, location and the Zoom id', () => {
    const details = parseWebhookBookingDetails(createdPayload('m2a', 'dana.example'));
    expect(details).toEqual({
      title: 'Callie demo between David and Dana Example',
      attendeeName: 'Dana Example',
      notes: 'We manage 300 doors and maintenance requests come in by text.',
      answers: {
        'Which property management software do you use?': 'AppFolio',
        'How many doors?': '300',
        'How do tenants report issues?': 'Text, Phone',
      },
      locationType: 'zoom_video',
      videoCallUrl: `https://us06web.zoom.us/j/${ZOOM_ID}`,
      zoomMeetingId: ZOOM_ID,
      locationNamed: true,
    });
    // The passcode is nowhere, nor the booker's phone number or guests.
    const stored = JSON.stringify(details);
    for (const secret of [PASSCODE, '+14015550100', 'robin@', 'tier-a']) expect(stored).not.toContain(secret);
  });

  it('reads the flat MEETING_ENDED shape, and BOOKING_NO_SHOW_UPDATED carries none', () => {
    const ended = parseCalcomEvent({
      triggerEvent: 'MEETING_ENDED',
      id: 100,
      uid: 'm2b',
      title: 'Callie demo between David and Dana Example',
      description: 'Booked after the call on Tuesday.',
      responses: { software: { label: 'Which property management software do you use?', value: 'Buildium' } },
      startTime: '2026-09-29T15:00:00Z',
      endTime: '2026-09-29T15:30:00Z',
      location: 'integrations:daily',
      createdAt: '2026-09-20T10:00:00Z',
      status: 'ACCEPTED',
      user: { email: 'host@callie.example', name: 'David' },
      attendees: [{ email: 'dana@dana.example', name: 'Dana Example' }],
    });
    expect(ended.details).toMatchObject({
      title: 'Callie demo between David and Dana Example',
      attendeeName: 'Dana Example',
      notes: 'Booked after the call on Tuesday.',
      answers: { 'Which property management software do you use?': 'Buildium' },
      locationType: 'integrations:daily',
      videoCallUrl: null,
      zoomMeetingId: null,
    });
    const noShow = parseCalcomEvent({
      triggerEvent: 'BOOKING_NO_SHOW_UPDATED',
      createdAt: '2026-09-29T16:00:00Z',
      payload: { message: 'x marked as no-show', attendees: [{ email: 'dana@dana.example', noShow: true }], bookingUid: 'm2b', bookingId: 100 },
    });
    expect(noShow.details).toBeNull();
  });

  it('reads an API v2 booking: answers by slug, notes, and the Zoom id from the join URL', () => {
    const booking = parseCalcomBooking({
      id: 100,
      uid: 'm2c',
      title: 'Callie demo between David and Dana Example',
      description: 'We manage 300 doors.',
      hosts: [{ id: 1, name: 'David', email: 'host@callie.example' }],
      status: 'accepted',
      start: '2026-09-29T15:00:00Z',
      end: '2026-09-29T15:30:00Z',
      duration: 30,
      location: ZOOM_JOIN,
      createdAt: '2026-09-20T10:00:00Z',
      updatedAt: '2026-09-20T10:00:00Z',
      metadata: {},
      attendees: [{ name: 'Dana Example', email: 'dana@dana.example', timeZone: 'America/New_York', absent: false }],
      guests: [],
      bookingFieldsResponses: { name: 'Dana Example', email: 'dana@dana.example', notes: 'Texts are a mess.', software: 'Yardi', guests: [] },
    });
    expect(booking?.details).toEqual({
      title: 'Callie demo between David and Dana Example',
      attendeeName: 'Dana Example',
      notes: 'Texts are a mess.',
      answers: { software: 'Yardi' },
      locationType: 'zoom_video',
      videoCallUrl: `https://us06web.zoom.us/j/${ZOOM_ID}`,
      zoomMeetingId: ZOOM_ID,
      locationNamed: true,
    });
    expect(parseApiBookingDetails({ uid: 'x' })).toBeNull();
  });

  it('bounds every field: answers at 1,000 characters and 8 KB in all, notes at 4,000; nothing but https URLs', () => {
    const responses: Record<string, unknown> = {};
    for (let index = 0; index < 20; index += 1) responses[`q${String(index)}`] = { label: `Question ${String(index)}`, value: 'a'.repeat(2_000) };
    const details = parseWebhookBookingDetails({ additionalNotes: 'n'.repeat(5_000), responses });
    const answers = details?.answers ?? {};
    expect(Object.values(answers).every(answer => [...answer].length === BOOKING_ANSWER_VALUE_MAX)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(answers), 'utf8')).toBeLessThanOrEqual(BOOKING_ANSWERS_MAX_BYTES);
    expect(Object.keys(answers).length).toBeLessThan(20);
    expect([...(details?.notes ?? '')].length).toBe(BOOKING_NOTES_MAX);
    expect(videoCallUrlOf('http://zoom.us/j/81234567890')).toBeNull();
    expect(videoCallUrlOf('javascript:alert(1)')).toBeNull();
    expect(videoCallUrlOf(`https://meet.example/room#${PASSCODE}`)).toBe('https://meet.example/room');
    expect(zoomMeetingIdOfUrl('https://zoom.us.evil.example/j/81234567890')).toBeNull();
    expect(zoomMeetingIdOfUrl('https://acme.zoom.us/w/81234567890?tk=x')).toBe('81234567890');
  });
});

/** Many short answers, some with characters PostgreSQL escapes or prints as several bytes: review M2R's 638-answer shape. */
function manyShortAnswers(count: number): Record<string, unknown> {
  const marks = ['', '"', '\\', 'é', '\t', '🙂'];
  const responses: Record<string, unknown> = {};
  for (let index = 0; index < count; index += 1) {
    responses[`q${String(index)}`] = { label: `Q${marks[index % marks.length] ?? ''}${String(index)}`, value: 'Yes' };
  }
  return responses;
}

describe('booking details: answers are safe to store (review M2R, findings 3 and 7)', () => {
  it('keeps the answers inside the CHECK as PostgreSQL measures it, spaces and all', () => {
    const answers = parseWebhookBookingDetails({ responses: manyShortAnswers(1_000) })?.answers ?? {};
    // The reviewer's probe kept 638 answers that measured 8,185 compact and 9,460 as jsonb text.
    expect(Object.keys(answers).length).toBeGreaterThan(400);
    expect(jsonbTextBytes(answers)).toBeLessThanOrEqual(BOOKING_ANSWERS_MAX_BYTES);
    expect(jsonbTextBytes({ a: 'b', c: 'd' })).toBe('{"a": "b", "c": "d"}'.length);
  });

  it('drops questions named __proto__, constructor or prototype, and builds the answers on a null prototype', () => {
    const payload = JSON.parse(
      '{"responses": {"__proto__": {"label": "Fine label", "value": "1"}, "q1": {"label": "__proto__", "value": "2"},' +
        ' "q2": {"label": "constructor", "value": "3"}, "q3": {"label": "prototype", "value": "4"}, "q4": {"label": "How many doors?", "value": "40"}}}',
    ) as Record<string, unknown>;
    const answers = parseWebhookBookingDetails(payload)?.answers ?? null;
    expect(answers).toEqual({ 'How many doors?': '40' });
    expect(Object.getPrototypeOf(answers)).toBeNull();
    const api = parseApiBookingDetails(
      JSON.parse('{"uid": "x", "bookingFieldsResponses": {"__proto__": "1", "constructor": "2", "prototype": "3", "doors": "40"}}') as Record<string, unknown>,
    );
    expect(api?.answers).toEqual({ doors: '40' });
    // Only prototype keys: no answers at all, never `{}` (which the CHECK refuses).
    expect(parseWebhookBookingDetails(JSON.parse('{"responses": {"q1": {"label": "__proto__", "value": "2"}}}') as Record<string, unknown>)).toBeNull();
  });

  it('leaves out custom questions whose field or label asks for contact details, and keeps business ones', () => {
    const details = parseWebhookBookingDetails({
      responses: {
        phone: { label: 'Best number', value: '+14015550100' },
        firstName: { label: 'Given', value: 'Dana' },
        last_name: { label: 'Family', value: 'Example' },
        q1: { label: 'Your E-mail', value: 'dana@dana.example' },
        q2: { label: 'Mailing address', value: '12 Main Street' },
        q3: { label: 'Mobile', value: '+14015550101' },
        q4: { label: 'Full Name', value: 'Dana Example' },
        q5: { label: 'What is your cancellation policy?', value: '30 days' },
        q6: { label: 'Company name', value: 'Example Property Co' },
        q7: { label: 'How many doors?', value: '40' },
      },
    });
    expect(details?.answers).toEqual({ 'What is your cancellation policy?': '30 days', 'Company name': 'Example Property Co', 'How many doors?': '40' });
    const api = parseApiBookingDetails({
      uid: 'x',
      bookingFieldsResponses: { phoneNumber: '+14015550100', firstName: 'Dana', surname: 'Example', whatsapp: '+14015550102', zipCode: '02903', doors: '40' },
    });
    expect(api?.answers).toEqual({ doors: '40' });
    for (const question of ['phone', 'PHONE_NUMBER', 'yourName', 'e-mail', 'Street', 'postal code', 'name', 'cell']) expect(contactLike(question)).toBe(true);
    for (const question of ['Cancellation policy', 'Company name', 'Software', 'How many doors?']) expect(contactLike(question)).toBe(false);
  });
});

describe('booking details: freshness and location (review M2R, findings 1, 2 and 4)', () => {
  const T1 = '2026-09-21T00:00:00.000Z';
  const T2 = '2026-09-22T00:00:00.000Z';
  const T3 = '2026-09-23T00:00:00.000Z';
  const zoom: BookingDetails = {
    ...NO_BOOKING_DETAILS,
    title: 'Zoom demo',
    notes: 'First notes.',
    locationType: 'zoom_video',
    videoCallUrl: `https://us06web.zoom.us/j/${ZOOM_ID}`,
    zoomMeetingId: ZOOM_ID,
    locationNamed: true,
  };
  const stored = { details: zoom, observedAt: T2 };

  it('a newer source replaces what it says; an older one only fills what is empty, and the stored time stays', () => {
    const newer = mergeBookingDetails(stored, { ...NO_BOOKING_DETAILS, title: 'Newer title' }, T3);
    expect(newer).toMatchObject({ details: { title: 'Newer title', notes: 'First notes.', zoomMeetingId: ZOOM_ID }, observedAt: T3 });
    const older = mergeBookingDetails(stored, { ...NO_BOOKING_DETAILS, title: 'Older title', attendeeName: 'Dana Example' }, T1);
    expect(older).toMatchObject({ details: { title: 'Zoom demo', attendeeName: 'Dana Example' }, observedAt: T2 });
    // The same time replaces: a later delivery of the same moment is no older.
    expect(mergeBookingDetails(stored, { ...NO_BOOKING_DETAILS, title: 'Same moment' }, T2).details.title).toBe('Same moment');
  });

  it('a named change of location sets all three conferencing fields: Zoom to Meet, Zoom to a street address', () => {
    const meet = mergeBookingDetails(
      stored,
      { ...NO_BOOKING_DETAILS, locationType: 'google_video', videoCallUrl: 'https://meet.google.com/abc-defg-hij', locationNamed: true },
      T3,
    );
    expect(meet.details).toMatchObject({ locationType: 'google_video', videoCallUrl: 'https://meet.google.com/abc-defg-hij', zoomMeetingId: null });
    const room = mergeBookingDetails(stored, { ...NO_BOOKING_DETAILS, locationType: 'other', locationNamed: true }, T3);
    expect(room.details).toMatchObject({ locationType: 'other', videoCallUrl: null, zoomMeetingId: null });
  });

  it('the same location named without its call data keeps the URL and id; a payload silent on location keeps all three', () => {
    // A MEETING_ENDED names `integrations:zoom` and carries no videoCallData.
    const ended = parseWebhookBookingDetails({ title: 'Zoom demo', location: 'integrations:zoom' });
    expect(ended).toMatchObject({ locationType: 'zoom_video', zoomMeetingId: null, locationNamed: true });
    expect(mergeBookingDetails(stored, ended ?? NO_BOOKING_DETAILS, T3).details).toMatchObject({
      locationType: 'zoom_video',
      videoCallUrl: zoom.videoCallUrl,
      zoomMeetingId: ZOOM_ID,
    });
    const daily = mergeBookingDetails(
      { details: { ...NO_BOOKING_DETAILS, locationType: 'daily_video', videoCallUrl: 'https://cal.daily.example/room', locationNamed: true }, observedAt: T2 },
      { ...NO_BOOKING_DETAILS, locationType: 'integrations:daily', locationNamed: true },
      T3,
    );
    expect(daily.details.videoCallUrl).toBe('https://cal.daily.example/room');
    const silent = mergeBookingDetails(stored, { ...NO_BOOKING_DETAILS, title: 'No location said' }, T3);
    expect(silent.details).toMatchObject({ locationType: 'zoom_video', videoCallUrl: zoom.videoCallUrl, zoomMeetingId: ZOOM_ID });
  });
});

describe('booking details: stored on the meeting', () => {
  let database: TestDatabase;
  let seeded: TwoWorkspaces;
  let minute = 0;
  const workspaceId = (): string => seeded.alpha.workspaceId;

  async function deliver(trigger: string, payload: Record<string, unknown>): Promise<void> {
    minute += 1;
    await deliverAt(trigger, payload, new Date(Date.UTC(2026, 8, 21, 0, minute)).toISOString());
  }

  async function deliverAt(trigger: string, payload: Record<string, unknown>, createdAt: string): Promise<void> {
    const body = { triggerEvent: trigger, createdAt, payload };
    await withTransaction(database.session, async () =>
      await receiveCalcomEvent(database.session, { workspaceId: workspaceId(), rawBody: Buffer.from(JSON.stringify(body)), body }),
    );
  }

  async function meetingOf(uid: string): Promise<MeetingRow> {
    const { rows } = await database.session.query<MeetingRow>(
      `SELECT ${MEETING_COLUMNS} FROM meetings WHERE workspace_id = $1 AND (booking_uid = $2 OR current_booking_uid = $2)`,
      [workspaceId(), uid],
    );
    const row = rows[0];
    if (row === undefined) throw new Error(`no meeting for ${uid}`);
    return row;
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    seeded = await seedTwoWorkspaces(database.session);
  });

  afterAll(async () => {
    await database.drop();
  });

  it('stores them from the create, keeps them through an event that says less, and never the passcode', async () => {
    await deliver('BOOKING_CREATED', createdPayload('m2d', 'stored.example'));
    const created = await meetingOf('m2d');
    expect(created).toMatchObject({
      event_title: 'Callie demo between David and Dana Example',
      attendee_name: 'Dana Example',
      booking_notes: 'We manage 300 doors and maintenance requests come in by text.',
      location_type: 'zoom_video',
      video_call_url: `https://us06web.zoom.us/j/${ZOOM_ID}`,
      zoom_meeting_id: ZOOM_ID,
    });
    expect(created.booking_answers).toMatchObject({ 'How many doors?': '300' });
    // A cancellation that says only where the meeting was clears nothing it does not say.
    await deliver('BOOKING_CANCELLED', { uid: 'm2d', startTime: '2026-09-29T15:00:00Z', endTime: '2026-09-29T15:30:00Z', location: 'integrations:zoom' });
    expect(await meetingOf('m2d')).toMatchObject({
      state: 'cancelled',
      event_title: created.event_title,
      attendee_name: 'Dana Example',
      booking_notes: created.booking_notes,
      zoom_meeting_id: ZOOM_ID,
    });
    const { rows } = await database.session.query<{ text: string }>('SELECT row_to_json(m)::text AS text FROM meetings m WHERE id = $1', [created.id]);
    expect(rows[0]?.text).not.toContain(PASSCODE);
  });

  it('a reschedule takes the new booking s details', async () => {
    await deliver('BOOKING_CREATED', createdPayload('m2e', 'moved.example'));
    const moved = createdPayload('m2f', 'moved.example', {
      rescheduleUid: 'm2e',
      startTime: '2026-09-30T15:00:00Z',
      endTime: '2026-09-30T15:30:00Z',
      title: 'Callie demo (moved)',
      videoCallData: { type: 'zoom_video', id: '89999999999', password: PASSCODE, url: 'https://us06web.zoom.us/j/89999999999' },
    });
    await deliver('BOOKING_RESCHEDULED', moved);
    expect(await meetingOf('m2e')).toMatchObject({ current_booking_uid: 'm2f', event_title: 'Callie demo (moved)', zoom_meeting_id: '89999999999' });
  });

  it('a reconciliation read replaces them when fresh and only fills empty fields when older', async () => {
    // A meeting stored before 0040: no details yet.
    await deliver('BOOKING_CREATED', { uid: 'm2g', startTime: '2026-09-29T15:00:00Z', endTime: '2026-09-29T15:30:00Z', attendees: [{ email: 'dana@fill.example' }] });
    const read = (updatedAt: string, title: string) =>
      parseCalcomBooking({
        uid: 'm2g',
        title,
        status: 'accepted',
        start: '2026-09-29T15:00:00Z',
        end: '2026-09-29T15:30:00Z',
        createdAt: '2026-09-20T00:00:00Z',
        updatedAt,
        hosts: [{ email: 'host@callie.example' }],
        attendees: [{ name: 'Dana Example', email: 'dana@fill.example', absent: false }],
        bookingFieldsResponses: { software: 'Rent Manager' },
      });
    const run = async (updatedAt: string, title: string) =>
      await withTransaction(database.session, async () =>
        await reconcileCalcomBookings(database.session, { workspaceId: workspaceId(), bookings: [read(updatedAt, title)].flatMap(b => (b === null ? [] : [b])), now: '2026-10-01T12:00:00.000Z' }),
      );
    // Nothing stored yet: the read fills, and its time is the details' time.
    await run('2026-09-01T00:00:00Z', 'First title');
    expect(await meetingOf('m2g')).toMatchObject({ event_title: 'First title', attendee_name: 'Dana Example', booking_answers: { software: 'Rent Manager' } });
    expect((await meetingOf('m2g')).details_observed_at?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    // Fresh (T3): replaces.
    await run('2026-09-30T00:00:00Z', 'Newer title');
    expect((await meetingOf('m2g')).event_title).toBe('Newer title');
    // Then an older snapshot (T2) with the same times and state: T3's details stay (review M2R, finding 1).
    await run('2026-09-15T00:00:00Z', 'Middle title');
    expect(await meetingOf('m2g')).toMatchObject({ event_title: 'Newer title' });
    expect((await meetingOf('m2g')).details_observed_at?.toISOString()).toBe('2026-09-30T00:00:00.000Z');
  });

  it('a fold keeps the newest row s details, the survivor s next', async () => {
    await deliver('BOOKING_CREATED', { ...createdPayload('m2h', 'fold.example'), title: 'Older booking', videoCallData: null, metadata: {}, location: 'integrations:daily' });
    await deliver('BOOKING_CREATED', { uid: 'm2i', startTime: '2026-09-29T15:00:00Z', endTime: '2026-09-29T15:30:00Z', title: 'Newer booking', attendees: [{ email: 'dana@fold.example' }] });
    const context = repositoryContext(workspaceScope(workspaceId(), { kind: 'system', component: 'worker' }), database.session);
    const survivor = await meetingOf('m2h');
    const result = await withTransaction(database.session, async () => {
      const { rows } = await database.session.query<MeetingRow>(
        `SELECT ${MEETING_COLUMNS} FROM meetings WHERE workspace_id = $1 AND booking_uid IN ('m2h', 'm2i') ORDER BY id FOR UPDATE`,
        [workspaceId()],
      );
      return await foldMeetings(context, rows, survivor.id);
    });
    // The newer row's title; the survivor's notes and answers, which the newer row lacks.
    expect(result).toMatchObject({ event_title: 'Newer booking', attendee_name: 'Dana Example', location_type: 'integrations:daily' });
    expect(result.booking_notes).toBe('We manage 300 doors and maintenance requests come in by text.');
  });

  it('a delayed reschedule does not overwrite the newer details of the booking it points to (review M2R, finding 2)', async () => {
    await deliverAt('BOOKING_CREATED', createdPayload('m2k', 'delayed.example', { title: 'Booking A' }), '2026-09-22T01:00:00.000Z');
    // B arrives first as its own booking, at T3, with its own Zoom meeting.
    const bZoom = '87777777777';
    const b = createdPayload('m2l', 'delayed.example', {
      title: 'Booking B, latest',
      startTime: '2026-09-30T15:00:00Z',
      endTime: '2026-09-30T15:30:00Z',
      videoCallData: { type: 'zoom_video', id: bZoom, password: PASSCODE, url: `https://us06web.zoom.us/j/${bZoom}` },
      metadata: {},
    });
    await deliverAt('BOOKING_CREATED', b, '2026-09-22T03:00:00.000Z');
    // Then A → B, sent at T2, describing B as it was then.
    await deliverAt(
      'BOOKING_RESCHEDULED',
      {
        ...b,
        rescheduleUid: 'm2k',
        title: 'Booking B, as first sent',
        videoCallData: { type: 'zoom_video', id: '86666666666', password: PASSCODE, url: 'https://us06web.zoom.us/j/86666666666' },
      },
      '2026-09-22T02:00:00.000Z',
    );
    const survivor = await meetingOf('m2l');
    expect(survivor).toMatchObject({ event_title: 'Booking B, latest', zoom_meeting_id: bZoom });
    expect(survivor.details_observed_at?.toISOString()).toBe('2026-09-22T03:00:00.000Z');
  });

  it('a reschedule to another kind of location clears the old Zoom id and URL', async () => {
    await deliver('BOOKING_CREATED', createdPayload('m2m', 'located.example'));
    await deliver(
      'BOOKING_RESCHEDULED',
      createdPayload('m2n', 'located.example', {
        rescheduleUid: 'm2m',
        location: 'integrations:google:meet',
        videoCallData: { type: 'google_video', url: 'https://meet.google.com/abc-defg-hij' },
        metadata: { videoCallUrl: 'https://meet.google.com/abc-defg-hij' },
      }),
    );
    expect(await meetingOf('m2m')).toMatchObject({ location_type: 'google_video', video_call_url: 'https://meet.google.com/abc-defg-hij', zoom_meeting_id: null });
    await deliver(
      'BOOKING_RESCHEDULED',
      createdPayload('m2o', 'located.example', { rescheduleUid: 'm2n', location: '12 Main Street, Providence', videoCallData: null, metadata: {} }),
    );
    expect(await meetingOf('m2m')).toMatchObject({ location_type: 'other', video_call_url: null, zoom_meeting_id: null });
  });

  it('stores many short answers within the CHECK, measured as PostgreSQL measures them (review M2R, finding 3)', async () => {
    const answers = parseWebhookBookingDetails({ responses: manyShortAnswers(1_000) })?.answers ?? {};
    const { rows } = await database.session.query<{ bytes: number }>('SELECT octet_length($1::jsonb::text) AS bytes', [JSON.stringify(answers)]);
    expect(rows[0]?.bytes).toBe(jsonbTextBytes(answers));
    await deliver('BOOKING_CREATED', createdPayload('m2p', 'many.example', { responses: manyShortAnswers(1_000) }));
    const stored = await meetingOf('m2p');
    expect(Object.keys(stored.booking_answers ?? {}).length).toBe(Object.keys(answers).length);
  });
});
