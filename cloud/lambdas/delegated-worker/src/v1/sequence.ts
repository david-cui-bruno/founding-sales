import type { TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { z } from 'zod';
import { accountInstantSchema } from '../../../../../src/shared/contracts/accountContract';
import { campaignStepSchema, type CampaignVersion } from '../../../../../src/shared/contracts/campaignContract';
import { advanceTerritorySequence, decideTerritoryReentry, deriveTerritoryCampaignVersion, selectTerritoryReplacementRoute,
  territoryEnrollmentId, territoryEntriesSchema, territoryFirstStepId, territoryHeldSteps,
  type TerritoryCallPolicy, type TerritoryEntries, type TerritorySequenceAdvance } from '../../../../../src/shared/contracts/territoryCallPolicyContract';
import { attemptReasonSchema, type V1CallOutcome, type V1FirmSequence } from '../../../../../src/shared/contracts/v1Contract';
import { keyPart, type DynamoStore } from '../dynamoStore';
import { territoryRetiredRouteSchema, territoryRetiredRouteKey } from '../workerCampaignRepository';
import { dueKey, duePointerSchema, type DuePointer } from './dayBuild';
import type { FirmCard } from './firms';

/**
 * The firm's place in the standing sequence (FSS target design section 2, `SEQ#<firmId>` and `DUE#<nextDueAt>#<firmId>`;
 * slice S2). One module owns both keys and writes them in one transaction, so a step and its due pointer can never
 * disagree. The rules themselves are carried, not rewritten: `advanceTerritorySequence` decides the next step and its
 * timing, `decideTerritoryReentry` decides whether a rested firm may run the sequence a second time, and
 * `selectTerritoryReplacementRoute` names the phone a retired route is replaced by. Nothing here dials, sends or books.
 *
 * Coexistence with the old records (S2 only). The old `CAMPAIGN_ENROLLMENT#` pair stays the source of truth for the
 * firms already enrolled: this module reads the `SEQ#` record first and falls back to that enrollment second, and
 * writes the new `SEQ#`/`DUE#` beside the old records without editing them. The old app is still David's morning tool
 * until S3 and it syncs from the worker's event log, so an enrollment written from here would be a silent change under
 * it. S3 and S6 retire the old records; from then the fallback is dead code and the `SEQ#` record stands alone.
 *
 * A `DUE#` pointer is retired by overwriting it with a short-lived `retired` record rather than deleted: the store's
 * transaction vocabulary is Put and ConditionCheck (the worker's IAM policy grants no `dynamodb:DeleteItem`), and the
 * range read the scheduler and the list build perform refuses a record the pointer schema does not accept. The TTL the
 * table already honours removes the row.
 */

export const SEQ_PREFIX = 'SEQ#';
export const sequenceKey = (firmId: string): string => `${SEQ_PREFIX}${keyPart(firmId)}`;
/** A retired `DUE#` row lives this long before the table's TTL removes it. */
export const RETIRED_DUE_TTL_SECONDS = 3 * 24 * 3600;

const instant = accountInstantSchema;
const stepId = z.string().min(1).max(200);
/**
 * The steps of the firm's derived campaign version, frozen when the firm entered the sequence. The version's own
 * invariants (a day-zero initial call, one id per step, the cap arithmetic) were checked where the version was
 * derived; here the steps are a record of what was frozen, so the array carries no minimum. Empty means no version
 * has been read for this firm yet — a mail job seeded the record off the old enrollment pair — and the first logged
 * outcome re-derives the steps from the standing policy.
 */
const sequenceStepSchema = z.array(campaignStepSchema).max(100);
export const sequenceTemplateIdSchema = z.enum(['T1', 'T2', 'T3', 'T4', 'T5']);
/** One step the cadence walked past or the fence refused: the closed code, the template frozen at entry, and when. */
export const sequenceHeldStepSchema = z.strictObject({ stepId, code: attemptReasonSchema,
  templateId: sequenceTemplateIdSchema.optional(), at: instant.optional() });
export type SequenceHeldStep = z.infer<typeof sequenceHeldStepSchema>;
/**
 * One step that went out. The send's own identity travels with it, so the durable audit on the sequence and the
 * `SEND#` fence name the same send: a step in `sentSteps` is a step the fence accepted, never one it merely tried.
 */
export const sequenceSentStepSchema = z.strictObject({ stepId, sentAt: instant,
  templateId: sequenceTemplateIdSchema.optional(), jobId: z.string().min(1).max(200).optional() });
export type SequenceSentStep = z.infer<typeof sequenceSentStepSchema>;

/**
 * `SEQ#<firmId>`. Under 2 KB: the frozen steps, where the firm stands, the phone the sequence dials, the email steps
 * the cadence walked past and the steps already sent. `lastAdvance` is the carried function's own reason word, so
 * Diagnostics and the Firm view say why the firm sits where it does without re-deriving anything.
 */
export const sequenceRecordSchema = z.strictObject({
  version: z.literal(1),
  firmId: z.string().min(1).max(200),
  /** The derived campaign version's id and its steps, frozen at entry; a CAS-overwritten policy can never re-derive them. */
  versionId: z.string().min(1).max(200),
  /** The enrollment identity the `DUE#` pointer carries, derived from the policy and the firm exactly as the old records derive it. */
  enrollmentId: z.string().min(1).max(200),
  steps: sequenceStepSchema,
  startedAt: instant,
  currentStepId: stepId.nullable(),
  nextDueAt: instant.nullable(),
  restingUntil: instant.nullable(),
  state: z.enum(['active', 'paused', 'stopped']),
  /**
   * Why the sequence is paused or stopped, as a closed code David reads on Today (design section 5). Null while it
   * is running. `replied` is the mail poller waiting for his decision; `opt_out` and `reply_stop` are permanent.
   */
  holdCode: attemptReasonSchema.nullable(),
  entries: territoryEntriesSchema,
  routeId: z.string().min(1).max(200).nullable(),
  heldSteps: z.array(sequenceHeldStepSchema).max(40),
  sentSteps: z.array(sequenceSentStepSchema).max(40),
  lastAdvance: attemptReasonSchema.nullable(),
  updatedAt: instant,
});
export type SequenceRecord = z.infer<typeof sequenceRecordSchema>;

/** A retired `DUE#` row. Deliberately not `duePointerSchema`: the range read skips a row the pointer schema refuses. */
export const retiredDuePointerSchema = z.strictObject({ version: z.literal(1), retired: z.literal(true), firmId: z.string().min(1).max(200), retiredAt: instant });

/**
 * How each of the ten outcomes reaches the carried `advanceTerritorySequence`, which knows five words and continues on
 * anything else. `callback` and `wrong_number` are decided here instead, because a promised callback overrides the
 * cadence's timing entirely and a wrong number is first a retired route and only then a sequence decision.
 */
export const CALL_OUTCOME_ADVANCE: Readonly<Record<V1CallOutcome, string>> = Object.freeze({
  answered_interested: 'interested',
  answered_not_interested: 'not_interested',
  // David was asked to send something: an engaged call, followed up on the interested cadence until S3 can email.
  requested_info: 'interested',
  gatekeeper: 'gatekeeper',
  voicemail: 'voicemail',
  no_answer: 'no_answer',
  busy: 'busy',
  wrong_number: 'wrong_number',
  callback: 'callback',
  opt_out: 'opt_out',
});

/**
 * The word the record carries when the first logged outcome moved the anchor onto the call (slice S2b). The
 * outcome's own word is on the `CALL#` record, and a rest or a stop keeps its reason in `holdCode`, so nothing
 * is lost by saying here the thing only this transition can say.
 */
export const REBASED_TO_FIRST_CALL = 'rebased_to_first_call';

/**
 * Whether this call is the first thing ever said to the firm, so its cadence may be re-based onto the call.
 * Nothing has been logged against the sequence, nothing has gone out, and the old app never dialled it either.
 * A stopped sequence is never re-based: it is not advanced at all. Pure.
 */
export function isFirstCallOnSequence(record: SequenceRecord, firm: Pick<FirmCard, 'calls'>): boolean {
  return record.state !== 'stopped' && record.lastAdvance === null && record.sentSteps.length === 0 && firm.calls === 0;
}

/** The start-anchored due rule the policy fixes: a step's day offset counted from the instant the firm entered. Pure. */
export function startAnchoredDueAt(startedAt: string, delayHours: number): string {
  const parsed = Date.parse(instant.parse(startedAt));
  if (!Number.isFinite(parsed)) throw new Error('sequence_instant');
  return new Date(parsed + delayHours * 3600000).toISOString();
}

/** Every `SEQ#` record, by firm id. One prefix query; a row the schema refuses is skipped, never coerced. */
export async function listSequenceRecords(store: DynamoStore): Promise<Map<string, SequenceRecord>> {
  const records = new Map<string, SequenceRecord>();
  for (const row of await store.list<unknown>(SEQ_PREFIX)) {
    const parsed = sequenceRecordSchema.safeParse(row.stored.data);
    if (parsed.success) records.set(parsed.data.firmId, parsed.data);
  }
  return records;
}

export async function readSequenceRecord(store: DynamoStore, firmId: string): Promise<{ record: SequenceRecord; rev: number } | null> {
  const row = await store.get<unknown>(sequenceKey(firmId));
  if (!row) return null;
  const parsed = sequenceRecordSchema.safeParse(row.data);
  return parsed.success ? { record: parsed.data, rev: row.rev } : null;
}

/** The firm's sequence as the Firm view reports it: the `SEQ#` record first, the carried enrollment second, null for neither. */
export function sequenceStateOf(record: SequenceRecord | null, firm: Pick<FirmCard, 'enrollment'>): V1FirmSequence | null {
  if (record) {
    const stepIndex = record.currentStepId === null ? null : record.steps.findIndex(step => step.id === record.currentStepId);
    return { source: 'sequence', state: record.state, startedAt: record.startedAt, currentStepId: record.currentStepId,
      stepIndex: stepIndex === null || stepIndex < 0 ? null : stepIndex, stepCount: record.steps.length, nextDueAt: record.nextDueAt,
      restingUntil: record.restingUntil, entries: record.entries, heldStepIds: record.heldSteps.map(step => step.stepId), lastAdvance: record.lastAdvance };
  }
  const enrollment = firm.enrollment;
  if (!enrollment) return null;
  const state = enrollmentSequenceState(enrollment.state);
  return { source: 'enrollment', state, startedAt: enrollment.startedAt, currentStepId: enrollment.currentStepId,
    stepIndex: enrollment.currentStepIndex, stepCount: enrollment.stepCount, nextDueAt: enrollment.nextDueAt,
    restingUntil: enrollment.restingUntil, entries: 1, heldStepIds: [], lastAdvance: null };
}

/**
 * The six states an old enrollment can carry, as the three the sequence record knows: a completed run is done, a
 * held or conversational one waits, and nothing is ever guessed into `active`. Pure.
 */
export function enrollmentSequenceState(state: string): 'active' | 'paused' | 'stopped' {
  if (state === 'active') return 'active';
  if (state === 'stopped' || state === 'completed') return 'stopped';
  return 'paused';
}

/** The derived version of the firm under the standing policy. Pure; deterministic in (policy identity, firm id). */
export function firmCampaignVersion(policy: TerritoryCallPolicy, firmId: string): CampaignVersion {
  return deriveTerritoryCampaignVersion(policy, firmId);
}

/**
 * The record a firm's first logged call creates: the cadence is anchored on that call, so step 0 is the call just
 * made and every later step counts its day offset from it. The email steps of the derived version are recorded as
 * held with the policy's own template ids, exactly as the enrollment path records them; nothing is drafted or sent.
 */
export function startSequenceRecord(input: { policy: TerritoryCallPolicy; firmId: string; startedAt: string; routeId: string | null; entries?: TerritoryEntries }): SequenceRecord {
  const version = firmCampaignVersion(input.policy, input.firmId);
  const first = version.steps[0];
  if (!first) throw new Error('sequence_version_empty');
  return sequenceRecordSchema.parse({
    version: 1, firmId: input.firmId, versionId: version.id, enrollmentId: territoryEnrollmentId(input.policy, input.firmId),
    steps: version.steps, startedAt: input.startedAt, currentStepId: first.id,
    nextDueAt: startAnchoredDueAt(input.startedAt, first.delayHours), restingUntil: null, state: 'active',
    holdCode: null, entries: input.entries ?? 1, routeId: input.routeId,
    heldSteps: territoryHeldSteps(version, input.policy.sequence).map(step => ({ stepId: step.stepId, code: step.reason, ...(step.templateId ? { templateId: step.templateId } : {}) })),
    sentSteps: [], lastAdvance: null, updatedAt: input.startedAt,
  });
}

/**
 * The `SEQ#` record a firm already enrolled under the old keys starts from, so its first S2 outcome advances the
 * sequence it is actually on instead of restarting it. The steps come from the derived version of the standing
 * policy, which is what the old enrollment runs; a firm whose stored step is not in that version keeps its own
 * position as an unknown step, and the advance then refuses rather than guessing.
 */
export function sequenceRecordFromEnrollment(input: { policy: TerritoryCallPolicy; firm: FirmCard; now: string }): SequenceRecord | null {
  const enrollment = input.firm.enrollment;
  if (!enrollment) return null;
  const version = firmCampaignVersion(input.policy, input.firm.firmId);
  const state = enrollmentSequenceState(enrollment.state);
  return sequenceRecordSchema.parse({
    version: 1, firmId: input.firm.firmId, versionId: version.id, enrollmentId: enrollment.enrollmentId,
    steps: version.steps, startedAt: enrollment.startedAt, currentStepId: enrollment.currentStepId,
    nextDueAt: enrollment.nextDueAt, restingUntil: enrollment.restingUntil, state, holdCode: null, entries: 1,
    routeId: input.firm.phone?.routeId ?? null,
    heldSteps: territoryHeldSteps(version, input.policy.sequence).map(step => ({ stepId: step.stepId, code: step.reason, ...(step.templateId ? { templateId: step.templateId } : {}) })),
    sentSteps: [], lastAdvance: null, updatedAt: input.now,
  });
}

export type SequenceAdvanceInput = {
  firm: FirmCard;
  policy: TerritoryCallPolicy;
  outcome: V1CallOutcome;
  observedAt: string;
  /** The route the call was dialed on; the sequence's own route when the caller names none. */
  routeId?: string | null;
  commandId: string;
};
export type SequenceAdvance = {
  items: TransactWriteItem[];
  record: SequenceRecord;
  /** A hold the advance itself produced: a wrong number with no other business phone left. */
  hold: 'no_phone' | null;
  /** The route this outcome retired, and the one the sequence moved onto. */
  retiredRouteId: string | null;
  replacementRouteId: string | null;
  /** Which record the advance started from. */
  from: 'sequence' | 'enrollment' | 'new';
};

/** The routes the firm still has, as the replacement selector reads them. */
function replacementCandidates(firm: FirmCard): { id: string; channel: string; purpose: string; verification: string; version: number }[] {
  return firm.routes.map(route => ({ id: route.id, channel: route.channel, purpose: route.purpose, verification: route.verification, version: route.version }));
}

/**
 * The phone a retired route is replaced by: the carried selector first, which takes a number the firm publishes on
 * its own page before the one its directory listing carries and never an unverified one. A firm David entered by hand
 * publishes nothing, so a number he confirmed himself is admitted second — by exactly the rule the card already uses
 * to offer a number, so the sequence can never be resting on a firm whose card still shows a phone. Pure.
 */
export function selectReplacementRoute(firm: FirmCard, retiredRouteIds: readonly string[]): { id: string } | null {
  const carried = selectTerritoryReplacementRoute({ routes: replacementCandidates(firm), retiredRouteIds });
  if (carried) return { id: carried.id };
  const retired = new Set(retiredRouteIds);
  const confirmed = firm.routes.filter(route => route.channel === 'phone' && route.purpose === 'business' && route.verification === 'confirmed' && !retired.has(route.id))
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : b.version - a.version);
  return confirmed[0] ? { id: confirmed[0].id } : null;
}

