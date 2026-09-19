import { QueryCommand } from '@aws-sdk/client-dynamodb';
import { z } from 'zod';
import { accountInstantSchema } from '../../../../../src/shared/contracts/accountContract';
import { attemptReasonSchema, laneCountsSchema, TODAY_LANES, type LaneCounts, type StatePostureRecord } from '../../../../../src/shared/contracts/v1Contract';
import { keyPart, type DynamoStore } from '../dynamoStore';
import { attemptCode, recordAttempt } from './attempts';
import { pendingCallbacksByFirm } from './calls';
import { createAccountFirmSource, type FirmCard, type FirmSource } from './firms';
import { currentStepOf, isFirstCallOnSequence, listSequenceRecords, type SequenceRecord } from './sequence';
import { EASTERN, endOfLocalDay, localParts } from './localClock';
import { posturesByState, readPostures, stateClearance } from './postures';

/**
 * The morning list (FSS target design sections 2 and 4; slice S1). `day.build` runs inside the existing scheduled
 * tick until S3 moves it onto the queue: at the first tick at or after 05:00 America/New_York (the date and the hour
 * computed with Intl, never a fixed offset) with no `DAY#<date>` yet, it builds the four lanes in order and writes
 * the day record once, absent-fenced, so two ticks can never build the same morning twice.
 *
 *   replies    firms with an unresolved reply signal in the existing thread intake records
 *   callbacks  firms with a pending CALLBACK# due on or before today on the firm's own clock; they lead the due lane,
 *              because the date David promised is what decides when the firm is called
 *   due        DUE# pointers to the end of the Eastern day whose sequence stands on a call step and has been called before
 *   new        up to 30 firms: posture calling for the derived state with its review not overdue, not suppressed, state and
 *              zone known, a phone route present, never in any earlier DAY#, no call under the old keys and not mid-sequence;
 *              ordered by research recency, then evidence richness, then name
 *
 * `DUE#<nextDueAt>#<firmId>` pointers are backfilled from the enrollment records on the same read until S3 writes them
 * beside the sequence in one transaction; a pointer is a hint the range read checks against the live enrollment, never
 * the truth on its own. The build records one `list` attempt with the counts and logs one LIST_BUILT line (counts only,
 * no firm, number or name), which the Terraform alarm reads. It never throws into the tick.
 */

export const DAY_PREFIX = 'DAY#';
export const dayKey = (date: string): string => `${DAY_PREFIX}${z.iso.date().parse(date)}`;
/** 05:00 on the Eastern clock, in minutes of the day. */
export const LIST_BUILD_START_MINUTE = 5 * 60;
/** Fixed in code by David's decision (design section 3): thirty new firms a morning. */
export const NEW_FIRMS_PER_DAY = 30;
export const LIST_BUILT_EVENT = 'LIST_BUILT';
/** Why a firm is in its lane. */
export const LANE_REASONS = { replies: 'reply_waiting', callbacks: 'callback_due', due: 'step_due', new: 'new_firm' } as const;
/** Why a firm was left out of the new lane, in the order the conditions are checked. Closed; counted on the day record. */
export const NEW_LANE_EXCLUSIONS = ['suppressed', 'state_unknown', 'zone_unknown', 'no_posture', 'posture_not_calling', 'posture_review_overdue', 'no_phone',
  'already_listed', 'called_before', 'in_sequence', 'over_cap'] as const;
export type NewLaneExclusion = typeof NEW_LANE_EXCLUSIONS[number];
/** Reply signals that wait for David; an opt-out is suppression, an out-of-office or delivery failure is not a reply. */
const REPLY_SIGNALS = new Set(['substantive', 'scheduling', 'mixed', 'ambiguous', 'rejection']);

export const laneEntrySchema = z.strictObject({ firmId: z.string().min(1), reason: attemptReasonSchema });
export type LaneEntry = z.infer<typeof laneEntrySchema>;
export const dayRecordSchema = z.strictObject({
  version: z.literal(1), date: z.iso.date(), timeZone: z.literal(EASTERN), builtAt: accountInstantSchema,
  lanes: z.strictObject({ replies: z.array(laneEntrySchema), callbacks: z.array(laneEntrySchema), due: z.array(laneEntrySchema), new: z.array(laneEntrySchema).max(NEW_FIRMS_PER_DAY) }),
  /** Firms that passed every new-lane condition before the cap. */
  poolSize: z.number().int().nonnegative(),
  /** Firms left out of the new lane, by the first condition that failed. */
  excluded: z.record(attemptReasonSchema, z.number().int().positive()),
});
export type DayRecord = z.infer<typeof dayRecordSchema>;

