import { meetingIntentSchema, type MeetingIntent, type MeetingOutcome, type CalendarPort, type CalendarResult, type MeetingReservation, type ProviderMeeting, type SchedulingRules } from '../../../../src/shared/contracts/meetingContract';
import { validateMeetingIntent, overlapsWithBuffers } from '../../../../src/shared/meetings/schedulingRules';
import { createCalendarProvider, providerMeetingIdentity, requireExplicitCalendarId } from '../../../../src/main/meetings/calendarProvider';
import { fingerprint } from './dynamoStore';
import { DynamoMeetingRepository } from './meetingRepository';
import { RemoteGoogleAuthorization } from './remoteGoogleAuthorization';
/** Real production composition, with only HTTP and the Dynamo SDK boundary injected.
 * A process restart can reconcile, but never acquire a second insert permission. */
export class MeetingCoordinator {
  constructor(readonly input: { repository: DynamoMeetingRepository; authorization: RemoteGoogleAuthorization; calendarId: string; fetch: typeof globalThis.fetch }) {}
  private query(intent: MeetingIntent, rules: SchedulingRules) {
    return { start: new Date(Date.parse(intent.start) - rules.bufferBeforeMinutes * 60000).toISOString(),
      end: new Date(Date.parse(intent.end) + rules.bufferAfterMinutes * 60000).toISOString(), calendarIds: rules.conflictCalendarIds };
  }
  private holdForReconciliation(record: MeetingReservation, reason = 'provider_uncertain') {
    return this.input.repository.recordOutcome(record.intent.commandId, { ...record.identity, status: 'unknown', reason, event: null });
  }
  private holdForAnotherSlot(record: MeetingReservation, reason: string, event: ProviderMeeting) {
    return this.input.repository.recordOutcome(record.intent.commandId, { ...record.identity, status: 'held', reason, event });
  }
  private async recordProviderMeetingState(record: MeetingReservation, event: ProviderMeeting, calendar: CalendarPort, signal: AbortSignal): Promise<MeetingOutcome> {
    if (event.status === 'cancelled') return this.input.repository.recordOutcome(record.intent.commandId, { ...record.identity, status: 'cancelled', reason: null, event });
    if (record.intent.operation === 'cancel') return this.holdForReconciliation(record, 'cancellation_not_confirmed');
    if (event.status !== 'confirmed' || event.start === null || event.end === null) return this.holdForAnotherSlot(record, 'provider_not_confirmed', event);
    if (Date.parse(event.start) !== Date.parse(record.intent.start) || Date.parse(event.end) !== Date.parse(record.intent.end)) return this.holdForAnotherSlot(record, 'provider_slot_changed', event);
    if (record.rules.location.kind === 'google_meet' && !event.meetUrl) return this.holdForReconciliation(record, 'conference_pending');
    const after = await calendar.availability({ ...this.query(record.intent, record.rules), excludeIdentity: record.identity }, signal);
    if (after.kind !== 'confirmed') return this.holdForAnotherSlot(record, 'post_create_conflicts_unknown', event);
    if (overlapsWithBuffers(record.intent, Object.values(after.calendars).flat(), record.rules)) return this.holdForAnotherSlot(record, 'external_calendar_conflict', event);
    return this.input.repository.recordOutcome(record.intent.commandId, { ...record.identity, status: 'booked', reason: null, event });
  }
  private async reconcile(record: MeetingReservation, calendar: CalendarPort, signal: AbortSignal): Promise<MeetingOutcome> {
    const existing = await calendar.get(record.identity, signal);
    if (existing.kind === 'confirmed') return this.recordProviderMeetingState(record, existing.event, calendar, signal);
    return this.holdForReconciliation(record);
  }
  private async createReservedMeeting(record: MeetingReservation, calendar: CalendarPort, signal: AbortSignal, existing: CalendarResult): Promise<MeetingOutcome> {
    const { intent, identity, rules } = record;
    if (existing.kind === 'unknown') return this.holdForReconciliation(record);
    if (existing.kind === 'confirmed' && (intent.operation === 'create' || existing.event.status === 'cancelled')) return this.recordProviderMeetingState(record, existing.event, calendar, signal);
    if (intent.operation !== 'create' && (existing.kind === 'absent' || existing.event.etag !== intent.etag)) return this.holdForReconciliation(record, 'etag_conflict');
    const write = { ...identity, start: intent.start, end: intent.end, timezone: intent.timezone, summary: intent.summary, attendeeEmails: intent.attendeeEmails,
      inviteAttendees: intent.inviteAttendees, location: rules.location, etag: intent.etag };
    const result = intent.operation === 'create' ? await calendar.create(write, signal) : intent.operation === 'update'
      ? await calendar.update(write, signal) : await calendar.cancel({ ...identity, etag: intent.etag! }, signal);
    if (result.kind === 'confirmed') return this.recordProviderMeetingState(record, result.event, calendar, signal);
    // No retry, even on 404 after an uncertain mutation.
    return this.reconcile(record, calendar, signal);
  }
  async coordinateMeeting(raw: MeetingIntent, signal = new AbortController().signal): Promise<MeetingOutcome> {
    const intent = meetingIntentSchema.parse(raw); const { repository, authorization, calendarId } = this.input;
    const identity = providerMeetingIdentity(intent.workspaceId, intent.meetingId, calendarId);
    let reserved: MeetingReservation | null = null;
    try {
      requireExplicitCalendarId(calendarId);
      const held = await repository.held({ intent, calendarId }); if (held) return held;
      const old = await repository.command(intent.commandId);
      if (old && old.fingerprint !== fingerprint({ intent, calendarId })) throw new Error('command_fingerprint_conflict');
      const rules = old?.rules ?? await repository.rules(calendarId);
      if (!old) { const valid = validateMeetingIntent(intent, rules, repository.store.now()); if (valid.allowed === false) throw new Error(valid.reason); }
      [rules.ownedCalendarId, ...rules.conflictCalendarIds].forEach(requireExplicitCalendarId);
      if (!old) await repository.sourceFence({ intent, calendarId });
      const access = await authorization.authorizedAccess(intent.pairingId, ['availability', 'event_write'], signal);
      if (access.grant.subject !== intent.mailboxSubject) throw new Error('google_subject_mismatch');
      const calendar = createCalendarProvider({ ...access, fetch: this.input.fetch });
      if (old) { reserved = old; return await this.reconcile(old, calendar, signal); }
      if (intent.operation !== 'cancel') {
        const before = await calendar.availability({ ...this.query(intent, rules), ...(intent.operation === 'update' ? { excludeIdentity: identity } : {}) }, signal);
        if (before.kind !== 'confirmed') throw new Error('calendar_unavailable');
        if (overlapsWithBuffers(intent, Object.values(before.calendars).flat(), rules)) throw new Error('calendar_overlap');
      }
      const existing = await calendar.get(identity, signal);
      if (existing.kind === 'unknown') throw new Error('provider_lookup_uncertain');
      if (signal.aborted) throw new Error('meeting_cancelled_before_reservation');
      const reservation = await repository.reserve({ intent, calendarId }, access.accessEvidence); reserved = reservation.record;
      return reservation.kind === 'existing' ? await this.reconcile(reserved, calendar, signal) : await this.createReservedMeeting(reserved, calendar, signal, existing);
    } catch (error) {
      // Safe stable codes only. Never expose provider URLs/tokens or raw response bodies.
      const reason = error instanceof Error && /^[a-z_]{3,80}$/.test(error.message) ? error.message : 'meeting_unavailable';
      if (!reserved) {
        try { const committed = await repository.command(intent.commandId); if (committed?.fingerprint === fingerprint({ intent, calendarId })) reserved = committed; }
        catch { return { ...identity, status: 'unknown', reason: 'reservation_recording_uncertain', event: null }; }
      }
      if (reserved) { try { return await this.holdForReconciliation(reserved, reason); } catch { return { ...identity, status: 'unknown', reason: 'outcome_recording_uncertain', event: null }; } }
      try { return await repository.recordHeldIntent({ intent, calendarId }, reason); }
      catch { return { ...identity, status: 'held', reason, event: null }; }
    }
  }
}
