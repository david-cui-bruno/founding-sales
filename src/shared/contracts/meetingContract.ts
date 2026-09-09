import { z } from 'zod';
const id = z.string().min(1).max(255);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const meetingInstantSchema = z.string().datetime({ offset: true });
const clockTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const meetingLocationSchema = z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('text'), value: z.string().min(1).max(2000) }), z.strictObject({ kind: z.literal('google_meet') })]);
export const schedulingRulesSchema = z.strictObject({ revision: integer.positive(), confirmed: z.boolean(), timezone: id,
  weeklyWindows: z.array(z.strictObject({ weekday: integer.max(6), start: clockTime, end: clockTime })).min(1).max(28),
  durationMinutes: integer.positive().max(480), bufferBeforeMinutes: integer.max(240), bufferAfterMinutes: integer.max(240),
  minimumNoticeMinutes: integer.max(43200), horizonDays: integer.positive().max(366),
  conflictCalendarIds: z.array(id).min(1).max(20), ownedCalendarId: id, location: meetingLocationSchema, allowReschedule: z.boolean(), allowCancel: z.boolean(),
});
export type SchedulingRules = z.infer<typeof schedulingRulesSchema>;
export const meetingIntentSchema = z.strictObject({ workspaceId: id, accountId: id, commandId: id, meetingId: id, operation: z.enum(['create', 'update', 'cancel']),
  expectedAuthorityGeneration: integer, expectedVersion: integer, rulesRevision: integer.positive(), threadId: id, threadRevision: integer.positive(),
  contextRevision: id, mailboxSubject: id, pairingId: z.string().uuid(), start: meetingInstantSchema, end: meetingInstantSchema,
  localStart: z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/), offset: z.string().regex(/^[+-](?:[01]\d|2[0-3]):[0-5]\d$/).nullable(), timezone: id,
  agreementEvidenceId: id.nullable(), agreement: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('explicit_slot'), start: meetingInstantSchema, end: meetingInstantSchema, quote: z.string().min(1).max(500) }),
    z.strictObject({ kind: z.literal('delegated_choice'), notBefore: meetingInstantSchema, notAfter: meetingInstantSchema, quote: z.string().min(1).max(500) }),
    z.strictObject({ kind: z.literal('offered_slot'), offerId: id, offerRevision: integer.positive(), slotId: id, quote: z.string().min(1).max(500) }),
    z.strictObject({ kind: z.literal('cancellation'), quote: z.string().min(1).max(500) }),
  ]).nullable(), mixedReply: z.boolean(), approvalId: id.nullable(), attendeeEmails: z.array(z.string().email()).min(1).max(20),
  inviteAttendees: z.boolean(), summary: z.string().min(1).max(240), etag: z.string().min(1).max(255).nullable(),
});
export type MeetingIntent = z.infer<typeof meetingIntentSchema>;
export type MeetingIdentity = { meetingId: string; calendarId: string; providerEventId: string };
export type BusyInterval = { start: string; end: string };
export type CalendarWrite = MeetingIdentity & BusyInterval & { timezone: string; summary: string; attendeeEmails: string[]; inviteAttendees: boolean; location: z.infer<typeof meetingLocationSchema>; etag: string | null };
export type ProviderMeeting = MeetingIdentity & { status: 'confirmed' | 'cancelled' | 'tentative'; etag: string; start: string | null; end: string | null;
  attendees: { email: string; responseStatus: 'needsAction' | 'declined' | 'tentative' | 'accepted' }[]; meetUrl: string | null };
