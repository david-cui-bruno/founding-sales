import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AccountRecord } from '../../../../../src/shared/contracts/accountRecordContract';
import { deriveTerritoryCampaignVersion, territoryEnrollmentId, type TerritoryCallPolicy } from '../../../../../src/shared/contracts/territoryCallPolicyContract';
import { todayCardSchema, v1CommandReceiptSchema, V1_CALL_OUTCOMES, type TodayCard, type V1CallOutcome } from '../../../../../src/shared/contracts/v1Contract';
import { fingerprint, type DynamoStore } from '../../src/dynamoStore';
import { callbackKey, callKey, callRecordSchema, callbackRecordSchema } from '../../src/v1/calls';
import { dueKey } from '../../src/v1/dayBuild';
import { CALL_OUTCOME_ADVANCE, sequenceKey, sequenceRecordSchema } from '../../src/v1/sequence';
import { suppressionFirmKey, suppressionHandleKey } from '../../src/v1/suppression';
import { accountKey } from '../../src/workerAccountRepository';
import { territoryRetiredRouteKey } from '../../src/workerCampaignRepository';
import { firmRecord, listedRouteId, putFirm, putTerritoryPolicy, riFirm, setPosture } from './firmFixtures';
import { v1Fixture } from './v1Fixture';

/**
 * `log_call_outcome` on the real handler and the in-memory Dynamo harness (FSS target design section 3; slice S2).
 * One dialed call, logged once: the `CALL#` record, the callback, the suppression set, the retired route and the
 * `SEQ#`/`DUE#` advance, all in the one transaction the router commits with the receipt. Nothing here dials, sends
 * or books; the numbers are fictional and stay outside the 555-0100 to 555-0199 block the launcher refuses.
 *
 * The cadence under test is David's standing policy (D13 v1): day 0 call, day 3 call, day 7 email T4, day 12 call,
 * day 21 email T5. Friday 18 September 2026 at 14:00 UTC is 10:00 in Providence, inside the code floor.
 */
const FRIDAY = '2026-09-18T14:00:00.000Z';
const RI_PHONE = '+14015550201';

type Harness = Awaited<ReturnType<typeof harness>>;
async function harness(now = FRIDAY, firm: Partial<Parameters<typeof riFirm>[1]> = {}) {
  const f = v1Fixture(now);
  const policy = await putTerritoryPolicy(f.store, '2026-09-01T12:00:00.000Z');
  const device = await f.pairDevice();
  await setPosture(f, device.bearer, 'RI', 'calling');
  await putFirm(f.store, riFirm(1, firm));
  return { f, policy, device, firmId: 'account-ri-1', routeId: listedRouteId('account-ri-1', RI_PHONE) };
}

/** One outcome through the real route. Returns the receipt the worker answered. */
async function log(h: Harness, body: Record<string, unknown>, commandId = randomUUID()) {
  const response = await h.f.request('POST', '/v1/commands', { authorization: h.device.bearer,
    body: { commandId, kind: 'log_call_outcome', firmId: h.firmId, observedAt: FRIDAY, ...body } });
  return { response, receipt: v1CommandReceiptSchema.parse(h.f.json(response)), commandId };
}

const seq = (h: Harness) => sequenceRecordSchema.parse(h.f.db.inspect(sequenceKey(h.firmId)));
const stepIds = (policy: TerritoryCallPolicy, firmId: string) => deriveTerritoryCampaignVersion(policy, firmId).steps.map(step => step.id);
const dueKeys = (h: Harness) => h.f.db.dump().map(item => item.sk!.S!).filter(key => key.startsWith('DUE#')).sort();
const cardOf = (receipt: { slice?: unknown }): TodayCard => {
  const slice = receipt.slice as { kind: string; card: unknown } | null | undefined;
  if (!slice || slice.kind !== 'card') throw new Error('no card slice');
  return todayCardSchema.parse(slice.card);
};