export const DUE_PREFIX = 'DUE#';
/** The end of the DUE# range up to and including a due instant: `~` sorts after the `#` that precedes the firm id. */
export const dueRangeEnd = (until: string): string => `${DUE_PREFIX}${accountInstantSchema.parse(until)}~`;
export const dueKey = (nextDueAt: string, firmId: string): string => `${DUE_PREFIX}${accountInstantSchema.parse(nextDueAt)}#${keyPart(firmId)}`;
export const duePointerSchema = z.strictObject({ version: z.literal(1), firmId: z.string().min(1), enrollmentId: z.string().min(1), stepId: z.string().min(1),
  nextDueAt: accountInstantSchema, writtenAt: accountInstantSchema });
export type DuePointer = z.infer<typeof duePointerSchema>;
/** Dynamo allows 100 items per transaction; the backfill writes the pointers in batches of this size. */
const POINTER_BATCH = 100;

/**
 * The pointer a firm should have now, or null for a firm with no due instant (not on the sequence, resting, held,
 * stopped, completed). Read new-first: the `SEQ#` record slice S2 owns answers when there is one, and the old
 * enrollment pair answers otherwise. Without the new-first read a firm the outcome form advanced would fail this
 * check against a stale enrollment and drop out of the due lane until S6 retired the old records.
 */
export function expectedDuePointer(firm: FirmCard, writtenAt: string, sequence?: SequenceRecord | null): DuePointer | null {
  if (sequence) {
    if (sequence.state !== 'active' || !sequence.nextDueAt || !sequence.currentStepId) return null;
    return { version: 1, firmId: firm.firmId, enrollmentId: sequence.enrollmentId, stepId: sequence.currentStepId, nextDueAt: sequence.nextDueAt, writtenAt };
  }
  const enrollment = firm.enrollment;
  if (!enrollment || enrollment.state !== 'active' || !enrollment.nextDueAt || !enrollment.currentStepId) return null;
  return { version: 1, firmId: firm.firmId, enrollmentId: enrollment.enrollmentId, stepId: enrollment.currentStepId, nextDueAt: enrollment.nextDueAt, writtenAt };
}

/** Put every missing pointer, absent-fenced, in batches; a batch a concurrent writer beat is left to it. Counts only. */
export async function backfillDuePointers(store: DynamoStore, firms: readonly FirmCard[]): Promise<{ written: number; present: number }> {
  const existing = new Set((await store.list<unknown>(DUE_PREFIX)).map(row => row.key));
  const sequences = await listSequenceRecords(store);
  const now = store.now();
  const missing: DuePointer[] = []; let present = 0;
  for (const firm of firms) {
    // A firm with its own `SEQ#` record needs no backfill: the sequence module writes its pointer with the step.
    const pointer = expectedDuePointer(firm, now, sequences.get(firm.firmId));
    if (!pointer) continue;
    if (existing.has(dueKey(pointer.nextDueAt, pointer.firmId))) present++; else missing.push(pointer);
  }
  let written = 0;
  for (let index = 0; index < missing.length; index += POINTER_BATCH) {
    const batch = missing.slice(index, index + POINTER_BATCH);
    try { await store.transact(batch.map(pointer => store.put(dueKey(pointer.nextDueAt, pointer.firmId), pointer, null))); written += batch.length; }
    catch { /* Another tick wrote some of these first; the next backfill sees them as present. */ }
  }
  return { written, present };
}

/**
 * Every pointer due at or before `until`, ascending, verified against where the firm stands now: on that enrollment,
 * on that step, due at that instant — read from the `SEQ#` record first and the carried enrollment second. Anything
 * else is stale and skipped.
 */
