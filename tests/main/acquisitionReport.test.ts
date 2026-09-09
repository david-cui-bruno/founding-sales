import { acquisitionMilestonePayloadSchema, acquisitionMilestoneReportSchema } from '../../src/shared/contracts/acquisitionReportContract';
import { describe, expect, it } from 'vitest';
import { countMilestones, fromMeetingWorkerEvents, fromAcquisitionWorkerEvents, readAcquisitionFacts } from '../../src/main/domain/campaign/acquisitionReport';
import { projectAccountPipeline } from '../../src/main/domain/campaign/accountPipelineProjection';
import { createPmFixture, PM_NOW } from '../fixtures/pmAccounts';
import { DelegationRepository } from '../../src/main/delegation/delegationRepository';
import { EMAIL_PLAYBOOK } from '../../src/main/outreach/emailPlaybook';

const window = { start: '2026-09-01T00:00:00.000Z', end: '2026-10-01T00:00:00.000Z' };
const at = '2026-09-09T00:00:00.000Z';
const evidence = { source: 'human' as const, reference: 'fictional-note' };
describe('truthful acquisition report', () => {
  it('keeps legacy/generated/queued/accepted evidence separate from actual milestones', () => {
    expect(countMilestones([{ id: 'legacy-1', accountId: 'a', kind: 'legacy_interview_booked' }], window)).toMatchObject({ meetingsBooked: 0, meetingsHeld: 0, pilotStarts: 0 });
    const events = ['legacy_interview_booked', 'queued_send', 'connection_accepted', 'pilot_suggestion'].map(kind => ({ id: kind, accountId: 'a', kind, occurredAt: at }));
    expect(countMilestones(events, window)).toMatchObject({ meetingsBooked: 0, meetingsHeld: 0, pilotStarts: 0, historicalEventCount: 4, costCents: null });
  });
  it('counts stable meeting identities once across duplicate events, account aliases and reschedules', () => {
    const events = [
      { id: 'book', accountId: 'a', kind: 'calendar_booking_confirmed', occurredAt: at, meetingId: 'meeting-1', evidence },
      { id: 'reschedule', accountId: 'alias', kind: 'calendar_booking_confirmed', occurredAt: at, meetingId: 'meeting-1', evidence },
      { id: 'cancel', accountId: 'a', kind: 'calendar_cancelled', occurredAt: at, meetingId: 'meeting-1', evidence },
    ];
    expect(countMilestones([...events, events[0]], window)).toMatchObject({ meetingsBooked: 1, meetingsCancelled: 1, meetingsHeld: 0 });
  });
  it('requires separate human attendance and actual pilot evidence, not provider hold or model guesses', () => {
    const events = [
      { id: 'held-no-proof', accountId: 'a', kind: 'meeting_held', occurredAt: at, meetingId: 'm0' },
      { id: 'pilot-no-proof', accountId: 'a', kind: 'pilot_started', occurredAt: at, pilotId: 'p0' },
      { id: 'held', accountId: 'a', kind: 'meeting_held', occurredAt: at, meetingId: 'm1', evidence },
      { id: 'pilot', accountId: 'a', kind: 'pilot_started', occurredAt: at, pilotId: 'p1', evidence },
      { id: 'pilot-again', accountId: 'a', kind: 'pilot_started', occurredAt: at, pilotId: 'p1', evidence },
    ];
    expect(countMilestones(events, window)).toMatchObject({ meetingsHeld: 1, pilotStarts: 1 });
  });
  it('uses half-open equal observation windows and leaves incomplete costs/time unknown', () => {
    const events = [
      { id: 'first', accountId: 'a', kind: 'manual_call', occurredAt: window.start, evidence, costCents: 0, durationSeconds: 20, editSeconds: 2, modelTokens: 0 },
      { id: 'second', accountId: 'a', kind: 'conversation', occurredAt: at, evidence, costCents: null as number | null },
      { id: 'outside', accountId: 'a', kind: 'positive_response', occurredAt: window.end, evidence },
    ];
    expect(countMilestones(events, window)).toMatchObject({ manualCalls: 1, conversations: 1, positiveResponses: 0, costCents: null, knownCostCents: 0, durationSeconds: null, editSeconds: null, modelTokens: null });
    expect(() => countMilestones(events, { start: window.end, end: window.start })).toThrow();
  });
  it('does not merge candidate accounts or infer pilots from old pipeline stages', () => {
    const accounts = [{ id: 'a', mergeCandidateAccountIds: ['b'], historicalStage: 'won' }, { id: 'b' }];
    const projection = projectAccountPipeline(accounts, [{ id: 'book', accountId: 'a', kind: 'calendar_booking_confirmed', occurredAt: at, meetingId: 'm', evidence }]);
    expect(projection).toMatchObject([{ accountId: 'a', stage: 'meeting_booked', historicalStage: 'won' }, { accountId: 'b', stage: 'unobserved' }]);
  });
  it('maps actual C5 events without treating operational held as attendance or unknown as booked', () => {
    const identity = { meetingId: 'm', calendarId: 'cal', providerEventId: 'abcde' };
    const events = ['held', 'unknown'].map((status, i) => ({ id: `worker-${i}`, workspaceId: 'w', accountId: 'a', authorityGeneration: 1, aggregateVersion: i + 1, kind: 'meeting.outcome', payload: { commandId: `cmd-${i}`, observedAt: at, outcome: { ...identity, status, reason: 'conflict', event: null as null } } }));
    expect(fromMeetingWorkerEvents(events)).toHaveLength(2);
    expect(countMilestones(fromMeetingWorkerEvents(events), window)).toMatchObject({ meetingsBooked: 0, meetingsHeld: 0 });
  });
  it('positions new drafts as maintenance agent work, not only quote shopping', () => {
    expect(EMAIL_PLAYBOOK).toContain('24/7 maintenance agent');
    expect(EMAIL_PLAYBOOK).toContain('tenant requests');
    expect(EMAIL_PLAYBOOK).toContain('coordinates contractors');
  });
  it('does not count a later-window reschedule as a new booking and shows cancelled pipeline state', () => {
    const events = [
      { id: 'original', accountId: 'a', kind: 'calendar_booking_confirmed', occurredAt: '2026-08-31T00:00:00.000Z', meetingId: 'm', evidence },
      { id: 'update', accountId: 'a', kind: 'calendar_booking_confirmed', occurredAt: at, meetingId: 'm', evidence },
      { id: 'cancel', accountId: 'a', kind: 'calendar_cancelled', occurredAt: '2026-09-10T00:00:00.000Z', meetingId: 'm', evidence },
    ];
    expect(countMilestones(events, window).meetingsBooked).toBe(0);
    expect(projectAccountPipeline([{ id: 'a' }], events)[0].stage).toBe('meeting_cancelled');
  });
  it('reads genuine applied C5 SQL ledger history, not optimistic commands or operational holds', async () => {
    const f = await createPmFixture();
    try {
      const account = f.repo.create({ commandId: '10000000-0000-4000-8000-000000000001', name: 'Fictional PM', domain: null });
      let clockNow = at;
      const repo = new DelegationRepository({ database: f.db, workspaceId: 'w', clock: { now: () => clockNow } });
      repo.initializeLocalAuthority(account.id);
      repo.queueCommand({ commandId: 'delegate', workspaceId: 'w', accountId: account.id, expectedAuthorityGeneration: 0, expectedVersion: 0, kind: 'delegate', payload: { delegationId: 'fictional-delegation', approvedAt: PM_NOW } });
      repo.applyWorkerEvent({ id: 'authority-event', workspaceId: 'w', accountId: account.id, authorityGeneration: 1, aggregateVersion: 1, kind: 'authority.changed',
        payload: { authority: { accountId: account.id, owner: 'worker', generation: 1, state: 'active' }, receipt: { commandId: 'delegate', status: 'applied', authorityGeneration: 1, aggregateVersion: 1, reason: null } } });
      const identity = { meetingId: 'm', calendarId: 'cal', providerEventId: 'abcde' };
      const event = { ...identity, status: 'confirmed' as const, etag: 'etag', start: at, end: '2026-09-09T01:00:00.000Z', attendees: [{ email: 'person@example.invalid', responseStatus: 'accepted' as const }], meetUrl: null as string | null };
      const envelope = { id: 'booked-event', workspaceId: 'w', accountId: account.id, authorityGeneration: 1, aggregateVersion: 2, kind: 'meeting.outcome' as const,
        payload: { commandId: 'booking-command', observedAt: at, outcome: { ...identity, status: 'booked' as const, reason: null as string | null, event } } };
      expect(repo.applyWorkerEvent(envelope)).toBe('applied');
      expect(repo.applyWorkerEvent(envelope)).toBe('duplicate');
      const facts = readAcquisitionFacts(f.db);
      expect(facts).toHaveLength(1);
      expect(countMilestones(facts, window)).toMatchObject({ meetingsBooked: 1, meetingsHeld: 0, pilotStarts: 0, costCents: null });
      clockNow = '2026-09-09T02:00:00.000Z';
      const attendance = { id: 'attendance-event', workspaceId: 'w', accountId: account.id, authorityGeneration: 1, aggregateVersion: 3, kind: 'acquisition.milestone_reported' as const,
        payload: { commandId: '10000000-0000-4000-8000-000000000002', observedAt: clockNow, source: 'owner_report' as const,
          report: { kind: 'meeting_attended' as const, ...identity, occurredAt: clockNow, sourceRef: 'owner-attendance-note', ownerNote: 'I attended this fictional meeting.' } },
        receipt: { commandId: '10000000-0000-4000-8000-000000000002', status: 'applied' as const, authorityGeneration: 1, aggregateVersion: 3, reason: null as null } };
      repo.queueCommand({ commandId: '10000000-0000-4000-8000-000000000002', workspaceId: 'w', accountId: account.id, expectedAuthorityGeneration: 1, expectedVersion: 2, kind: 'report-acquisition-milestone', payload: attendance.payload.report });
      expect(repo.applyWorkerEvent(attendance)).toBe('applied');
      expect(repo.applyWorkerEvent(attendance)).toBe('duplicate');
      expect(countMilestones(readAcquisitionFacts(f.db), window)).toMatchObject({ meetingsBooked: 1, meetingsHeld: 1, pilotStarts: 0 });
      expect(() => repo.applyWorkerEvent({ ...attendance, payload: { ...attendance.payload, report: { ...attendance.payload.report, ownerNote: 'Changed report' } } })).toThrow();

    } finally { f.close(); }
  });

  it('admits only explicit owner milestone evidence with immutable identity and ordered observation time', () => {
    const report = { kind: 'meeting_attended', meetingId: 'm', calendarId: 'cal', providerEventId: 'abcde', occurredAt: at,
      sourceRef: 'owner-note-1', ownerNote: 'I attended the fictional meeting.' };
    expect(acquisitionMilestoneReportSchema.safeParse(report).success).toBe(true);
    expect(acquisitionMilestoneReportSchema.safeParse({ ...report, source: 'model' }).success).toBe(false);
    expect(acquisitionMilestoneReportSchema.safeParse({ ...report, providerEventId: '' }).success).toBe(false);
    expect(acquisitionMilestoneReportSchema.safeParse({ ...report, ownerNote: ' ' }).success).toBe(false);
    const payload = { commandId: 'milestone-command', report, observedAt: at, source: 'owner_report' };
    expect(acquisitionMilestonePayloadSchema.safeParse(payload).success).toBe(true);
    expect(acquisitionMilestonePayloadSchema.safeParse({ ...payload, source: 'model' }).success).toBe(false);
    expect(acquisitionMilestonePayloadSchema.safeParse({ ...payload, observedAt: '2026-09-08T00:00:00.000Z' }).success).toBe(false);
    expect(acquisitionMilestoneReportSchema.safeParse({ kind: 'pilot_started', pilotId: 'pilot-1', occurredAt: at, sourceRef: 'pilot-log', ownerNote: 'The explicitly scoped fictional pilot actually started.' }).success).toBe(true);
  });

  it('counts owner-reported attendance and pilot facts once by stable identity, separately from bookings', () => {
    const common = { workspaceId: 'w', accountId: 'a', authorityGeneration: 1, kind: 'acquisition.milestone_reported' };
    const proof = { occurredAt: at, sourceRef: 'owner-record', ownerNote: 'I observed this fictional outcome.' };
    const events = [
      { ...common, id: 'attended', aggregateVersion: 1, payload: { commandId: 'attended-command', source: 'owner_report', observedAt: at,
        report: { kind: 'meeting_attended', meetingId: 'm', calendarId: 'cal', providerEventId: 'abcde', ...proof } } },
      ...['pilot_willingness', 'pilot_started', 'pilot_started'].map((kind, i) => ({ ...common, id: `pilot-${i}`, aggregateVersion: i + 2,
        payload: { commandId: `pilot-command-${i}`, source: 'owner_report', observedAt: at, report: { kind, pilotId: 'pilot-1', ...proof } } })),
    ];
    const canonical = events.map(event => ({ ...event, receipt: { commandId: event.payload.commandId, status: 'applied', authorityGeneration: 1, aggregateVersion: event.aggregateVersion, reason: null as null } }));
    const facts = fromAcquisitionWorkerEvents(canonical);
    expect(facts).toHaveLength(4);
    expect(countMilestones(facts, window)).toMatchObject({ meetingsBooked: 0, meetingsHeld: 1, pilotWillingness: 1, pilotStarts: 1 });
  });

});