export type CalendarResult = { kind: 'confirmed'; event: ProviderMeeting } | { kind: 'absent' } | { kind: 'unknown'; reason: string };
export type AvailabilityQuery = BusyInterval & { calendarIds: string[]; excludeIdentity?: MeetingIdentity };
export type AvailabilityResult = { kind: 'confirmed'; calendars: Record<string, BusyInterval[]> } | { kind: 'unknown'; reason: string };
export interface CalendarPort {
  availability(query: AvailabilityQuery, signal: AbortSignal): Promise<AvailabilityResult>;
  create(intent: CalendarWrite, signal: AbortSignal): Promise<CalendarResult>;
  get(identity: MeetingIdentity, signal: AbortSignal): Promise<CalendarResult>;
  update(intent: CalendarWrite, signal: AbortSignal): Promise<CalendarResult>;
  cancel(identity: MeetingIdentity & { etag: string }, signal: AbortSignal): Promise<CalendarResult>;
}
export type MeetingOutcome = z.infer<typeof meetingOutcomeSchema>;

/** Trusted composition inputs. No route accepts an `allowed` boolean. */
export const reserveMeetingSchema = z.strictObject({ intent: meetingIntentSchema, calendarId: id });
export type ReserveMeetingInput = z.infer<typeof reserveMeetingSchema>;
export const saveSchedulingRulesSchema = z.strictObject({ rules: schedulingRulesSchema, expectedRevision: integer.positive().nullable() });
export const meetingIdentitySchema = z.strictObject({ meetingId: id, calendarId: id, providerEventId: z.string().regex(/^[0-9a-v]{5,1024}$/) });
export const providerMeetingSchema = meetingIdentitySchema.extend({ status: z.enum(['confirmed', 'cancelled', 'tentative']), etag: z.string().min(1).max(255),
  start: meetingInstantSchema.nullable(), end: meetingInstantSchema.nullable(), attendees: z.array(z.strictObject({ email: z.string().email(), responseStatus: z.enum(['needsAction', 'declined', 'tentative', 'accepted']) })).max(200), meetUrl: z.string().url().nullable() });
export const meetingOutcomeSchema = meetingIdentitySchema.extend({ status: z.enum(['held', 'booked', 'unknown', 'cancelled']), reason: z.string().max(255).nullable(), event: providerMeetingSchema.nullable() }).refine(outcome => {
  const event = outcome.event;
  if (outcome.status === 'booked' && event?.status !== 'confirmed' || outcome.status === 'cancelled' && event?.status !== 'cancelled') return false;
  if (!event) return true;
  return event.meetingId === outcome.meetingId && event.calendarId === outcome.calendarId && event.providerEventId === outcome.providerEventId
    && (event.status !== 'cancelled' || outcome.status === 'cancelled')
    && (event.status === 'cancelled' || event.start !== null && event.end !== null && Date.parse(event.end) > Date.parse(event.start));
}, 'meeting_provider_evidence_conflict');
export const meetingReservationSchema = z.strictObject({ intent: meetingIntentSchema, rules: schedulingRulesSchema, identity: meetingIdentitySchema,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/), state: z.enum(['dispatching', 'recorded']), outcome: meetingOutcomeSchema.nullable(), outcomeSequence: integer.positive().optional(), reservationSequence: integer.positive().optional() });
export type MeetingReservation = z.infer<typeof meetingReservationSchema>;
export type MeetingReservationResult = { kind: 'reserved' | 'existing'; record: MeetingReservation };
export const meetingOutcomePayloadSchema = z.strictObject({ commandId: id, outcome: meetingOutcomeSchema, observedAt: meetingInstantSchema });
export type MeetingOutcomePayload = z.infer<typeof meetingOutcomePayloadSchema>;

export const offeredSlotSchema = z.strictObject({ id, start: meetingInstantSchema, end: meetingInstantSchema, timezone: id });
export const meetingOfferSchema = z.strictObject({ id, revision: integer.positive(), accountId: id, mailboxSubject: id, threadId: id, sendCommandId: z.string().uuid(), expiresAt: meetingInstantSchema,
  slots: z.array(offeredSlotSchema).min(1).max(5) }).refine(o => new Set(o.slots.map(s => s.id)).size === o.slots.length);
export type MeetingOffer = z.infer<typeof meetingOfferSchema>;
export const saveMeetingOfferSchema = z.strictObject({ offer: meetingOfferSchema, expectedRevision: integer.positive().nullable() });