export async function readDuePointers(store: DynamoStore, firms: readonly FirmCard[], until: string): Promise<DuePointer[]> {
  const byFirm = new Map(firms.map(firm => [firm.firmId, firm]));
  const sequences = await listSequenceRecords(store);
  const result = await store.options.dynamo.send(new QueryCommand({ TableName: store.options.tableName, ConsistentRead: true,
    KeyConditionExpression: '#pk = :pk AND #sk BETWEEN :from AND :to', ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk' },
    ExpressionAttributeValues: { ':pk': store.key('').pk, ':from': { S: DUE_PREFIX }, ':to': { S: dueRangeEnd(until) } }, ScanIndexForward: true }));
  const pointers: DuePointer[] = [];
  for (const item of result.Items ?? []) {
    if (typeof item.data?.S !== 'string') continue;
    let raw: unknown;
    try { raw = JSON.parse(item.data.S); } catch { continue; }
    const parsed = duePointerSchema.safeParse(raw);
    if (!parsed.success || parsed.data.nextDueAt > until) continue;
    const pointer = parsed.data;
    const firm = byFirm.get(pointer.firmId);
    const live = firm ? expectedDuePointer(firm, pointer.writtenAt, sequences.get(pointer.firmId)) : null;
    if (!live || live.enrollmentId !== pointer.enrollmentId || live.stepId !== pointer.stepId || live.nextDueAt !== pointer.nextDueAt) continue;
    pointers.push(pointer);
  }
  return pointers.sort((a, b) => a.nextDueAt < b.nextDueAt ? -1 : a.nextDueAt > b.nextDueAt ? 1 : a.firmId < b.firmId ? -1 : 1);
}

/** Every firm any earlier day record named, in any lane. */
export async function listedFirmIds(store: DynamoStore): Promise<Set<string>> {
  const listed = new Set<string>();
  for (const row of await store.list<unknown>(DAY_PREFIX)) {
    const parsed = dayRecordSchema.safeParse(row.stored.data);
    if (!parsed.success) continue;
    for (const lane of TODAY_LANES) for (const entry of parsed.data.lanes[lane]) listed.add(entry.firmId);
  }
  return listed;
}

const threadLightSchema = z.object({ thread: z.object({ accountId: z.string(), providerThreadId: z.string() }), revision: z.number(), signals: z.array(z.object({ kind: z.string() })) });
const draftLightSchema = z.object({ accountId: z.string(), threadId: z.string(), threadRevision: z.number() });
/** Firms with a reply signal at the thread's current revision and no reply draft saved at that revision. */
export async function unresolvedReplyFirms(store: DynamoStore): Promise<Set<string>> {
  const [threads, drafts] = await Promise.all([store.list<unknown>('MAIL_THREAD#'), store.list<unknown>('MAIL_DRAFT#')]);
  const drafted = new Set<string>();
  for (const row of drafts) { const parsed = draftLightSchema.safeParse(row.stored.data); if (parsed.success) drafted.add(`${parsed.data.accountId}|${parsed.data.threadId}|${parsed.data.threadRevision}`); }
  const firms = new Set<string>();
  for (const row of threads) {
    const parsed = threadLightSchema.safeParse(row.stored.data);
    if (!parsed.success || !parsed.data.signals.some(signal => REPLY_SIGNALS.has(signal.kind))) continue;
    if (drafted.has(`${parsed.data.thread.accountId}|${parsed.data.thread.providerThreadId}|${parsed.data.revision}`)) continue;
    firms.add(parsed.data.thread.accountId);
  }
  return firms;
}

/**
 * Whether a firm is past its first call, read new-first exactly as `expectedDuePointer` reads the due instant: the
 * `SEQ#` record slice S2 owns answers when there is one, and the old enrollment pair answers otherwise. Without the
 * new-first read a firm the outcome form advanced still looks like it stands on step 0 — the S2 path never edits the
 * old `CAMPAIGN_ENROLLMENT#` record — so it fell out of the due lane, and out of the new lane as `already_listed`,
 * and appeared in no lane at all from the day after its first call.
 */