/**
 * One logged call's effect on `SEQ#` and `DUE#`, as the items of one transaction (FSS target design section 3,
 * `log_call_outcome`). The carried cadence decides the step and its timing; this function only records it, plus the
 * two things the cadence leaves to its caller: a retired route with its replacement, and a promised callback whose
 * own date leads the morning list instead of a due instant.
 *
 * A firm resting past its rest date re-enters once, exactly as `decideTerritoryReentry` allows, before the outcome
 * is applied; a firm in its final rest, or stopped, is not advanced at all.
 *
 * Day 0 is the day of the first call (slice S2b): a firm the backfill enrolled at listing time and never called
 * is re-based onto the call before the carried rule runs, so its cadence counts from what was actually said to it.
 */
export async function advanceAfterCall(store: DynamoStore, input: SequenceAdvanceInput): Promise<SequenceAdvance> {
  const now = store.now();
  const held = await readSequenceRecord(store, input.firm.firmId);
  const from: SequenceAdvance['from'] = held ? 'sequence' : input.firm.enrollment ? 'enrollment' : 'new';
  let current = held?.record
    ?? sequenceRecordFromEnrollment({ policy: input.policy, firm: input.firm, now })
    ?? startSequenceRecord({ policy: input.policy, firmId: input.firm.firmId, startedAt: input.observedAt, routeId: input.routeId ?? input.firm.phone?.routeId ?? null });
  const dialedRouteId = input.routeId ?? current.routeId ?? input.firm.phone?.routeId ?? null;

  // A rested firm David called again re-enters once, on the cadence re-based on today; a final rest never re-enters,
  // and a rest that has not elapsed stands. Either way the call is still recorded: the rest is not resumed silently.
  const reentry = decideTerritoryReentry({ firstStepId: territoryFirstStepId(current.versionId),
    enrollment: { state: current.state, restingUntil: current.restingUntil }, entries: current.entries, now: input.observedAt });
  if (reentry.kind === 'reenter') {
    current = { ...current, entries: reentry.entries, currentStepId: reentry.currentStepId, startedAt: reentry.startedAt, state: 'active', restingUntil: null, sentSteps: [] };
  }
  const restStands = reentry.kind === 'resting' || reentry.kind === 'final_rest';

  // Day 0 is the day of the first call, not the day the backfill enrolled the firm. A firm enrolled at listing
  // time and never called carries an anchor weeks old, so the day-3 call and the day-7 email of its own cadence
  // would both be due the instant David logs a first outcome. The first outcome re-bases the whole cadence onto
  // the call before the carried rule is applied, so the next call step is due at `observedAt + 72 h` and the
  // day-7 email at `observedAt + 168 h`. `nextDueAt` is deliberately left where it was: it is what names the
  // stale `DUE#` pointer the transaction below retires. A sequence that already carries a call or a send is
  // never re-based, and a re-entry after rest brings its own restart anchor, which is kept exactly as it is.
  let anchoredOnThisCall = reentry.kind === 'not_resting' && current.startedAt !== input.observedAt
    && isFirstCallOnSequence(current, input.firm);
  if (anchoredOnThisCall) current = { ...current, startedAt: input.observedAt };

  const items: TransactWriteItem[] = [];
  let retiredRouteId: string | null = null;
  let replacementRouteId: string | null = null;
  let hold: 'no_phone' | null = null;
  let next: SequenceRecord;

  if (input.outcome === 'wrong_number') {
    // The route is retired first (a route state of its own; the firm's route row is never edited or deleted), then the
    // sequence restarts on the next business phone the firm carries. With none left the carried rest stands and the
    // firm holds `no_phone`, which is what Today shows instead of an empty card.
    const retiredIds = [...input.firm.retiredRouteIds];
    if (dialedRouteId) {
      retiredRouteId = dialedRouteId;
      const retirementKey = territoryRetiredRouteKey(input.firm.firmId, dialedRouteId);
      const existing = await store.get<unknown>(retirementKey);
      const dialed = input.firm.routes.find(route => route.id === dialedRouteId);
      if (existing) items.push(store.check(retirementKey, existing.rev));
      else items.push(store.put(retirementKey, territoryRetiredRouteSchema.parse({ accountId: input.firm.firmId, routeId: dialedRouteId,
        routeVersion: dialed?.version ?? 1, retiredAt: input.observedAt, reason: 'wrong_number', commandId: input.commandId }), null));
      if (!retiredIds.includes(dialedRouteId)) retiredIds.push(dialedRouteId);
    }
    const replacement = selectReplacementRoute(input.firm, retiredIds);
    if (replacement) {
      replacementRouteId = replacement.id;
      // The restart is already anchored on the call and names its own word; there is no re-base left to report.
      anchoredOnThisCall = false;
      const restarted = startSequenceRecord({ policy: input.policy, firmId: input.firm.firmId, startedAt: input.observedAt, routeId: replacement.id, entries: current.entries });
      next = { ...restarted, versionId: current.versionId, enrollmentId: current.enrollmentId, steps: current.steps,
        currentStepId: current.steps[0]?.id ?? null, nextDueAt: current.steps[0] ? startAnchoredDueAt(input.observedAt, current.steps[0].delayHours) : null,
        holdCode: null, lastAdvance: 'wrong_number_restarted', updatedAt: now };
    } else {
      const rested = applyCarried(current, 'wrong_number', input.observedAt);
      hold = 'no_phone';
      next = { ...rested, routeId: null, holdCode: 'no_phone', lastAdvance: 'rest_wrong_number', updatedAt: now };
    }
  } else if (input.outcome === 'callback') {
    // A callback David promised overrides the cadence's timing entirely: the CALLBACK# pointer leads the callbacks
    // lane on its own day, so the firm keeps its step and carries no due instant until the callback is made.
    // The anchor still moved onto the call — the held email steps count their offsets from it — but the promised
    // callback is what David reads on the card, so it keeps the word.
    anchoredOnThisCall = false;
    next = { ...current, state: current.state === 'stopped' ? 'stopped' : 'active', nextDueAt: null, restingUntil: null,
      holdCode: current.state === 'stopped' ? current.holdCode : null, routeId: dialedRouteId, lastAdvance: 'callback_promised', updatedAt: now };
  } else if (current.state === 'stopped' || restStands) {
    // A stopped firm, and a firm still resting or in its final rest, is never advanced; the call is still recorded.
    next = { ...current, routeId: dialedRouteId, lastAdvance: current.state === 'stopped' ? current.lastAdvance : reentry.kind === 'final_rest' ? 'rest_final' : 'resting', updatedAt: now };
  } else {
    next = { ...applyCarried(current, CALL_OUTCOME_ADVANCE[input.outcome], input.observedAt), routeId: dialedRouteId, updatedAt: now };
  }

  const record = sequenceRecordSchema.parse(anchoredOnThisCall ? { ...next, lastAdvance: REBASED_TO_FIRST_CALL } : next);
  items.push(store.put(sequenceKey(record.firmId), record, held?.rev ?? null));
  items.push(...await duePointerItems(store, current, record));
  return { items, record, hold, retiredRouteId, replacementRouteId, from };
}

