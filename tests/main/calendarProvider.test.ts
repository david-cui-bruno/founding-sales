import { describe, expect, it } from 'vitest';
import { createCalendarProvider, providerMeetingIdentity } from '../../src/main/meetings/calendarProvider';
import { googleScopes, type GoogleGrant } from '../../cloud/lambdas/delegated-worker/src/googleGrantCapabilities';
const grant: GoogleGrant = { provider: 'google', subject: 'subject-fiction', email: 'founder@example.test', owner: 'remote', purpose: 'permitted_correspondence',
  capabilities: ['availability', 'event_write'], grantedScopes: [googleScopes.availability, googleScopes.event_write],
  calendars: { confirmed: true, ownedCalendarId: 'founder@example.test', conflictCalendarIds: ['founder@example.test', 'other@example.test'] } };
const identity = providerMeetingIdentity('ws-fiction', 'meeting-fiction', 'founder@example.test');
const slot = { ...identity, start: '2026-09-15T14:00:00.000Z', end: '2026-09-15T14:30:00.000Z', timezone: 'America/New_York',
  summary: 'Fictional meeting', attendeeEmails: ['prospect@example.test'], inviteAttendees: true, location: { kind: 'text' as const, value: 'Fictional office' }, etag: null as string | null };
const event = { id: identity.providerEventId, etag: '"v1"', status: 'confirmed', start: { dateTime: slot.start }, end: { dateTime: slot.end },
  attendees: [{ email: 'prospect@example.test', responseStatus: 'needsAction' }] };
