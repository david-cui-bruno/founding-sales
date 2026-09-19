import { z } from 'zod';
import { TODAY_LANES, todayViewSchema, type LaneCounts, type StatePostureSummary, type TodayCard, type TodayLane, type TodayNextStep, type TodayView,
  type V1HoldReason, type V1StateCode } from '../../../../../src/shared/contracts/v1Contract';
import type { DynamoStore } from '../dynamoStore';
import { territoryCallPolicyKey } from '../territoryPolicyRepository';
import { evaluateDial, type DialEvaluation } from './callWindow';
import { dayKey, dayRecordSchema, laneCounts, NEW_LANE_EXCLUSIONS, type DayRecord, type LaneEntry, type NewLaneExclusion } from './dayBuild';
import { createAccountFirmSource, type FirmCard, type FirmSource } from './firms';
import { readLastTick } from './lastTick';
import { EASTERN, localParts } from './localClock';
import { postureSummary, readPostures } from './postures';

/**
 * GET /v1/today (FSS target design section 3; slice S1). The day record's lanes expanded into cards from the firm source,
 * with everything about "now" computed here at request time: the firm's local time, open or closed, dialAllowed and its
 * hold from the firm's zone and the code floor window. The header carries builtAt, pool size, the holds by reason, the
 * last tick line and the postures by state. With no list: `{ list: null, reason }`, where no posture anywhere is
 * `no_posture`, no record yet for the Eastern date is `not_built_yet`, and a record with nothing in any lane is
 * `no_candidates`. Reading is never a dial and never a send.
 */

/** Which exclusion codes of the build are holds David reads, and under which user-facing reason. */
const HOLD_OF: Partial<Record<NewLaneExclusion, V1HoldReason>> = {
  suppressed: 'suppressed', state_unknown: 'state_not_cleared', zone_unknown: 'state_not_cleared', no_posture: 'state_not_cleared',
  posture_not_calling: 'state_not_cleared', posture_review_overdue: 'state_not_cleared', no_phone: 'no_phone',
};
const policyOfferSchema = z.object({ offer: z.string().max(4000) });

async function readOffer(store: DynamoStore): Promise<string | null> {
  const row = await store.get<unknown>(territoryCallPolicyKey(store.options.workspaceId));
  const parsed = policyOfferSchema.safeParse(row?.data);
  return parsed.success ? parsed.data.offer : null;
}

function nextStepOf(lane: TodayLane, firm: FirmCard): TodayNextStep {
  if (lane === 'replies') return { kind: 'reply' };
  if (lane === 'callbacks') return { kind: 'callback', dueOn: null };
  const enrollment = firm.enrollment;
  if (lane === 'new' || !enrollment || enrollment.currentStepIndex === null) return { kind: 'first_call' };
  return { kind: 'call', stepIndex: enrollment.currentStepIndex, stepCount: enrollment.stepCount, dueAt: enrollment.nextDueAt };
}

/** One card. Pure over the firm, the lane entry, the instant and the offer. */
export function todayCard(firm: FirmCard, lane: TodayLane, entry: LaneEntry, now: string, offer: string | null): TodayCard {
  const dial: DialEvaluation = firm.hold ? { dialAllowed: false, holdReason: firm.hold.reason, holdCode: firm.hold.code, localTime: null, openNow: null } : evaluateDial(now, firm.timeZone);
  return { firmId: firm.firmId, lane, reason: entry.reason, name: firm.name,
    phone: firm.phone ? { number: firm.phone.number, verification: firm.phone.verification } : null,
    website: firm.website, city: firm.city, state: firm.state, timeZone: firm.timeZone,
    localTime: dial.localTime, openNow: dial.openNow, dialAllowed: dial.dialAllowed, holdReason: dial.holdReason, holdCode: dial.holdCode,
    offer, lastOutcome: firm.lastCall ? { outcome: firm.lastCall.outcome, at: firm.lastCall.at, note: null } : null, nextStep: nextStepOf(lane, firm) };
}

/** The holds among the build's exclusions, by reason and code, in the order the build checks them. */
export function holdsOf(record: DayRecord): { reason: V1HoldReason; code: NewLaneExclusion; count: number }[] {
  const holds: { reason: V1HoldReason; code: NewLaneExclusion; count: number }[] = [];
  for (const code of NEW_LANE_EXCLUSIONS) {
    const reason = HOLD_OF[code]; const count = record.excluded[code];
    if (reason && count) holds.push({ reason, code, count });
  }
  return holds;
}

/** States the firms derive to that have no posture record, sorted. */
export function statesWithoutPosture(firms: readonly FirmCard[], postured: ReadonlySet<string>): V1StateCode[] {
  const states = new Set<V1StateCode>();
  for (const firm of firms) if (firm.state && !postured.has(firm.state)) states.add(firm.state);
  return [...states].sort();
}

const isEmpty = (counts: LaneCounts) => counts.replies + counts.callbacks + counts.due + counts.new === 0;

export async function readTodayView(store: DynamoStore, options: { firms?: FirmSource } = {}): Promise<TodayView> {
  const asOf = store.now();
  const date = localParts(asOf, EASTERN).date;
  const [dayRow, postures, firms, lastTick, offer] = await Promise.all([store.get<unknown>(dayKey(date)), readPostures(store),
    (options.firms ?? createAccountFirmSource(store)).listFirms(), readLastTick(store), readOffer(store)]);
  const summaries: StatePostureSummary[] = postures.map(record => postureSummary(record, asOf));
  const missing = statesWithoutPosture(firms, new Set(postures.map(record => record.state)));
  const day = dayRow ? dayRecordSchema.safeParse(dayRow.data) : null;
  const record = day?.success ? day.data : null;
  const counts = record ? laneCounts(record) : null;
  if (!record || !counts || isEmpty(counts)) {
    const reason = postures.length === 0 ? 'no_posture' : !record ? 'not_built_yet' : 'no_candidates';
    return todayViewSchema.parse({ asOf, list: null, reason, postures: summaries, statesWithoutPosture: missing });
  }
  const byFirm = new Map(firms.map(firm => [firm.firmId, firm]));
  const lanes = Object.fromEntries(TODAY_LANES.map(lane => [lane, record.lanes[lane].flatMap(entry => {
    const firm = byFirm.get(entry.firmId);
    return firm ? [todayCard(firm, lane, entry, asOf, offer)] : [];
  })])) as Record<TodayLane, TodayCard[]>;
  return todayViewSchema.parse({ asOf, list: { header: { date: record.date, builtAt: record.builtAt, poolSize: record.poolSize, counts, holds: holdsOf(record),
    excluded: record.excluded, lastTick, postures: summaries, statesWithoutPosture: missing }, lanes } });
}