/** The carried cadence applied to one record: the next step, the state, the timing, and the email steps walked past. */
function applyCarried(current: SequenceRecord, outcome: string, observedAt: string): SequenceRecord {
  let advance: TerritorySequenceAdvance;
  try {
    advance = advanceTerritorySequence({ version: { steps: current.steps }, enrollment: { currentStepId: current.currentStepId, startedAt: current.startedAt },
      outcome, observedAt, entries: current.entries });
  } catch {
    // The stored step is not in the frozen version (a policy the firm was never re-enrolled under): the record stands
    // unchanged with an honest reason, never a guessed step.
    return { ...current, lastAdvance: 'step_unknown' };
  }
  const heldIds = new Set(current.heldSteps.map(step => step.stepId));
  const heldSteps = [...current.heldSteps];
  for (const id of advance.heldStepIds) if (!heldIds.has(id)) heldSteps.push({ stepId: id, code: 'mailbox_not_connected' });
  return { ...current, currentStepId: advance.currentStepId, state: advance.state, nextDueAt: advance.nextDueAt,
    restingUntil: advance.restingUntil, heldSteps, lastAdvance: advance.reason,
    holdCode: advance.state === 'active' ? null : advance.reason };
}

/**
 * The `DUE#` writes of one advance: the new pointer, and the pointer the firm stood on retired. Both in the advance's
 * own transaction, so a step and its due pointer are never apart. A pointer that did not move is left alone.
 */
