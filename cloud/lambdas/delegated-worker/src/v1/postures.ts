import type { TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { statePostureEntrySchema, statePostureRecordSchema, type SetStatePostureCommand, type StatePostureRecord, type StatePostureSummary,
  type V1StateCode } from '../../../../../src/shared/contracts/v1Contract';
import type { DynamoStore } from '../dynamoStore';

/**
 * David's calling posture per state (FSS target design section 2, `STATE#<ST>`; slice S1). One record per state in
 * the workspace partition, CAS on its own revision, history append-only. Recording a posture confirms nothing on its
 * own and dials nothing: it is the decision the list build and the dial evaluation read. A state clears when its
 * posture is `calling` and the review date (twelve months after the decision) has not passed; anything else is the
 * hold `state_not_cleared`, with the closed code below saying which condition failed. Nothing is ever seeded here.
 */

export const STATE_PREFIX = 'STATE#';
export const stateKey = (state: V1StateCode): string => `${STATE_PREFIX}${state}`;
export const POSTURE_REVIEW_MONTHS = 12;
export type StateClearanceCode = 'no_posture' | 'posture_not_calling' | 'posture_review_overdue';
export type StateClearance = { cleared: true } | { cleared: false; code: StateClearanceCode };

/** Twelve months after the decision, same UTC day and time; the 29th of February lands on the 1st of March. */
export function postureReviewAt(decidedAt: string): string {
  const date = new Date(Date.parse(decidedAt));
  if (!Number.isFinite(date.getTime())) throw new Error('posture_instant');
  const day = date.getUTCDate();
  date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() + POSTURE_REVIEW_MONTHS);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  if (day > lastDay) { date.setUTCDate(lastDay); date.setUTCDate(date.getUTCDate() + (day - lastDay)); } else date.setUTCDate(day);
  return date.toISOString();
}

/** Every stored posture, by state code. A row the contract refuses is skipped. */
export async function readPostures(store: DynamoStore): Promise<StatePostureRecord[]> {
  return (await store.list<unknown>(STATE_PREFIX)).flatMap(row => { const parsed = statePostureRecordSchema.safeParse(row.stored.data); return parsed.success ? [parsed.data] : []; })
    .sort((a, b) => a.state < b.state ? -1 : a.state > b.state ? 1 : 0);
}
export const posturesByState = (records: readonly StatePostureRecord[]): Map<string, StatePostureRecord> => new Map(records.map(record => [record.state, record]));

export function postureSummary(record: StatePostureRecord, now: string): StatePostureSummary {
  return { state: record.state, posture: record.posture, decidedAt: record.decidedAt, decidedBy: record.decidedBy, reviewAt: record.reviewAt, reviewOverdue: record.reviewAt <= now };
}

/** Whether calls to `state` are cleared now: a `calling` posture whose review is not yet due. Pure. */
export function stateClearance(postures: ReadonlyMap<string, StatePostureRecord>, state: string, now: string): StateClearance {
  const record = postures.get(state);
  if (!record) return { cleared: false, code: 'no_posture' };
  if (record.posture !== 'calling') return { cleared: false, code: 'posture_not_calling' };
  if (record.reviewAt <= now) return { cleared: false, code: 'posture_review_overdue' };
  return { cleared: true };
}

/**
 * The fenced put for one `set_state_posture`, for the router's receipt transaction: the new record carries the
 * prior record (without its own history) appended to history, so nothing David decided is ever lost. CAS on the
 * stored revision, or absent for a first decision.
 */
export async function planSetStatePosture(store: DynamoStore, command: SetStatePostureCommand, decidedBy: string): Promise<{ item: TransactWriteItem; record: StatePostureRecord }> {
  const key = stateKey(command.state);
  const row = await store.get<unknown>(key);
  const prior = row ? statePostureRecordSchema.safeParse(row.data) : null;
  const decidedAt = store.now();
  const entry = statePostureEntrySchema.parse({ state: command.state, posture: command.posture, registration: command.registration, dncList: command.dncList,
    ...(command.counsel ? { counsel: command.counsel } : {}), referenceTextRevision: command.referenceTextRevision, decidedAt, decidedBy, reviewAt: postureReviewAt(decidedAt) });
  const history = prior?.success ? [...prior.data.history, statePostureEntrySchema.parse(withoutHistory(prior.data))] : [];
  const record = statePostureRecordSchema.parse({ ...entry, history });
  return { item: store.put(key, record, row?.rev ?? null), record };
}

function withoutHistory(record: StatePostureRecord): Omit<StatePostureRecord, 'history'> {
  return { state: record.state, posture: record.posture, registration: record.registration, dncList: record.dncList, ...(record.counsel ? { counsel: record.counsel } : {}),
    referenceTextRevision: record.referenceTextRevision, decidedAt: record.decidedAt, decidedBy: record.decidedBy, reviewAt: record.reviewAt };
}
