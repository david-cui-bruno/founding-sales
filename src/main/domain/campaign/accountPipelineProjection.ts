import type { AcquisitionFact } from '../../../shared/contracts/acquisitionReportContract';
import { countMilestones, uniqueAcquisitionFacts } from './acquisitionReport';

export type PipelineAccount = { id: string; historicalStage?: string; mergeCandidateAccountIds?: readonly string[] };
export function projectAccountPipeline(accounts: readonly PipelineAccount[], events: readonly AcquisitionFact[]) {
  const facts = uniqueAcquisitionFacts(events);
  return accounts.map(account => {
    const own = facts.filter(event => event.accountId === account.id);
    const report = countMilestones(own, { start: '0001-01-01T00:00:00.000Z', end: '9999-12-31T23:59:59.999Z' });
    const meetingState = new Map<string, string>();
    for (const fact of own) if (fact.occurredAt && fact.meetingId && fact.evidence && ['calendar_booking_confirmed', 'calendar_cancelled'].includes(fact.kind)) meetingState.set(fact.meetingId, fact.kind);
    const hasCurrentBooking = [...meetingState.values()].some(kind => kind === 'calendar_booking_confirmed');
    const stage = report.pilotStarts ? 'pilot_started' : report.meetingsHeld ? 'meeting_held' : hasCurrentBooking ? 'meeting_booked' : report.meetingsCancelled ? 'meeting_cancelled'
      : report.pilotWillingness ? 'pilot_willingness' : report.positiveResponses || report.conversations ? 'conversation' : report.manualCalls ? 'contacted' : 'unobserved';
    return { accountId: account.id, stage, historicalStage: account.historicalStage ?? null, report };
  });
}
