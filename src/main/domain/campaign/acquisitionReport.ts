import type { AppDatabase } from '../../db/database';
import { listActualCallAttempts } from '../accounts/accountOutreach';
import { acquisitionFactSchema, acquisitionWindowSchema, type AcquisitionFact, type AcquisitionReport, type AcquisitionWindow } from '../../../shared/contracts/acquisitionReportContract';
import { workerEventSchema } from '../../../shared/contracts/delegationContract';

const actualKinds = new Set(['manual_call', 'conversation', 'positive_response', 'calendar_booking_confirmed', 'calendar_cancelled', 'meeting_held', 'pilot_willingness', 'pilot_started']);
export function uniqueAcquisitionFacts(events: readonly AcquisitionFact[]): AcquisitionFact[] {
  const unique = new Map<string, AcquisitionFact>();
  for (const input of events) {
    const event = acquisitionFactSchema.parse(input);
    const prior = unique.get(event.id);
    if (prior && JSON.stringify(prior) !== JSON.stringify(event)) throw new Error('Conflicting acquisition event identity.');
    unique.set(event.id, event);
  }
  return [...unique.values()].sort((a, b) => Date.parse(a.occurredAt ?? '') - Date.parse(b.occurredAt ?? '') || a.id.localeCompare(b.id));
}
export function countMilestones(events: readonly AcquisitionFact[], observation: AcquisitionWindow): AcquisitionReport {
  const window = acquisitionWindowSchema.parse(observation);
  const start = Date.parse(window.start), end = Date.parse(window.end);
  const all = uniqueAcquisitionFacts(events);
  // First confirmed fact establishes a milestone's time, so updates in a later window do not create a new booking.
  const first = new Map<string, AcquisitionFact>();
  for (const e of all) {
    if (!e.occurredAt || !e.evidence || !actualKinds.has(e.kind)) continue;
    if (['meeting_held', 'pilot_started', 'pilot_willingness'].includes(e.kind) && e.evidence.source !== 'human') continue;
    const identity = e.kind.startsWith('calendar_') || e.kind === 'meeting_held' ? e.meetingId
      : e.kind === 'pilot_started' ? e.pilotId : e.id;
    if (!identity) continue;
    const key = JSON.stringify([e.kind, identity]);
    if (!first.has(key)) first.set(key, e);
  }
  const within = (e: AcquisitionFact) => Date.parse(e.occurredAt ?? '') >= start && Date.parse(e.occurredAt ?? '') < end;
  const facts = [...first.values()].filter(within);
  const observed = all.filter(within);
  const count = (kind: string) => facts.filter(e => e.kind === kind).length;
  const sum = (key: 'costCents' | 'durationSeconds' | 'editSeconds' | 'modelTokens') => observed.length === 0 || observed.some(e => e[key] == null)
    ? null : observed.reduce((total, e) => total + e[key]!, 0);
  return Object.freeze({ window, observationSeconds: (end - start) / 1000,
    manualCalls: count('manual_call'), conversations: count('conversation'), positiveResponses: count('positive_response'),
    meetingsBooked: count('calendar_booking_confirmed'), meetingsCancelled: count('calendar_cancelled'), meetingsHeld: count('meeting_held'),
    pilotWillingness: count('pilot_willingness'), pilotStarts: count('pilot_started'),
    historicalEventCount: observed.filter(e => !actualKinds.has(e.kind)).length,
    costCents: sum('costCents'), knownCostCents: observed.reduce((total, e) => total + (e.costCents ?? 0), 0),
    durationSeconds: sum('durationSeconds'), editSeconds: sum('editSeconds'), modelTokens: sum('modelTokens'),
  });
}
/** Accept only canonical C5 worker envelopes, not local optimistic command receipts. */
export function fromMeetingWorkerEvents(events: readonly unknown[]): AcquisitionFact[] {
  return events.flatMap(input => {
    const parsed = workerEventSchema.safeParse(input);
    if (!parsed.success || parsed.data.kind !== 'meeting.outcome') return [];
    const event = parsed.data, { outcome, observedAt } = event.payload;
    return [{ id: `${event.workspaceId}:${event.id}`, accountId: event.accountId, occurredAt: observedAt,
      meetingId: JSON.stringify([event.workspaceId, outcome.calendarId, outcome.providerEventId, outcome.meetingId]),
      kind: outcome.status === 'booked' ? 'calendar_booking_confirmed' : outcome.status === 'cancelled' ? 'calendar_cancelled' : 'calendar_operational_hold_or_unknown',
      evidence: { source: 'provider' as const, reference: event.id } }];
  });
}

/** Reads canonical persisted facts only. Operational hold, inferred interest and connected calls are not attendance/conversations. */
export function readAcquisitionFacts(database: AppDatabase): AcquisitionFact[] {
  const rows = database.raw.prepare("SELECT event_json FROM delegated_applied_events WHERE json_extract(event_json,'$.kind')='meeting.outcome' ORDER BY applied_at,id").all() as { event_json: string }[];
  const meetings = fromMeetingWorkerEvents(rows.map(row => JSON.parse(row.event_json)));
  const calls = listActualCallAttempts(database, { from: '0001-01-01T00:00:00.000Z', to: '9999-12-31T23:59:59.999Z' }).map(call => ({
    id: `account-call:${call.attemptId}`, accountId: call.accountId, kind: 'manual_call', occurredAt: call.reportedAt,
    evidence: { source: 'human' as const, reference: call.commandId },
  }));
  return [...meetings, ...calls];
}