function midSequence(firm: FirmCard, sequence: SequenceRecord | undefined): boolean {
  // Anything said to the firm puts it past its first call: a logged outcome, a send, an old-key call, or a sequence
  // that is no longer running. Standing on step 0 is not enough on its own, because `interested` and `gatekeeper`
  // try the same step again on a later day.
  if (sequence) return !isFirstCallOnSequence(sequence, firm);
  const enrollment = firm.enrollment;
  if (!enrollment) return false;
  if (enrollment.state !== 'active') return true;
  return (enrollment.currentStepIndex ?? 0) > 0;
}

/** The date on the firm's own clock, which is what a promised callback's date is measured against. Eastern for an unknown zone. */
const localDateOf = (firm: FirmCard, now: string): string => localParts(now, firm.timeZone ?? EASTERN).date;

export type DayBuildInput = { firms: readonly FirmCard[]; postures: ReadonlyMap<string, StatePostureRecord>; now: string; date: string;
  listedBefore: ReadonlySet<string>; duePointers: readonly DuePointer[]; replyFirms: ReadonlySet<string>;
  /** The `SEQ#` record of each firm that has one; the due lane and the new lane both read it before the old enrollment. */
  sequences: ReadonlyMap<string, SequenceRecord>;
  /** The callback David promised and has not made, by firm, as `pendingCallbacksByFirm` reads it. */
  callbacks: ReadonlyMap<string, { dueOn: string }> };
/** Pure: the day record from what was read. Every firm left out of the new lane is counted under the first condition it failed. */
export function buildDayRecord(input: DayBuildInput): DayRecord {
  const byFirm = new Map(input.firms.map(firm => [firm.firmId, firm]));
  const excluded: Partial<Record<NewLaneExclusion, number>> = {};
  const exclude = (reason: NewLaneExclusion) => { excluded[reason] = (excluded[reason] ?? 0) + 1; };
  const placed = new Set<string>();
  const replies: LaneEntry[] = [];
  for (const firmId of [...input.replyFirms].sort()) {
    const firm = byFirm.get(firmId);
    if (!firm || firm.suppressed) continue;
    replies.push({ firmId, reason: LANE_REASONS.replies }); placed.add(firmId);
  }
  // The callbacks David promised, on or before today on the firm's own clock. They lead the due lane, because a
  // promised date overrides the cadence's timing entirely. The card carries its own dial verdict, so a firm whose
  // state clearance lapsed is shown held rather than quietly dropped: his promise is not the build's to forget.
  const callbacks: LaneEntry[] = [];
  for (const firmId of [...input.callbacks.keys()].sort()) {
    const firm = byFirm.get(firmId);
    if (!firm || placed.has(firmId) || firm.suppressed) continue;
    if (input.callbacks.get(firmId)!.dueOn > localDateOf(firm, input.now)) continue;
    callbacks.push({ firmId, reason: LANE_REASONS.callbacks }); placed.add(firmId);
  }
  const due: LaneEntry[] = [];
  for (const pointer of input.duePointers) {
    const firm = byFirm.get(pointer.firmId);
    if (!firm || placed.has(firm.firmId) || firm.suppressed || !firm.phone) continue;
    // Which step the firm stands on comes from the `SEQ#` record first and the carried enrollment second, the same
    // way the pointer itself was verified; the due lane is for call steps, and an email step is the scheduler's.
    if (currentStepOf(input.sequences.get(firm.firmId), firm)?.channel !== 'call' || !midSequence(firm, input.sequences.get(firm.firmId))) continue;
    if (!firm.state || !firm.timeZone || !stateClearance(input.postures, firm.state, input.now).cleared) continue;
    due.push({ firmId: firm.firmId, reason: LANE_REASONS.due }); placed.add(firm.firmId);
  }
  const pool: FirmCard[] = [];
  for (const firm of input.firms) {
    if (placed.has(firm.firmId)) continue;
    if (firm.suppressed) { exclude('suppressed'); continue; }
    if (!firm.state) { exclude('state_unknown'); continue; }
    if (!firm.timeZone) { exclude('zone_unknown'); continue; }
    const clearance = stateClearance(input.postures, firm.state, input.now);
    if (clearance.code !== null) { exclude(clearance.code); continue; }
    if (!firm.phone) { exclude('no_phone'); continue; }
    if (input.listedBefore.has(firm.firmId)) { exclude('already_listed'); continue; }
    if (firm.calls > 0) { exclude('called_before'); continue; }
    if (midSequence(firm, input.sequences.get(firm.firmId))) { exclude('in_sequence'); continue; }
    pool.push(firm);
  }
  pool.sort((a, b) => a.researchedAt < b.researchedAt ? 1 : a.researchedAt > b.researchedAt ? -1 : b.evidenceScore - a.evidenceScore
    || (a.name < b.name ? -1 : a.name > b.name ? 1 : a.firmId < b.firmId ? -1 : a.firmId > b.firmId ? 1 : 0));
  const fresh = pool.slice(0, NEW_FIRMS_PER_DAY).map(firm => ({ firmId: firm.firmId, reason: LANE_REASONS.new }));
  for (let index = NEW_FIRMS_PER_DAY; index < pool.length; index++) exclude('over_cap');
  return dayRecordSchema.parse({ version: 1, date: input.date, timeZone: EASTERN, builtAt: input.now, lanes: { replies, callbacks, due, new: fresh }, poolSize: pool.length, excluded });
}