describe('log_call_outcome', () => {
  it('records the call once with the worker\'s own dial verdict, and refuses an unknown firm, a callback with no date and an unauthenticated device', async () => {
    const h = await harness();
    expect((await h.f.request('POST', '/v1/commands', { body: { commandId: randomUUID(), kind: 'log_call_outcome', firmId: h.firmId, outcome: 'voicemail', observedAt: FRIDAY } })).statusCode).toBe(401);
    expect((await log(h, { firmId: 'account-nobody', outcome: 'voicemail' })).receipt).toMatchObject({ outcome: 'refused', reason: 'firm_unknown' });
    expect((await log(h, { outcome: 'callback' })).receipt).toMatchObject({ outcome: 'refused', reason: 'callback_date_missing' });
    const logged = await log(h, { outcome: 'voicemail', note: 'Left a message with the front desk.' });
    expect(logged.receipt).toMatchObject({ outcome: 'applied', reason: null });
    const record = callRecordSchema.parse(h.f.db.inspect(callKey(h.firmId, FRIDAY)));
    expect(record).toMatchObject({ version: 1, firmId: h.firmId, outcome: 'voicemail', note: 'Left a message with the front desk.',
      callbackOn: null, neverCallReason: null, routeId: h.routeId, observedAt: FRIDAY, recordedAt: FRIDAY,
      dial: { dialAllowed: true, holdReason: null, holdCode: null, localTime: '10:00', openNow: true }, deviceId: h.device.deviceId, commandId: logged.commandId });
    // Exactly one CALL# row for the firm, and the card the command returned carries the outcome and the note.
    expect(h.f.db.dump().map(item => item.sk!.S!).filter(key => key.startsWith('CALL#'))).toHaveLength(1);
    expect(cardOf(logged.receipt)).toMatchObject({ firmId: h.firmId, lastOutcome: { outcome: 'voicemail', at: FRIDAY, note: 'Left a message with the front desk.' }, pendingCallback: null });
  });

  it('records a call logged from a held card as held: the dial verdict of the instant, not a permission', async () => {
    // 02:00 Eastern on the Friday: outside the code floor on the firm's own clock.
    const h = await harness('2026-09-18T06:00:00.000Z');
    await log(h, { outcome: 'no_answer', observedAt: '2026-09-18T06:00:00.000Z' });
    expect(callRecordSchema.parse(h.f.db.inspect(callKey(h.firmId, '2026-09-18T06:00:00.000Z'))).dial)
      .toEqual({ dialAllowed: false, holdReason: 'outside_hours', holdCode: 'outside_hours', localTime: '02:00', openNow: false });
  });

  it('advances the sequence per the carried cadence: the three continuing outcomes step on, interested and requested_info wait five business days, a gatekeeper two, not interested rests', async () => {
    const start = ['voicemail', 'no_answer', 'busy'] as const;
    for (const outcome of start) {
      const h = await harness();
      const steps = stepIds(h.policy, h.firmId);
      await log(h, { outcome });
      // The first call anchors the cadence: day 3 is the next call step, start-anchored.
      expect(seq(h)).toMatchObject({ version: 1, firmId: h.firmId, startedAt: FRIDAY, currentStepId: steps[1],
        nextDueAt: '2026-09-21T14:00:00.000Z', restingUntil: null, state: 'active', entries: 1, routeId: h.routeId, lastAdvance: 'continue' });
      expect(dueKeys(h)).toEqual([dueKey('2026-09-21T14:00:00.000Z', h.firmId)]);
    }
    for (const [outcome, dueAt, reason] of [['answered_interested', '2026-09-25T14:00:00.000Z', 'interested'],
      ['requested_info', '2026-09-25T14:00:00.000Z', 'interested'], ['gatekeeper', '2026-09-22T14:00:00.000Z', 'gatekeeper']] as const) {
      const h = await harness();
      const steps = stepIds(h.policy, h.firmId);
      await log(h, { outcome });
      // The same step is tried again, on business days counted from the call.
      expect(seq(h)).toMatchObject({ currentStepId: steps[0], nextDueAt: dueAt, state: 'active', restingUntil: null, lastAdvance: reason });
      expect(dueKeys(h)).toEqual([dueKey(dueAt, h.firmId)]);
      expect(cardOf((await log(h, { outcome: 'no_answer', observedAt: '2026-09-18T15:00:00.000Z' })).receipt).nextStep).toMatchObject({ kind: 'call', stepCount: 5 });
    }
    const rest = await harness();
    await log(rest, { outcome: 'answered_not_interested', note: 'Uses a national vendor.' });
    expect(seq(rest)).toMatchObject({ state: 'paused', nextDueAt: null, restingUntil: '2027-03-17T14:00:00.000Z', lastAdvance: 'rest_not_interested' });
    expect(dueKeys(rest)).toEqual([]);
  });

  it('walks past the email steps as held, never drafted, and retires the due pointer it moved off', async () => {
    const h = await harness();
    const steps = stepIds(h.policy, h.firmId);
    await log(h, { outcome: 'voicemail' });
    // Day 3: the next call step is day 12, and the day-7 email step is held on the way.
    await log(h, { outcome: 'no_answer', observedAt: '2026-09-21T14:00:00.000Z' });
    const record = seq(h);
    expect(record).toMatchObject({ currentStepId: steps[3], nextDueAt: '2026-09-30T14:00:00.000Z', state: 'active', lastAdvance: 'continue' });
    // Both email steps are held from the moment the firm entered, with the templates the policy named, frozen there.
    expect(record.heldSteps).toEqual([{ stepId: steps[2], code: 'mailbox_not_connected', templateId: 'T4' },
      { stepId: steps[4], code: 'mailbox_not_connected', templateId: 'T5' }]);
    expect(record.sentSteps).toEqual([]);
    // The pointer the firm stood on is retired, not left to be read again; the live pointer is the new one.
    expect(dueKeys(h)).toEqual([dueKey('2026-09-21T14:00:00.000Z', h.firmId), dueKey('2026-09-30T14:00:00.000Z', h.firmId)].sort());
    expect(h.f.db.inspect(dueKey('2026-09-21T14:00:00.000Z', h.firmId))).toMatchObject({ retired: true, firmId: h.firmId });
    expect(h.f.db.inspect(dueKey('2026-09-30T14:00:00.000Z', h.firmId))).toMatchObject({ firmId: h.firmId, enrollmentId: territoryEnrollmentId(h.policy, h.firmId), stepId: steps[3] });
    // Running the cadence out rests the firm and may re-enter it once.
    await log(h, { outcome: 'no_answer', observedAt: '2026-09-30T14:00:00.000Z' });
    expect(seq(h)).toMatchObject({ currentStepId: null, state: 'paused', nextDueAt: null, restingUntil: '2026-12-29T14:00:00.000Z', lastAdvance: 'rest_sequence_complete' });
  });

  it('re-enters a rested firm once, on a cadence re-based on the day it was called again, and never a second time', async () => {
    const h = await harness();
    const steps = stepIds(h.policy, h.firmId);
    await log(h, { outcome: 'answered_not_interested' });
    expect(seq(h)).toMatchObject({ state: 'paused', entries: 1, restingUntil: '2027-03-17T14:00:00.000Z' });
    // Called again after the rest: the second run starts on the day of the call.
    const again = '2027-03-18T14:00:00.000Z';
    await log(h, { outcome: 'voicemail', observedAt: again });
    expect(seq(h)).toMatchObject({ entries: 2, startedAt: again, currentStepId: steps[1], nextDueAt: '2027-03-21T14:00:00.000Z', state: 'active' });
    // The second run's completion is the final rest; there is no third entry.
    await log(h, { outcome: 'answered_not_interested', observedAt: '2027-03-21T14:00:00.000Z' });
    expect(seq(h)).toMatchObject({ entries: 2, state: 'paused', restingUntil: '2027-09-17T14:00:00.000Z' });
    // A firm in its final rest is never resumed: the call is recorded and the rest stands, with an honest reason.
    await log(h, { outcome: 'voicemail', observedAt: '2028-03-21T14:00:00.000Z' });
    expect(seq(h)).toMatchObject({ entries: 2, state: 'paused', restingUntil: '2027-09-17T14:00:00.000Z', nextDueAt: null, lastAdvance: 'rest_final' });
    expect(callRecordSchema.parse(h.f.db.inspect(callKey(h.firmId, '2028-03-21T14:00:00.000Z'))).outcome).toBe('voicemail');
  });

  it('writes CALLBACK# for a promised callback, carries it on the card as the next step, and resolves it when the call is made', async () => {
    const h = await harness();
    const steps = stepIds(h.policy, h.firmId);
    const promised = await log(h, { outcome: 'callback', callbackOn: '2026-09-22', note: 'Call back Tuesday after ten.' });
    expect(callbackRecordSchema.parse(h.f.db.inspect(callbackKey('2026-09-22', h.firmId))))
      .toMatchObject({ version: 1, firmId: h.firmId, dueOn: '2026-09-22', promisedAt: FRIDAY, promisedBy: callKey(h.firmId, FRIDAY), state: 'pending', resolvedAt: null });
    // The promised callback overrides the cadence's timing entirely: the step stays, no due instant is written.
    expect(seq(h)).toMatchObject({ currentStepId: steps[0], nextDueAt: null, state: 'active', lastAdvance: 'callback_promised' });
    expect(dueKeys(h)).toEqual([]);
    expect(cardOf(promised.receipt)).toMatchObject({ lane: 'callbacks', reason: 'callback_due',
      pendingCallback: { dueOn: '2026-09-22', promisedAt: FRIDAY }, nextStep: { kind: 'callback', dueOn: '2026-09-22' } });
    // The call David then makes is the callback: the pointer is closed as made, and the cadence resumes.
    const made = await log(h, { outcome: 'answered_interested', observedAt: '2026-09-22T14:00:00.000Z' });
    expect(callbackRecordSchema.parse(h.f.db.inspect(callbackKey('2026-09-22', h.firmId))))
      .toMatchObject({ state: 'made', resolvedAt: '2026-09-18T14:00:00.000Z' });
    expect(cardOf(made.receipt)).toMatchObject({ pendingCallback: null, nextStep: { kind: 'call', stepIndex: 0, stepCount: 5 } });
    expect(seq(h)).toMatchObject({ currentStepId: steps[0], nextDueAt: '2026-09-29T14:00:00.000Z', lastAdvance: 'interested' });
  });

  it('retires the dialed route on a wrong number and restarts the sequence on the next business phone the firm publishes', async () => {
    const h = await harness();
    const second = '+14015550250';
    await putTwoPhoneFirm(h.f.store, h.firmId, second);
    const steps = stepIds(h.policy, h.firmId);
    const receipt = await log(h, { outcome: 'wrong_number', note: 'Reaches a dentist.' });
    expect(h.f.db.inspect(territoryRetiredRouteKey(h.firmId, h.routeId))).toMatchObject({ accountId: h.firmId, routeId: h.routeId, reason: 'wrong_number' });
    // The route row itself is untouched: a retired route is never deleted and never dialed again.
    expect((h.f.db.inspect(accountKey(h.firmId)) as AccountRecord).routes.map(route => route.id)).toContain(h.routeId);
    const replacement = listedRouteId(h.firmId, second);
    expect(seq(h)).toMatchObject({ startedAt: FRIDAY, currentStepId: steps[0], nextDueAt: FRIDAY, state: 'active', routeId: replacement, lastAdvance: 'wrong_number_restarted' });
    expect(cardOf(receipt.receipt)).toMatchObject({ phone: { number: second, verification: 'listed' }, dialAllowed: true, lastOutcome: { outcome: 'wrong_number' } });
  });

  it('holds no_phone when a wrong number leaves the firm no business phone at all, and rests the sequence', async () => {
    const h = await harness();
    const receipt = await log(h, { outcome: 'wrong_number' });
    expect(h.f.db.inspect(territoryRetiredRouteKey(h.firmId, h.routeId))).toMatchObject({ reason: 'wrong_number' });
    expect(seq(h)).toMatchObject({ state: 'paused', nextDueAt: null, restingUntil: '2027-03-17T14:00:00.000Z', routeId: null, lastAdvance: 'rest_wrong_number' });
    expect(cardOf(receipt.receipt)).toMatchObject({ phone: null, dialAllowed: false, holdReason: 'no_phone', holdCode: 'no_phone' });
  });

  it('writes the whole suppression set on an opt-out and on a never-call reason, stops the sequence, and refuses every later outcome', async () => {
    for (const [outcome, extra, reason] of [['opt_out', {}, 'Asked not to be contacted again on the call.'],
      ['voicemail', { neverCall: { reason: 'Managing partner asked us never to call again.' } }, 'Managing partner asked us never to call again.']] as const) {
      const h = await harness(FRIDAY, { businessEmail: 'office@accountri1.example' });
      const receipt = await log(h, { outcome, ...extra });
      expect(receipt.receipt).toMatchObject({ outcome: 'applied', reason: null, slice: { kind: 'card', firmId: h.firmId, card: null } });
      expect(h.f.db.inspect(suppressionFirmKey(h.firmId))).toMatchObject({ version: 1, firmId: h.firmId, reason, source: 'call',
        evidenceRef: callKey(h.firmId, FRIDAY), recordedBy: 'David MacBook', at: FRIDAY, handles: [RI_PHONE, 'office@accountri1.example'] });
      // One record per known route, canonically keyed, plus the carried mail fence the old worker still checks.
      expect(h.f.db.inspect(suppressionHandleKey(RI_PHONE))).toMatchObject({ handle: RI_PHONE, channel: 'phone', firmId: h.firmId, source: 'call' });
      expect(h.f.db.inspect(suppressionHandleKey('office@accountri1.example'))).toMatchObject({ handle: 'office@accountri1.example', channel: 'email', firmId: h.firmId });
      expect(h.f.db.inspect(`MAIL_SUPPRESSION#${h.firmId}`)).toMatchObject({ accountId: h.firmId, observedAt: FRIDAY });
      expect(seq(h)).toMatchObject({ state: 'stopped', currentStepId: null, nextDueAt: null, lastAdvance: 'opt_out' });
      expect(dueKeys(h)).toEqual([]);
      // Permanent: a later outcome against a suppressed firm is refused, and there is no unsuppress anywhere.
      expect((await log(h, { outcome: 'answered_interested', observedAt: '2026-09-19T14:00:00.000Z' })).receipt).toMatchObject({ outcome: 'refused', reason: 'suppressed' });
    }
  });

  it('records once across a retried command id, returns the first card again, and refuses a different payload or another device', async () => {
    const h = await harness();
    const commandId = randomUUID();
    const first = await log(h, { outcome: 'voicemail', note: 'Left a message.' }, commandId);
    expect(first.receipt.outcome).toBe('applied');
    const retry = await log(h, { outcome: 'voicemail', note: 'Left a message.' }, commandId);
    expect(retry.receipt).toMatchObject({ outcome: 'duplicate', reason: 'applied' });
    // The retry answers with the same card, so a lost response still updates the Mac.
    expect(cardOf(retry.receipt)).toEqual(cardOf(first.receipt));
    expect(h.f.db.dump().map(item => item.sk!.S!).filter(key => key.startsWith('CALL#'))).toHaveLength(1);
    expect((await log(h, { outcome: 'busy', note: 'Left a message.' }, commandId)).receipt).toMatchObject({ outcome: 'refused', reason: 'command_conflict' });
    const other = await h.f.pairDevice('Loaner');
    const elsewhere = await h.f.request('POST', '/v1/commands', { authorization: other.bearer,
      body: { commandId, kind: 'log_call_outcome', firmId: h.firmId, outcome: 'voicemail', note: 'Left a message.', observedAt: FRIDAY } });
    expect(v1CommandReceiptSchema.parse(h.f.json(elsewhere))).toMatchObject({ outcome: 'refused', reason: 'command_conflict' });
    expect(h.f.db.dump().map(item => item.sk!.S!).filter(key => key.startsWith('CALL#'))).toHaveLength(1);
  });

  it('maps every one of the ten outcomes, so no outcome can reach the cadence as an unknown word', async () => {
    expect(Object.keys(CALL_OUTCOME_ADVANCE).sort()).toEqual([...V1_CALL_OUTCOMES].sort());
    for (const outcome of V1_CALL_OUTCOMES) expect(typeof CALL_OUTCOME_ADVANCE[outcome as V1CallOutcome]).toBe('string');
  });
});

/** The same Rhode Island firm with a second listed business phone, so a wrong number has somewhere to go. */
async function putTwoPhoneFirm(store: DynamoStore, firmId: string, second: string): Promise<void> {
  const record = firmRecord(riFirm(1));
  const route = { id: listedRouteId(firmId, second), accountId: firmId, personId: null, channel: 'phone' as const, value: second,
    purpose: 'business' as const, evidenceIds: [record.sources[0]!.id], verification: 'listed' as const, version: 1 };
  const account = { ...record.account, version: record.account.version + 1 };
  const next: AccountRecord = { ...record, account, routes: [...record.routes, route], researchRevision: record.researchRevision + 1,
    history: [...record.history, { at: '2026-09-17T12:00:00.000Z', account, claims: record.claims, routes: [...record.routes, route] }] };
  const existing = await store.get<unknown>(accountKey(firmId));
  await store.transact([store.put(accountKey(firmId), next, existing?.rev ?? null, { accountId: firmId, version: account.version })]);
  expect(fingerprint(next)).toBeTypeOf('string');
}