export async function duePointerItems(store: DynamoStore, before: SequenceRecord, after: SequenceRecord): Promise<TransactWriteItem[]> {
  const items: TransactWriteItem[] = [];
  const oldKey = before.nextDueAt ? dueKey(before.nextDueAt, before.firmId) : null;
  const newKey = after.nextDueAt ? dueKey(after.nextDueAt, after.firmId) : null;
  if (oldKey === newKey) return items;
  if (newKey) {
    const existing = await store.get<unknown>(newKey);
    const pointer: DuePointer = duePointerSchema.parse({ version: 1, firmId: after.firmId, enrollmentId: after.enrollmentId,
      stepId: after.currentStepId ?? after.enrollmentId, nextDueAt: after.nextDueAt, writtenAt: store.now() });
    items.push(store.put(newKey, pointer, existing?.rev ?? null));
  }
  if (oldKey) {
    const existing = await store.get<unknown>(oldKey);
    if (existing) items.push(store.put(oldKey, retiredDuePointerSchema.parse({ version: 1, retired: true, firmId: before.firmId, retiredAt: store.now() }),
      existing.rev, { ttl: Math.floor(Date.parse(store.now()) / 1000) + RETIRED_DUE_TTL_SECONDS }));
  }
  return items;
}

/**
 * What the send fence, the mail poller and the scheduler ask of the sequence (the ports slice S3 wrote against, now
 * implemented here, where the record lives). Each operation is one compare-and-set on `SEQ#<firmId>`, with the
 * `DUE#` pointer written and retired in the same transaction where the step moves; none of them computes a cadence,
 * because the cadence is `advanceAfterCall` above and its rules are carried, not rewritten.
 *
 * The seed is what the caller read off the records it had: it is used only to create a record that does not exist
 * yet, never to overwrite one that does. So a firm the outcome form already put on the sequence keeps its own
 * `startedAt`, entry count and steps, whatever the mail job passes.
 */