function fixture(responses: (Response | Error)[]) {
  const requests: { url: string; init: RequestInit }[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init: init! }); const response = responses.shift();
    if (!response) throw new Error('unconfigured fictional HTTP'); if (response instanceof Error) throw response; return response;
  };
  return { requests, provider: createCalendarProvider({ grant, accessToken: 'fictional-token', fetch }) };
}
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const signal = () => new AbortController().signal;
describe('actual Calendar HTTP adapter', () => {
  it.each(['primary', 'Primary', 'Founder@example.test', ' founder@example.test', 'founder%40example.test', 'arbitrary-selector'])('rejects unproven selector %s before any HTTP', selector => {
    let calls = 0;
    expect(() => createCalendarProvider({ grant: { ...grant, calendars: { confirmed: true, ownedCalendarId: selector, conflictCalendarIds: [selector] } }, accessToken: 'fictional', fetch: async () => { calls++; return json(event); } })).toThrow('calendar_resource_id_required');
    expect(calls).toBe(0);
  });
  it('creates a stable Google-valid identity and deliberately invites attendees', async () => {
    const { provider, requests } = fixture([json(event)]);
    expect(identity.providerEventId).toMatch(/^[0-9a-v]{5,1024}$/);
    expect(providerMeetingIdentity('ws-fiction', 'meeting-fiction', 'founder@example.test')).toEqual(identity);
    expect(await provider.create(slot, signal())).toMatchObject({ kind: 'confirmed', event: { ...identity, status: 'confirmed', etag: '"v1"' } });
    expect(requests).toHaveLength(1); expect(requests[0]!.url).toContain('/calendars/founder%40example.test/events?sendUpdates=all');
    expect(JSON.parse(String(requests[0]!.init.body))).toMatchObject({ id: identity.providerEventId, attendees: [{ email: 'prospect@example.test' }], start: { dateTime: slot.start, timeZone: slot.timezone } });
    expect(requests[0]!.init.redirect).toBe('error');
  });
  it('fails closed for any missing or errored conflict calendar', async () => {
    const { provider, requests } = fixture([json({ calendars: { 'founder@example.test': { busy: [] }, 'other@example.test': { errors: [{ reason: 'notFound' }] } } })]);
    expect(await provider.availability({ start: slot.start, end: slot.end, calendarIds: grant.calendars!.conflictCalendarIds }, signal())).toEqual({ kind: 'unknown', reason: 'calendar_unavailable' });
    expect(JSON.parse(String(requests[0]!.init.body)).items).toEqual([{ id: 'founder@example.test' }, { id: 'other@example.test' }]);
  });
  it('never retries uncertain inserts and reconciles by exact persisted identity', async () => {
    const { provider, requests } = fixture([new Error('timeout'), json(event)]);
    expect(await provider.create(slot, signal())).toEqual({ kind: 'unknown', reason: 'provider_uncertain' });
    expect(await provider.get(identity, signal())).toMatchObject({ kind: 'confirmed' });
    expect(requests.map(r => r.init.method)).toEqual(['POST', 'GET']);
    expect(requests[1]!.url).toContain(`/events/${identity.providerEventId}`);
  });
  it('uses If-Match for actual update and cancellation and holds ETag races', async () => {
    const { provider, requests } = fixture([json({}, 412), json({ ...event, status: 'cancelled', etag: '"v2"' })]);
    expect(await provider.update({ ...slot, etag: '"v1"' }, signal())).toEqual({ kind: 'unknown', reason: 'etag_conflict' });
    expect(await provider.cancel({ ...identity, etag: '"v1"' }, signal())).toMatchObject({ kind: 'confirmed', event: { status: 'cancelled' } });
    expect(requests.map(r => r.init.method)).toEqual(['PATCH', 'PATCH']);
    for (const request of requests) expect(new Headers(request.init.headers).get('If-Match')).toBe('"v1"');
    expect(JSON.parse(String(requests[1]!.init.body))).toEqual({ status: 'cancelled' });
  });
  it('does not fabricate requested Meet links or trust the wrong event identity', async () => {
    const { provider } = fixture([json(event), json({ ...event, id: 'wrongid' })]);
    expect(await provider.create({ ...slot, location: { kind: 'google_meet' } }, signal())).toEqual({ kind: 'unknown', reason: 'conference_pending' });
    expect(await provider.get(identity, signal())).toEqual({ kind: 'unknown', reason: 'provider_uncertain' });
  });
  it('rechecks owned-calendar races without subtracting overlapping external events from freebusy', async () => {
    const { provider, requests } = fixture([
      json({ calendars: { 'other@example.test': { busy: [] } } }),
      json({ items: [event, { ...event, id: 'external', start: { dateTime: slot.start }, end: { dateTime: slot.end } }] }),
    ]);
    expect(await provider.availability({ start: slot.start, end: slot.end, calendarIds: grant.calendars!.conflictCalendarIds, excludeIdentity: identity }, signal())).toEqual({ kind: 'confirmed', calendars: {
      'founder@example.test': [{ start: slot.start, end: slot.end }], 'other@example.test': [],
    } });
    expect(requests[1]!.url).toContain('singleEvents=true');
    expect(requests[1]!.url).toContain('showDeleted=false');
  });
  it('holds truncated post-create event scans and does not ignore all-day busy events', async () => {
    const { provider } = fixture([json({ calendars: { 'other@example.test': { busy: [] } } }), json({ items: [], nextPageToken: 'more' })]);
    expect(await provider.availability({ start: slot.start, end: slot.end, calendarIds: grant.calendars!.conflictCalendarIds, excludeIdentity: identity }, signal())).toEqual({ kind: 'unknown', reason: 'calendar_unavailable' });
  });
  it('rejects missing grants, unselected calendars and missing mutation ETags without HTTP', async () => {
    expect(() => createCalendarProvider({ grant: { ...grant, capabilities: [] }, accessToken: 'fictional', fetch: async () => { throw new Error('forbidden'); } })).toThrow();
    const { provider, requests } = fixture([]);
    await expect(provider.update(slot, signal())).rejects.toThrow('etag_required');
    await expect(provider.get({ ...identity, calendarId: 'stranger@example.test' }, signal())).rejects.toThrow('calendar_not_selected');
    expect(requests).toHaveLength(0);
  });
});
