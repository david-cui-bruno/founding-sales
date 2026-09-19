import type { TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { z } from 'zod';
import { accountInstantSchema } from '../../../../../src/shared/contracts/accountContract';
import { territoryCallPolicySchema, type TerritoryCallPolicy } from '../../../../../src/shared/contracts/territoryCallPolicyContract';
import { v1CallOutcomeSchema, v1FirmViewSchema, type LogCallOutcomeCommand, type TodayCard, type TodayLane, type TodayNextStep,
  type V1FirmCall, type V1FirmRoute, type V1FirmStatus, type V1FirmView, type V1PendingCallback } from '../../../../../src/shared/contracts/v1Contract';
import { keyPart, type DynamoStore } from '../dynamoStore';
import { territoryCallPolicyKey } from '../territoryPolicyRepository';
import { evaluateDial, type DialEvaluation } from './callWindow';
import { dayKey, dayRecordSchema, LANE_REASONS, type LaneEntry } from './dayBuild';
import { createAccountFirmSource, type FirmCard, type FirmSource } from './firms';
import { planFirmStatus, readFirmRecord } from './firmsWrite';
import { EASTERN, localParts } from './localClock';
import { advanceAfterCall, readSequenceRecord, sequenceStateOf, type SequenceRecord } from './sequence';
import { firmSuppressionView, planSuppress, readFirmSuppression } from './suppression';
import { todayCard } from './today';

/**
 * One dialed call, logged once (FSS target design sections 2 and 3: `CALL#<firmId>#<ts>`, `CALLBACK#<dueOn>#<firmId>`
 * and the `log_call_outcome` command; slice S2), and the Firm view that reads it all back.
 *
 * Everything one outcome causes happens in the router's single transaction: the call record, the callback the outcome
 * promised (or the one it just made, resolved), the suppression set an opt-out or a never-call reason writes, and the
 * sequence advance with its due pointer. So a lost response can never leave a call recorded without its consequences,
 * and a repeated command id returns the first receipt with the same card attached.
 *
 * The worker's own dial evaluation at `observedAt` is recorded beside the outcome. It is not a permission — David
 * dialed the number himself from Phone.app — it is the honest record of whether the card he dialed from was open,
 * held outside hours, or held because the firm's state had no clearance. Nothing here dials, sends or books.
 */

export const CALL_PREFIX = 'CALL#';
export const CALLBACK_PREFIX = 'CALLBACK#';
export const callPrefixOf = (firmId: string): string => `${CALL_PREFIX}${keyPart(firmId)}#`;
export const callKey = (firmId: string, at: string): string => `${callPrefixOf(firmId)}${accountInstantSchema.parse(at)}`;
export const callbackKey = (dueOn: string, firmId: string): string => `${CALLBACK_PREFIX}${z.iso.date().parse(dueOn)}#${keyPart(firmId)}`;

const instant = accountInstantSchema;
const dialSchema = z.strictObject({
  dialAllowed: z.boolean(),
  holdReason: z.enum(['outside_hours', 'state_not_cleared']).nullable(),
  holdCode: z.enum(['outside_hours', 'zone_unknown', 'state_unknown']).nullable(),
  localTime: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
  openNow: z.boolean().nullable(),
});
/** `CALL#<firmId>#<observedAt>`. Permanent: the durable audit of what was said on the phone and what followed. */
export const callRecordSchema = z.strictObject({
  version: z.literal(1),
  firmId: z.string().min(1).max(200),
  outcome: v1CallOutcomeSchema,
  note: z.string().max(2000).nullable(),
  callbackOn: z.iso.date().nullable(),
  neverCallReason: z.string().max(400).nullable(),
  /** The route the sequence stood on when the call was made; null for a firm with no phone route left. */
  routeId: z.string().max(200).nullable(),
  observedAt: instant,
  recordedAt: instant,
  /** The worker's dial verdict at `observedAt`, recorded and never enforced here. */
  dial: dialSchema,
  deviceId: z.string().uuid(),
  commandId: z.string().uuid(),
});
export type CallRecord = z.infer<typeof callRecordSchema>;
/** `CALLBACK#<dueOn>#<firmId>`. `pending` leads the callbacks lane on its day; the other two states are its history. */
export const callbackRecordSchema = z.strictObject({
  version: z.literal(1),
  firmId: z.string().min(1).max(200),
  dueOn: z.iso.date(),
  promisedAt: instant,
  /** The call that promised it: its `CALL#` sort key. */
  promisedBy: z.string().min(1).max(400),
  state: z.enum(['pending', 'made', 'suppressed']),
  resolvedAt: instant.nullable(),
});
export type CallbackRecord = z.infer<typeof callbackRecordSchema>;

export async function readPolicy(store: DynamoStore): Promise<TerritoryCallPolicy | null> {
  const row = await store.get<unknown>(territoryCallPolicyKey(store.options.workspaceId));
  if (!row) return null;
  const parsed = territoryCallPolicySchema.safeParse(row.data);
  return parsed.success ? parsed.data : null;
}

/** Every call logged against one firm, oldest first. One prefix query. */
export async function listCalls(store: DynamoStore, firmId: string): Promise<CallRecord[]> {
  return (await store.list<unknown>(callPrefixOf(firmId)))
    .flatMap(row => { const parsed = callRecordSchema.safeParse(row.stored.data); return parsed.success ? [parsed.data] : []; })
    .sort((a, b) => a.observedAt < b.observedAt ? -1 : a.observedAt > b.observedAt ? 1 : 0);
}

/** Every callback of one firm, newest promise first. The `CALLBACK#` range is keyed by date, so this reads the range and filters. */
export async function listCallbacks(store: DynamoStore, firmId: string): Promise<{ record: CallbackRecord; rev: number }[]> {
  return (await store.list<unknown>(CALLBACK_PREFIX))
    .flatMap(row => { const parsed = callbackRecordSchema.safeParse(row.stored.data); return parsed.success && parsed.data.firmId === firmId ? [{ record: parsed.data, rev: row.stored.rev }] : []; })
    .sort((a, b) => a.record.dueOn < b.record.dueOn ? 1 : a.record.dueOn > b.record.dueOn ? -1 : 0);
}

export const pendingCallbackOf = (callbacks: readonly { record: CallbackRecord }[]): CallbackRecord | null =>
  callbacks.map(entry => entry.record).find(record => record.state === 'pending') ?? null;

/**
 * The dial verdict of one firm, which is the call window's verdict widened by the one hold the window knows nothing
 * about: a suppressed firm. Annotated rather than inferred, because the root tsconfig compiles this module (the
 * integration tests reach it through the handler) with `noImplicitAny` and without `strictNullChecks`, where a bare
 * `null` in an unannotated object literal is an implicit `any`.
 */
export type FirmDialVerdict = {
  dialAllowed: boolean;
  holdReason: 'outside_hours' | 'state_not_cleared' | 'suppressed' | null;
  holdCode: 'outside_hours' | 'zone_unknown' | 'state_unknown' | 'suppressed' | null;
  localTime: string | null;
  openNow: boolean | null;
};

/** The dial verdict the record carries: the firm's own hold first, the code window second. Pure. */
export function dialAt(firm: Pick<FirmCard, 'hold' | 'timeZone'>, at: string): DialEvaluation {
  if (firm.hold) return { dialAllowed: false, holdReason: firm.hold.reason, holdCode: firm.hold.code, localTime: null, openNow: null };
  return evaluateDial(at, firm.timeZone);
}

export type LogCallOutcomeRefusal = 'firm_unknown' | 'policy_missing' | 'callback_date_missing' | 'suppressed';
export type LogCallOutcomePlan =
  | { outcome: 'planned'; items: TransactWriteItem[]; card: TodayCard | null; call: CallRecord; sequence: SequenceRecord; suppressed: boolean }
  | { outcome: 'refused'; reason: LogCallOutcomeRefusal };

/**
 * The writes of one `log_call_outcome`, for the router's transaction, plus the card as it stands afterwards.
 *
 * `opt_out`, and any outcome carrying a never-call reason, writes the whole suppression set (the firm and every one
 * of its known routes, canonically keyed) and stops the sequence: a suppressed firm is never advanced, never offered
 * and never dialed again, and there is no unsuppress. `callback` writes the pointer whose own date leads the
 * callbacks lane and leaves the cadence's timing aside; any other outcome resolves a callback that was pending,
 * because the call David just made is the callback he promised.
 */
export async function planLogCallOutcome(store: DynamoStore, input: {
  command: LogCallOutcomeCommand;
  device: { deviceId: string; label: string };
  firms?: FirmSource;
}): Promise<LogCallOutcomePlan> {
  const { command } = input;
  if (command.outcome === 'callback' && command.callbackOn === undefined) return { outcome: 'refused', reason: 'callback_date_missing' };
  const policy = await readPolicy(store);
  if (!policy) return { outcome: 'refused', reason: 'policy_missing' };
  const firms = await (input.firms ?? createAccountFirmSource(store)).listFirms();
  const firm = firms.find(candidate => candidate.firmId === command.firmId);
  if (!firm) return { outcome: 'refused', reason: 'firm_unknown' };
  // A firm already suppressed is never called again, so an outcome against it is refused rather than recorded.
  if (await readFirmSuppression(store, firm.firmId)) return { outcome: 'refused', reason: 'suppressed' };

  const recordedAt = store.now();
  const dial = dialAt(firm, command.observedAt);
  const neverCallReason = command.neverCall?.reason ?? null;
  const suppressing = command.outcome === 'opt_out' || neverCallReason !== null;
  const sequenceBefore = await readSequenceRecord(store, firm.firmId);
  const call = callRecordSchema.parse({
    version: 1, firmId: firm.firmId, outcome: command.outcome, note: command.note ?? null,
    callbackOn: command.callbackOn ?? null, neverCallReason,
    routeId: sequenceBefore?.record.routeId ?? firm.phone?.routeId ?? null,
    observedAt: command.observedAt, recordedAt,
    dial: { dialAllowed: dial.dialAllowed, holdReason: dial.holdReason, holdCode: dial.holdCode, localTime: dial.localTime, openNow: dial.openNow },
    deviceId: input.device.deviceId, commandId: command.commandId,
  });
  const callSortKey = callKey(firm.firmId, call.observedAt);
  const items: TransactWriteItem[] = [store.put(callSortKey, call, null)];

  // The callbacks this outcome promises or resolves.
  const callbacks = await listCallbacks(store, firm.firmId);
  const pending = callbacks.find(entry => entry.record.state === 'pending');
  let promised: CallbackRecord | null = null;
  if (command.outcome === 'callback' && command.callbackOn !== undefined) {
    const key = callbackKey(command.callbackOn, firm.firmId);
    const existing = callbacks.find(entry => callbackKey(entry.record.dueOn, entry.record.firmId) === key);
    promised = callbackRecordSchema.parse({ version: 1, firmId: firm.firmId, dueOn: command.callbackOn, promisedAt: command.observedAt,
      promisedBy: callSortKey, state: 'pending', resolvedAt: null });
    items.push(store.put(key, promised, existing?.rev ?? null));
    if (pending && callbackKey(pending.record.dueOn, pending.record.firmId) !== key) items.push(resolveCallback(store, pending, 'made', recordedAt));
  } else if (pending) {
    items.push(resolveCallback(store, pending, suppressing ? 'suppressed' : 'made', recordedAt));
  }

  // The suppression set, written whole or not at all, and the firm record's own status beside it.
  if (suppressing) {
    const plan = await planSuppress(store, { firmId: firm.firmId, routes: firm.routes,
      reason: neverCallReason ?? 'Asked not to be contacted again on the call.', source: 'call', evidenceRef: callSortKey, recordedBy: input.device.label });
    if (plan.outcome === 'refused') return { outcome: 'refused', reason: 'suppressed' };
    items.push(...plan.items);
    items.push(...await planFirmStatus(store, firm.firmId, 'suppressed'));
  }

  // The sequence. A suppressed firm stops whatever the outcome word was.
  const advance = await advanceAfterCall(store, { firm, policy, outcome: suppressing ? 'opt_out' : command.outcome,
    observedAt: command.observedAt, routeId: call.routeId, commandId: command.commandId });
  items.push(...advance.items);

  const card = suppressing ? null : await cardAfterCall(store, {
    firm, call, sequence: advance.record, policy, pendingCallback: promised, hold: advance.hold,
    replacementRouteId: advance.replacementRouteId, now: recordedAt,
  });
  return { outcome: 'planned', items, card, call, sequence: advance.record, suppressed: suppressing };
}

/** The write that closes a pending callback: kept, with the state that closed it, never deleted. */
function resolveCallback(store: DynamoStore, held: { record: CallbackRecord; rev: number }, state: 'made' | 'suppressed', at: string): TransactWriteItem {
  return store.put(callbackKey(held.record.dueOn, held.record.firmId),
    callbackRecordSchema.parse({ ...held.record, state, resolvedAt: at }), held.rev);
}

/** The next step a `SEQ#` record implies, for a card. Pure. */
export function nextStepOfSequence(record: SequenceRecord, pendingCallback: CallbackRecord | null): TodayNextStep {
  if (pendingCallback) return { kind: 'callback', dueOn: pendingCallback.dueOn };
  const index = record.currentStepId === null ? -1 : record.steps.findIndex(step => step.id === record.currentStepId);
  if (index < 0) return { kind: 'first_call' };
  return { kind: 'call', stepIndex: index, stepCount: record.steps.length, dueAt: record.nextDueAt };
}

/**
 * The card as it stands after one outcome: the same card the Today view would build, with the outcome, the note, the
 * pending callback and the advanced step already on it, so the Mac updates from the answer instead of re-reading.
 * The lane is the one the firm stands in on today's list; a firm not on it is shown in the lane its sequence implies.
 */
export async function cardAfterCall(store: DynamoStore, input: {
  firm: FirmCard; call: CallRecord; sequence: SequenceRecord; policy: TerritoryCallPolicy;
  pendingCallback: CallbackRecord | null; hold: 'no_phone' | null; replacementRouteId: string | null; now: string;
}): Promise<TodayCard> {
  const { firm, call, sequence } = input;
  const lane = input.pendingCallback ? 'callbacks' : await laneOfFirm(store, firm.firmId, input.now);
  const entry: LaneEntry = { firmId: firm.firmId, reason: LANE_REASONS[lane] };
  const phone = input.replacementRouteId
    ? firm.routes.filter(route => route.id === input.replacementRouteId).map(route => ({ routeId: route.id, number: route.value, verification: route.verification }))[0] ?? null
    : input.hold === 'no_phone' ? null : firm.phone;
  const patched: FirmCard = { ...firm, phone, calls: firm.calls + 1, lastCall: { outcome: call.outcome, at: call.observedAt } };
  const base = todayCard(patched, lane, entry, input.now, input.policy.offer);
  const holdFromAdvance = input.hold === 'no_phone' ? { dialAllowed: false, holdReason: 'no_phone' as const, holdCode: 'no_phone' as const } : null;
  return {
    ...base,
    ...(holdFromAdvance ?? {}),
    lastOutcome: { outcome: call.outcome, at: call.observedAt, note: call.note },
    pendingCallback: input.pendingCallback ? { dueOn: input.pendingCallback.dueOn, promisedAt: input.pendingCallback.promisedAt } : null,
    nextStep: nextStepOfSequence(sequence, input.pendingCallback),
  };
}

/** The lane today's list puts this firm in, or the one its sequence implies when the list does not name it. */
async function laneOfFirm(store: DynamoStore, firmId: string, now: string): Promise<TodayLane> {
  const row = await store.get<unknown>(dayKey(localParts(now, EASTERN).date));
  const parsed = row ? dayRecordSchema.safeParse(row.data) : null;
  if (parsed?.success) {
    for (const lane of ['replies', 'callbacks', 'due', 'new'] as const) if (parsed.data.lanes[lane].some(entry => entry.firmId === firmId)) return lane;
  }
  return 'due';
}

/** The firm's status as the Firm view reports it, from the records that decide it. Pure. */
export function firmStatusOf(input: { suppressed: boolean; sequence: SequenceRecord | null; enrolled: boolean; calls: number; recordStatus: V1FirmStatus | null }): V1FirmStatus {
  if (input.suppressed) return 'suppressed';
  if (input.sequence) {
    if (input.sequence.state === 'stopped') return 'done';
    if (input.sequence.state === 'paused') return 'resting';
    return 'in_sequence';
  }
  if (input.enrolled || input.calls > 0) return 'in_sequence';
  return input.recordStatus ?? 'listed';
}

/**
 * `GET /v1/firms` for one firm (FSS target design section 3). Routes with the verification word and whether each is
 * retired or suppressed, the sequence state (the `SEQ#` record first, the carried enrollment second), every call, the
 * callbacks, the suppression record, a one-line evidence summary and the holds that stand between the firm and a dial
 * now. A read is never a dial: `dialAllowed` is computed here, at request time, exactly as it is on a card.
 */
export async function readFirmView(store: DynamoStore, firmId: string, options: { firms?: FirmSource } = {}): Promise<V1FirmView | null> {
  const asOf = store.now();
  const firms = await (options.firms ?? createAccountFirmSource(store)).listFirms();
  const firm = firms.find(candidate => candidate.firmId === firmId);
  if (!firm) return null;
  const [sequence, calls, callbacks, suppression, record] = await Promise.all([
    readSequenceRecord(store, firmId), listCalls(store, firmId), listCallbacks(store, firmId), readFirmSuppression(store, firmId), readFirmRecord(store, firmId)]);
  const suppressedHandles = new Set(suppression?.handles ?? []);
  const retired = new Set(firm.retiredRouteIds);
  const routes: V1FirmRoute[] = firm.routes
    .filter(route => route.channel === 'phone' || route.channel === 'email')
    .map((route): V1FirmRoute => ({ routeId: route.id, channel: route.channel === 'phone' ? 'phone' : 'email', value: route.value, verification: route.verification,
      retired: retired.has(route.id), suppressed: suppressedHandles.has(route.value) }))
    .sort((a, b) => a.routeId < b.routeId ? -1 : a.routeId > b.routeId ? 1 : 0);
  const dial: FirmDialVerdict = suppression
    ? { dialAllowed: false, holdReason: 'suppressed', holdCode: 'suppressed', localTime: null, openNow: null }
    : dialAt(firm, asOf);
  const holds = [] as V1FirmView['holds'];
  if (suppression) holds.push({ reason: 'suppressed', code: 'suppressed', count: 1 });
  if (!firm.phone) holds.push({ reason: 'no_phone', code: 'no_phone', count: 1 });
  if (dial.holdReason === 'state_not_cleared' && dial.holdCode) holds.push({ reason: 'state_not_cleared', code: dial.holdCode, count: 1 });
  if (dial.holdReason === 'outside_hours') holds.push({ reason: 'outside_hours', code: 'outside_hours', count: 1 });
  const callView: V1FirmCall[] = calls.map(call => ({ at: call.observedAt, outcome: call.outcome, note: call.note, callbackOn: call.callbackOn,
    neverCallReason: call.neverCallReason, routeId: call.routeId, dialAllowed: call.dial.dialAllowed, holdCode: call.dial.holdCode, deviceId: call.deviceId }));
  const callbackView: V1PendingCallback[] = callbacks.filter(entry => entry.record.state === 'pending')
    .map(entry => ({ dueOn: entry.record.dueOn, promisedAt: entry.record.promisedAt }));
  return v1FirmViewSchema.parse({
    asOf, firmId: firm.firmId, name: firm.name, website: firm.website, city: firm.city, state: firm.state, timeZone: firm.timeZone,
    status: firmStatusOf({ suppressed: suppression !== null, sequence: sequence?.record ?? null, enrolled: firm.enrollment !== null, calls: firm.calls,
      recordStatus: record?.record.status ?? null }),
    localTime: dial.localTime, dialAllowed: dial.dialAllowed, holdReason: dial.holdReason, holdCode: dial.holdCode,
    routes, sequence: sequenceStateOf(sequence?.record ?? null, firm), calls: callView, callbacks: callbackView,
    suppression: firmSuppressionView(suppression),
    evidence: { sources: firm.sourceCount, researchedAt: firm.enteredBy === 'hand' ? null : firm.researchedAt, enteredBy: firm.enteredBy },
    holds: holds.slice(0, 20),
  });
}

/** The pending callback of one firm, for a card the Today view builds (S2's addition to `GET /v1/today`). */
export async function pendingCallbacksByFirm(store: DynamoStore): Promise<Map<string, V1PendingCallback>> {
  const pending = new Map<string, V1PendingCallback>();
  for (const row of await store.list<unknown>(CALLBACK_PREFIX)) {
    const parsed = callbackRecordSchema.safeParse(row.stored.data);
    if (!parsed.success || parsed.data.state !== 'pending') continue;
    const held = pending.get(parsed.data.firmId);
    if (!held || held.dueOn > parsed.data.dueOn) pending.set(parsed.data.firmId, { dueOn: parsed.data.dueOn, promisedAt: parsed.data.promisedAt });
  }
  return pending;
}

/** The last call of each firm, for the Today cards (the outcome and the note David typed). One prefix query. */
export async function lastCallsByFirm(store: DynamoStore): Promise<Map<string, CallRecord>> {
  const last = new Map<string, CallRecord>();
  for (const row of await store.list<unknown>(CALL_PREFIX)) {
    const parsed = callRecordSchema.safeParse(row.stored.data);
    if (!parsed.success) continue;
    const held = last.get(parsed.data.firmId);
    if (!held || held.observedAt < parsed.data.observedAt) last.set(parsed.data.firmId, parsed.data);
  }
  return last;
}
