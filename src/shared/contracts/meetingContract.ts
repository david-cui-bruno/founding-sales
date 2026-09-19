import { z } from 'zod';
/**
 * Calendar meetings were removed on 18 September 2026 (David's B2 A decision). What remains is only what
 * still parses historical records: the `meeting.outcome` worker event the desktop sync applies, and the
 * `meeting_attended` milestone report the worker verifies against stored MEETING# reservations.
 */
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
export const meetingOutcomePayloadSchema = z.strictObject({ commandId: id, outcome: meetingOutcomeSchema, observedAt: meetingInstantSchema });
export type MeetingOutcomePayload = z.infer<typeof meetingOutcomePayloadSchema>;