export type SequenceSeed = { firmId: string; enrollmentId: string; startedAt: string; currentStepId: string | null; nextDueAt: string | null };
export type NextStep = { stepId: string; dueAt: string } | null;

export interface SequencePort {
  read(firmId: string): Promise<SequenceRecord | null>;
  /** Records one closed hold on one step. Never advances, never sends: the step stays where it is. */
  holdStep(input: SequenceSeed & { stepId: string; code: string; templateId?: string | null }): Promise<void>;
  /** The step went out. Appends it to `sentSteps` and moves the sequence to `next`, writing the `DUE#` pointer with it. */
  recordSent(input: SequenceSeed & { stepId: string; sentAt: string; next: NextStep; templateId?: string | null; jobId?: string }): Promise<void>;
  /** A reply arrived: the sequence waits for David's decision under the `replied` hold. */
  pauseForReply(input: SequenceSeed & { code: string }): Promise<void>;
  /** David said continue: the hold is cleared and the sequence stands where it did. Never moves a due instant. */
  resume(input: SequenceSeed): Promise<void>;
  /** The firm asked to stop, or a bounce ended the route. Permanent for `opt_out` and `reply_stop`. */
  stop(input: SequenceSeed & { code: string }): Promise<void>;
}

/** The template id a caller named, when it is one of the five the policy can carry. Pure. */
const templateOf = (value: string | null | undefined): { templateId: SequenceHeldStep['templateId'] } | Record<string, never> => {
  const parsed = sequenceTemplateIdSchema.safeParse(value);
  return parsed.success ? { templateId: parsed.data } : {};
};

