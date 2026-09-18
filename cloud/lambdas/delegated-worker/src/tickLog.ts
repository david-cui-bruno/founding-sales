import { SCHEDULED_RUN_EVENT, scheduledRunRecordSchema, type ScheduledRunRecord, type TickHeldReason, type TickPhase, type TickPhaseResult } from '../../../../src/shared/contracts/researchSetupContract';
import type { SourceTickReport } from './sourceCoordinator';

/** Where the worker keeps its last scheduled tick so `/research/setup/status` can report `lastTickAt`. */
export const SOURCE_LAST_TICK_KEY = 'SOURCE_LAST_TICK';
/** The closed list of top-level keys a tick record may carry. The record is built field by field from the report, never by spreading it,
 *  and then validated against the strict schema; anything else on the report (or any string that is not one of the enums) cannot pass. */
export const scheduledRunRecordFields = ['event', 'version', 'at', 'durationMs', 'status', 'phases', 'held', 'heldByReason', 'places', 'firmsCreated', 'jobsDrained',
  'researchPrepared', 'researchCompleted', 'mailPolls', 'dispatches', 'sendReconciliations', 'meetings', 'extraction', 'ledger', 'descriptorExpired', 'selfPaused'] as const satisfies readonly (keyof ScheduledRunRecord)[];
export const tickPhases: readonly TickPhase[] = ['research', 'configurations', 'submittedCommands', 'publications'];
const count = (value: number): number => Number.isSafeInteger(value) && value >= 0 ? value : 0;
/** Counts only: the Places `runId` (a derived UUID) and every skipped-reason counter are kept, nothing else from the batch report. */
function placesRecord(places: SourceTickReport['places']): ScheduledRunRecord['places'] {
  if (!places) return null;
  const skipped = places.skipped;
  return { outcome: places.outcome, created: count(places.created), routes: count(places.routes), enqueued: count(places.enqueued), drained: count(places.drained),
    skipped: { no_website: count(skipped.no_website), website_blocked: count(skipped.website_blocked), duplicate_domain: count(skipped.duplicate_domain), duplicate_phone: count(skipped.duplicate_phone),
      existing_domain: count(skipped.existing_domain), existing_phone: count(skipped.existing_phone), route_held: count(skipped.route_held), enqueue_held: count(skipped.enqueue_held) } };
}
function phaseRecord(phases: SourceTickReport['phases']): Partial<Record<TickPhase, TickPhaseResult>> {
  const record: Partial<Record<TickPhase, TickPhaseResult>> = {};
  for (const phase of tickPhases) { const result = phases[phase]; if (result) record[phase] = result; }
  return record;
}
function heldRecord(reasons: SourceTickReport['heldByReason']): Partial<Record<TickHeldReason, number>> {
  const record: Partial<Record<TickHeldReason, number>> = {};
  for (const [reason, value] of Object.entries(reasons) as [TickHeldReason, number][]) if (count(value) > 0) record[reason] = count(value);
  return record;
}
/** Pure. Throws when the report cannot be expressed within the closed field list, so a malformed record is never logged or persisted. */
export function buildScheduledRunRecord(report: SourceTickReport, input: { at: string; durationMs: number }): ScheduledRunRecord {
  return scheduledRunRecordSchema.parse({ event: SCHEDULED_RUN_EVENT, version: 1, at: input.at, durationMs: count(Math.round(input.durationMs)),
    status: report.status, phases: phaseRecord(report.phases), held: count(report.held), heldByReason: heldRecord(report.heldByReason),
    places: placesRecord(report.places), firmsCreated: count(report.places?.created ?? 0), jobsDrained: count(report.places?.drained ?? 0),
    researchPrepared: count(report.researchPrepared), researchCompleted: count(report.researchCompleted), mailPolls: count(report.mailPolls),
    dispatches: count(report.dispatches), sendReconciliations: count(report.sendReconciliations), meetings: count(report.meetings),
    extraction: { calls: count(report.extraction.calls), settledCostMicros: count(report.extraction.settledCostMicros), refundedMicros: count(report.extraction.refundedMicros) },
    ledger: report.ledger ? { discoveryRemainingMicros: count(report.ledger.discoveryRemainingMicros), researchRemainingMicros: count(report.ledger.researchRemainingMicros) } : null,
    descriptorExpired: report.descriptorExpired === true, selfPaused: report.selfPaused === true } satisfies ScheduledRunRecord);
}
/** One application log line per scheduled tick, as JSON so the CloudWatch metric filter can read `held` and `places.outcome`.
 *  A record that cannot be built is not logged in any other form: the report is never interpolated. */
export function logScheduledRun(report: SourceTickReport, input: { at: string; durationMs: number }, log: (line: string) => void = line => console.log(line)): ScheduledRunRecord | null {
  let record: ScheduledRunRecord;
  try { record = buildScheduledRunRecord(report, input); } catch { return null; }
  try { log(JSON.stringify(record)); } catch { /* Logging must not fail the invocation. */ }
  return record;
}