export const laneCounts = (record: DayRecord): LaneCounts => laneCountsSchema.parse({ replies: record.lanes.replies.length, callbacks: record.lanes.callbacks.length, due: record.lanes.due.length, new: record.lanes.new.length });
const totalCards = (counts: LaneCounts): number => counts.replies + counts.callbacks + counts.due + counts.new;

export type DayBuildOutcome = { outcome: 'not_due' | 'already_built' } | { outcome: 'built'; record: DayRecord } | { outcome: 'failed'; errorClass: string };
/**
 * The tick's one call. At or after 05:00 Eastern with no record for the Eastern date: read, build, write once, record the
 * `list` attempt, log LIST_BUILT. Before 05:00 or once built: nothing, silently. A failure is a failed `list` attempt
 * naming the error class and nothing else; nothing here ever throws into the tick.
 */
export async function runScheduledDayBuild(store: DynamoStore, options: { firms?: FirmSource; log?: (line: string) => void } = {}): Promise<DayBuildOutcome> {
  const started = Date.now();
  const now = store.now();
  const parts = localParts(now, EASTERN);
  try {
    if (parts.minuteOfDay < LIST_BUILD_START_MINUTE) return { outcome: 'not_due' };
    if (await store.get<unknown>(dayKey(parts.date))) return { outcome: 'already_built' };
    const firms = await (options.firms ?? createAccountFirmSource(store)).listFirms();
    const [postures, listedBefore, replyFirms, callbacks] = await Promise.all([readPostures(store), listedFirmIds(store),
      unresolvedReplyFirms(store), pendingCallbacksByFirm(store)]);
    await backfillDuePointers(store, firms);
    const duePointers = await readDuePointers(store, firms, endOfLocalDay(now, EASTERN));
    const sequences = await listSequenceRecords(store);
    const record = buildDayRecord({ firms, postures: posturesByState(postures), now, date: parts.date, listedBefore, duePointers, replyFirms, sequences, callbacks });
    try { await store.transact([store.put(dayKey(parts.date), record, null)]); }
    catch (error) {
      // Another tick built this morning between our read and our write: theirs stands.
      if (await store.get<unknown>(dayKey(parts.date))) return { outcome: 'already_built' };
      throw error;
    }
    const counts = laneCounts(record); const count = totalCards(counts);
    await recordAttempt(store, { kind: 'list', outcome: 'ok', reason: null, detail: { code: 'list_built', count, lanes: counts }, durationMs: Date.now() - started, ref: `day:${parts.date}` });
    // The one log line of the list build, counts only: the Terraform metric filter reads `event` and `count`.
    (options.log ?? (line => console.log(line)))(JSON.stringify({ event: LIST_BUILT_EVENT, version: 1, at: now, date: parts.date, count, lanes: counts, poolSize: record.poolSize }));
    return { outcome: 'built', record };
  } catch (error) {
    const errorClass = attemptCode(error instanceof Error ? error.constructor?.name ?? error.name : 'unknown');
    await recordAttempt(store, { kind: 'list', outcome: 'failed', reason: errorClass, detail: { code: errorClass }, durationMs: Date.now() - started, ref: `day:${parts.date}` });
    return { outcome: 'failed', errorClass };
  }
}