/**
 * A record for a firm no logged call has put on the sequence yet, from what the caller read off the old enrollment
 * pair. It carries no frozen steps, because the caller did not read a version: the cadence is not decided from here,
 * and `advanceAfterCall` re-derives the steps from the standing policy the first time an outcome is logged.
 */
function seededRecord(seed: SequenceSeed, now: string): SequenceRecord {
  return sequenceRecordSchema.parse({
    version: 1, firmId: seed.firmId, versionId: seed.enrollmentId, enrollmentId: seed.enrollmentId, steps: [],
    startedAt: seed.startedAt, currentStepId: seed.currentStepId, nextDueAt: seed.nextDueAt, restingUntil: null,
    state: 'active', holdCode: null, entries: 1, routeId: null, heldSteps: [], sentSteps: [], lastAdvance: null, updatedAt: now,
  });
}

/** The one implementation of `SequencePort`, over the `SEQ#` record this module owns. */
export function createSequencePort(store: DynamoStore): SequencePort {
  /** One read, one change, one transaction: the record, plus the pointer writes the step's move implies. */
  const write = async (seed: SequenceSeed, change: (record: SequenceRecord, now: string) => SequenceRecord): Promise<void> => {
    const now = store.now();
    const held = await readSequenceRecord(store, seed.firmId);
    const before = held?.record ?? seededRecord(seed, now);
    const after = sequenceRecordSchema.parse({ ...change(before, now), updatedAt: now });
    const items = [store.put(sequenceKey(seed.firmId), after, held?.rev ?? null), ...await duePointerItems(store, before, after)];
    await store.transact(items);
  };
  return {
    async read(firmId) { return (await readSequenceRecord(store, firmId))?.record ?? null; },
    async holdStep(input) {
      await write(input, (record, now) => ({ ...record,
        heldSteps: [...record.heldSteps.filter(step => step.stepId !== input.stepId),
          { stepId: input.stepId, code: attemptReasonSchema.parse(input.code), ...templateOf(input.templateId), at: now }].slice(-40) }));
    },
    async recordSent(input) {
      // The step is off the held list and on the sent list. The sequence moves to `next` only when the step that went
      // out is the one it was standing on: an email step the call cadence already walked past is sent on its own due
      // instant, and sending it must never rewind the firm to a step it is already past.
      await write(input, record => {
        const sent = { ...record,
          sentSteps: [...record.sentSteps.filter(step => step.stepId !== input.stepId),
            { stepId: input.stepId, sentAt: input.sentAt, ...templateOf(input.templateId), ...(input.jobId ? { jobId: input.jobId } : {}) }].slice(-40),
          heldSteps: record.heldSteps.filter(step => step.stepId !== input.stepId) };
        const standing = record.currentStepId === null || record.currentStepId === input.stepId;
        if (!standing) return { ...sent, lastAdvance: 'sent' };
        return { ...sent, currentStepId: input.next?.stepId ?? null, nextDueAt: input.next?.dueAt ?? null,
          state: input.next ? 'active' : 'paused', holdCode: input.next ? null : 'sequence_complete',
          lastAdvance: input.next ? 'sent' : 'sequence_complete' };
      });
    },
    async pauseForReply(input) {
      await write(input, record => ({ ...record, state: 'paused', holdCode: attemptReasonSchema.parse(input.code),
        nextDueAt: null, lastAdvance: attemptReasonSchema.parse(input.code) }));
    },
    async resume(input) {
      // A stopped sequence is never resumed: suppression is permanent and a stop is the record of it.
      await write(input, record => record.state === 'stopped' ? record
        : ({ ...record, state: 'active', holdCode: null, lastAdvance: 'resumed',
          currentStepId: record.currentStepId ?? input.currentStepId, nextDueAt: record.nextDueAt ?? input.nextDueAt }));
    },
    async stop(input) {
      await write(input, record => ({ ...record, state: 'stopped', holdCode: attemptReasonSchema.parse(input.code),
        currentStepId: null, nextDueAt: null, restingUntil: null, lastAdvance: attemptReasonSchema.parse(input.code) }));
    },
  };
}

