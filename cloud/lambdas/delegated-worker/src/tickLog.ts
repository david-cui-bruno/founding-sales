import { SCHEDULED_RUN_EVENT, scheduledRunRecordSchema, tickErrorClassSchema, tickPhaseHoldSchema, type ScheduledRunRecord, type TickErrorClass,
  type TickHeldReason, type TickPhase, type TickPhaseHold, type TickPhaseResult } from '../../../../src/shared/contracts/researchSetupContract';
import type { SourceTickReport } from './sourceCoordinator';

/** Where the worker keeps its last scheduled tick so `/research/setup/status` can report `lastTickAt`. */
export const SOURCE_LAST_TICK_KEY = 'SOURCE_LAST_TICK';
/** The one log line per phase that named the condition it hit, beside the tick record itself. Closed reason and constructor class only. */
export const SCHEDULED_PHASE_HELD_EVENT = 'SCHEDULED_PHASE_HELD';
/** The closed list of top-level keys a tick record may carry. The record is built field by field from the report, never by spreading it,
 *  and then validated against the strict schema; anything else on the report (or any string that is not one of the enums) cannot pass. */
export const scheduledRunRecordFields = ['event', 'version', 'at', 'durationMs', 'status', 'phases', 'held', 'heldByReason', 'phaseHolds', 'territory', 'places', 'firmsCreated', 'jobsDrained',
  'researchPrepared', 'researchCompleted', 'mailPolls', 'dispatches', 'sendReconciliations', 'meetings', 'extraction', 'ledger', 'descriptorExpired', 'selfPaused'] as const satisfies readonly (keyof ScheduledRunRecord)[];
export const tickPhases: readonly TickPhase[] = ['research', 'configurations', 'submittedCommands', 'publications', 'territoryBackfill'];
/** An exception reduced to one of the recognized constructor classes. Anything unrecognized is `unknown`: no name, message or cause travels verbatim. */
export function tickErrorClass(error: unknown): TickErrorClass {
  const raw = error instanceof Error ? error.constructor?.name ?? error.name : '';
  const parsed = tickErrorClassSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const named = error instanceof Error ? tickErrorClassSchema.safeParse(error.name) : null;
  return named?.success ? named.data : 'unknown';
}
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
/** Only the closed reason and the closed constructor class of each named hold cross into the record; an unparsable entry is dropped, never coerced. */
function phaseHoldRecord(holds: SourceTickReport['phaseHolds']): Partial<Record<TickPhase, TickPhaseHold>> {
  const record: Partial<Record<TickPhase, TickPhaseHold>> = {};
  for (const phase of tickPhases) {
    const held = holds[phase]; if (!held) continue;
    const parsed = tickPhaseHoldSchema.safeParse({ reason: held.reason, errorClass: held.errorClass ?? null });
    if (parsed.success) record[phase] = parsed.data;
  }
  return record;
}
/** Counts and one outcome enum only: no account id, route id or policy id from the sweep, and no template,
 *  address or hold reason from the sequence email walk that runs in the same phase. */
function territoryRecord(territory: SourceTickReport['territory'], emails: SourceTickReport['sequenceEmails']): ScheduledRunRecord['territory'] {
  if (!territory) return null;
  const skipped = territory.skipped;
  return { outcome: territory.outcome, scanned: count(territory.scanned), enrolled: count(territory.enrolled), replayed: count(territory.replayed),
    reentered: count(territory.reentered ?? 0), emailsSent: count(emails?.sent ?? 0), emailsHeld: count(emails?.held ?? 0),
    skipped: { policy_paused: count(skipped.policy_paused), authority_exists: count(skipped.authority_exists), route_unavailable: count(skipped.route_unavailable), enrollment_failed: count(skipped.enrollment_failed) } };
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
    phaseHolds: phaseHoldRecord(report.phaseHolds), territory: territoryRecord(report.territory, report.sequenceEmails),
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
  try {
    log(JSON.stringify(record));
    // One extra line per phase that named its condition, so the reason is greppable in CloudWatch without reading the whole record.
    for (const phase of tickPhases) {
      const held = record.phaseHolds[phase]; if (!held) continue;
      log(JSON.stringify({ event: SCHEDULED_PHASE_HELD_EVENT, version: 1, at: record.at, phase, reason: held.reason, errorClass: held.errorClass }));
    }
  } catch { /* Logging must not fail the invocation. */ }
  return record;
}
