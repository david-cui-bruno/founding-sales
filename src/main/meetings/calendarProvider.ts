import { createHash } from 'node:crypto';
import { z } from 'zod';
import { requireCapabilities, googleCalendarSelectionSchema, type GoogleGrant } from '../../../cloud/lambdas/delegated-worker/src/googleGrantCapabilities';
import { meetingInstantSchema, type CalendarPort, type CalendarResult, type CalendarWrite, type MeetingIdentity, type ProviderMeeting } from '../../shared/contracts/meetingContract';
import { requestJsonOnce } from '../outreach/providers/providerHttp';
const id = z.string().min(1).max(255);
const eventId = z.string().regex(/^[0-9a-v]{5,1024}$/);
const interval = z.object({ start: meetingInstantSchema, end: meetingInstantSchema }).refine(v => Date.parse(v.end) > Date.parse(v.start));
const rawEvent = z.object({ id: z.string(), etag: z.string().min(1).max(255), status: z.enum(['confirmed', 'cancelled', 'tentative']),
  start: z.object({ dateTime: meetingInstantSchema }).optional(), end: z.object({ dateTime: meetingInstantSchema }).optional(),
  attendees: z.array(z.object({ email: z.string().email(), responseStatus: z.enum(['needsAction', 'declined', 'tentative', 'accepted']) })).max(200).optional(),
  conferenceData: z.object({ createRequest: z.object({ status: z.object({ statusCode: z.string() }) }).optional(),
    entryPoints: z.array(z.object({ entryPointType: z.string(), uri: z.string() })).optional() }).optional(),
});
export function providerMeetingIdentity(workspaceId: string, meetingId: string, calendarId: string): MeetingIdentity {
  [workspaceId, meetingId, calendarId].forEach(value => id.parse(value));
  return { meetingId, calendarId, providerEventId: createHash('sha256').update(JSON.stringify([workspaceId, meetingId, calendarId])).digest('hex') };
}
/** Fetch is mandatory: construction never silently selects a live network boundary. */
export function createCalendarProvider(input: { grant: GoogleGrant; accessToken: string; fetch: typeof globalThis.fetch }): CalendarPort {
  requireCapabilities(input.grant, ['availability', 'event_write']);
  const selected = googleCalendarSelectionSchema.parse(input.grant.calendars);
  if (!input.accessToken || /[\r\n]/.test(input.accessToken)) throw new Error('invalid_access_token');
  const identity = (value: MeetingIdentity) => {
    id.parse(value.meetingId); eventId.parse(value.providerEventId);
    if (value.calendarId !== selected.ownedCalendarId) throw new Error('calendar_not_selected');
  };
  const request = (path: string, method: string, signal: AbortSignal, body?: unknown, etag?: string) => requestJsonOnce({
    fetch: input.fetch, signal, url: `https://www.googleapis.com/calendar/v3/${path}`, maxBytes: 256000,
    init: { method, headers: { Authorization: `Bearer ${input.accessToken}`, 'Content-Type': 'application/json', ...(etag ? { 'If-Match': etag } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
  });
  const path = (value: MeetingIdentity) => `calendars/${encodeURIComponent(value.calendarId)}/events/${value.providerEventId}`;
  const result = (data: unknown, value: MeetingIdentity, wantsMeet = false): CalendarResult => {
    const raw = rawEvent.parse(data);
    if (raw.id !== value.providerEventId || (raw.status !== 'cancelled' && (!raw.start || !raw.end || Date.parse(raw.end.dateTime) <= Date.parse(raw.start.dateTime)))) throw new Error('invalid_event');
    const video = raw.conferenceData?.entryPoints?.find(p => p.entryPointType === 'video')?.uri;
    const meetUrl = video && /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(video) ? video : null;
    if (wantsMeet && (!meetUrl || raw.conferenceData?.createRequest?.status.statusCode === 'pending')) return { kind: 'unknown', reason: 'conference_pending' };
    const event: ProviderMeeting = { meetingId: value.meetingId, calendarId: value.calendarId, providerEventId: value.providerEventId, status: raw.status, etag: raw.etag, start: raw.start?.dateTime ?? null, end: raw.end?.dateTime ?? null, attendees: raw.attendees ?? [], meetUrl };
    return { kind: 'confirmed', event };
  };
  const perform = async (value: MeetingIdentity, method: string, url: string, signal: AbortSignal, body?: unknown, etag?: string, wantsMeet = false): Promise<CalendarResult> => {
    try {
      const reply = await request(url, method, signal, body, etag);
      if (method === 'GET' && reply.status === 404) return { kind: 'absent' };
      if (reply.status === 412) return { kind: 'unknown', reason: 'etag_conflict' };
      if (reply.status !== 200 && reply.status !== 201) return { kind: 'unknown', reason: 'provider_uncertain' };
      return result(reply.data, value, wantsMeet);
    } catch { return { kind: 'unknown', reason: 'provider_uncertain' }; }
  };
  const write = (value: CalendarWrite, method: 'POST' | 'PATCH', signal: AbortSignal) => {
    identity(value); interval.parse(value); id.parse(value.timezone);
    new Intl.DateTimeFormat('en', { timeZone: value.timezone });
    z.array(z.string().email()).min(1).max(20).parse(value.attendeeEmails); z.string().min(1).max(240).parse(value.summary);
    if (method === 'PATCH' && !value.etag) throw new Error('etag_required');
    const wantsMeet = value.location.kind === 'google_meet';
    const body = { ...(method === 'POST' ? { id: value.providerEventId } : {}), summary: value.summary,
      start: { dateTime: value.start, timeZone: value.timezone }, end: { dateTime: value.end, timeZone: value.timezone },
      attendees: value.attendeeEmails.map(email => ({ email })),
      ...(wantsMeet ? { conferenceData: { createRequest: { requestId: value.providerEventId, conferenceSolutionKey: { type: 'hangoutsMeet' } } } } : { location: value.location.kind === 'text' ? value.location.value : undefined }),
    };
    const url = method === 'POST' ? `calendars/${encodeURIComponent(value.calendarId)}/events` : path(value);
    return perform(value, method, `${url}?sendUpdates=${value.inviteAttendees ? 'all' : 'none'}${wantsMeet ? '&conferenceDataVersion=1' : ''}`, signal, body, value.etag ?? undefined, wantsMeet);
  };
  return {
    async availability(query, signal) {
      interval.parse(query); z.array(id).min(1).max(20).parse(query.calendarIds);
      if (new Set(query.calendarIds).size !== query.calendarIds.length || query.calendarIds.some(calendar => !selected.conflictCalendarIds.includes(calendar))) throw new Error('calendar_not_selected');
      try {
        if (query.excludeIdentity) identity(query.excludeIdentity);
        const freebusyIds = query.calendarIds.filter(id => id !== query.excludeIdentity?.calendarId);
        const reply = freebusyIds.length ? await request('freeBusy', 'POST', signal, { timeMin: query.start, timeMax: query.end, items: freebusyIds.map(id => ({ id })) }) : { status: 200, data: { calendars: {} } };
        if (reply.status !== 200) throw new Error();
        const raw = z.object({ calendars: z.record(z.string(), z.object({ busy: z.array(interval).max(2000).optional(), errors: z.array(z.unknown()).optional() })) }).parse(reply.data);
        const calendars: Record<string, z.infer<typeof interval>[]> = {};
        for (const calendar of freebusyIds) {
          const current = raw.calendars[calendar]; if (!current?.busy || current.errors?.length) throw new Error();
          calendars[calendar] = current.busy;
        }
        if (query.excludeIdentity) {
          const params = new URLSearchParams({ timeMin: query.start, timeMax: query.end, singleEvents: 'true', showDeleted: 'false', maxResults: '2500' });
          const events = await request(`calendars/${encodeURIComponent(query.excludeIdentity.calendarId)}/events?${params}`, 'GET', signal);
          if (events.status !== 200) throw new Error();
          const page = z.object({ nextPageToken: z.string().optional(), items: z.array(z.object({ id: z.string(), status: z.string().optional(), transparency: z.string().optional(),
            start: z.object({ dateTime: meetingInstantSchema.optional(), date: z.string().optional() }).optional(),
            end: z.object({ dateTime: meetingInstantSchema.optional(), date: z.string().optional() }).optional(),
          })).max(2500) }).parse(events.data);
          if (page.nextPageToken) throw new Error();
          calendars[query.excludeIdentity.calendarId] = page.items.filter(e => e.id !== query.excludeIdentity!.providerEventId && e.status !== 'cancelled' && e.transparency !== 'transparent').map(e => {
            // Date-only all-day events require calendar-zone expansion. Until that
            // can be proved, hold instead of treating them as free.
            return interval.parse({ start: e.start?.dateTime, end: e.end?.dateTime });
          });
        }
        return { kind: 'confirmed', calendars };
      } catch { return { kind: 'unknown', reason: 'calendar_unavailable' }; }
    },
    async create(value, signal) { return write(value, 'POST', signal); },
    async get(value, signal) { identity(value); return perform(value, 'GET', path(value), signal); },
    async update(value, signal) { return write(value, 'PATCH', signal); },
    async cancel(value, signal) {
      identity(value); if (!value.etag) throw new Error('etag_required');
      return perform(value, 'PATCH', `${path(value)}?sendUpdates=all`, signal, { status: 'cancelled' }, value.etag);
    },
  };
}