/**
 * The email steps of the firm's own frozen cadence that are due to go out now: still held, never sent, and past the
 * start-anchored instant their day offset names. The call cadence walks past an email step and records it as held —
 * that is the carried rule, unchanged — so this is how a held step becomes a send once the mailbox can send one.
 * The fence decides whether it actually goes; this only says which steps are due. Pure.
 */
export function dueEmailSteps(record: SequenceRecord, now: string): { stepId: string; dueAt: string }[] {
  if (record.state !== 'active') return [];
  const sent = new Set(record.sentSteps.map(step => step.stepId));
  const held = new Set(record.heldSteps.map(step => step.stepId));
  return record.steps.flatMap(step => {
    if (step.channel !== 'email' || sent.has(step.id) || !held.has(step.id)) return [];
    const dueAt = startAnchoredDueAt(record.startedAt, step.delayHours);
    return dueAt <= now ? [{ stepId: step.id, dueAt }] : [];
  });
}

/**
 * The step the firm stands on and its channel, read from the `SEQ#` record first and the carried enrollment second.
 * The scheduler asks this before it enqueues a send, so a firm whose sequence came from a logged call is scheduled
 * on the cadence the record froze rather than skipped for having no old enrollment. Pure over what it is given.
 */
export function currentStepOf(record: SequenceRecord | null | undefined, firm: Pick<FirmCard, 'enrollment'>):
{ stepId: string; channel: 'call' | 'email' | 'linkedin'; source: 'sequence' | 'enrollment' } | null {
  if (record && record.currentStepId !== null) {
    const step = record.steps.find(candidate => candidate.id === record.currentStepId);
    if (step) return { stepId: step.id, channel: step.channel, source: 'sequence' };
  }
  const enrollment = firm.enrollment;
  if (enrollment?.currentStepId && enrollment.currentStepChannel) {
    return { stepId: enrollment.currentStepId, channel: enrollment.currentStepChannel, source: 'enrollment' };
  }
  return null;
}
