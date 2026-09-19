import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { deriveTerritoryCampaignVersion } from '../../../../../src/shared/contracts/territoryCallPolicyContract';
import { todayViewSchema, v1CommandReceiptSchema, type TodayView } from '../../../../../src/shared/contracts/v1Contract';
import { sendStepJobId, type JobKind } from '../../src/queue/jobs';
import type { QueueClient } from '../../src/queue/queueClient';
import { runScheduler } from '../../src/scheduler';
import { dueKey, readDuePointers } from '../../src/v1/dayBuild';
import { createAccountFirmSource } from '../../src/v1/firms';
import { createSequencePort, sequenceKey, sequenceRecordSchema } from '../../src/v1/sequence';
import { enrollFirm, listedRouteId, putCallEvidence, putFirm, putTerritoryPolicy, riFirm, setPosture, tickOf } from './firmFixtures';
import { approveWithFooter, setPostalAddress } from './sendFixtures';
import { v1Fixture } from './v1Fixture';

/**
 * Day 0 is the day of the first call, not the day the backfill enrolled the firm (FSS target design sections 2
 * and 4; slice S2b). About 93 firms were enrolled at listing time in September 2026 and none of them has been
 * called. Anchored on the enrollment, their day-3 call and day-7 email are already "due" the moment David logs a
 * first outcome, so the scheduler would offer the T4 email on the same tick. The first logged outcome re-bases
 * `startedAt` on the call, and only the first: a sequence that already carries a call or a send is never re-based,
 * and a firm re-entering after its rest keeps the restart anchor the carried re-entry rule gives it.
 *
 * Everything here runs on the real handler, the real scheduler and the in-memory Dynamo harness. Nothing dials,
 * sends or books; every address and number is fictional and stays outside the 555-0100 to 555-0199 block the
 * production launcher refuses.
 *
 * The cadence is David's standing policy (D13 v1): day 0 call, day 3 call, day 7 email T4, day 12 call, day 21
 * email T5.
 */

const ENROLLED_AT = '2026-09-08T13:00:00.000Z'; // The old backfill enrolled the firm at listing time, ten days early.
const MORNING = '2026-09-18T09:05:00.000Z'; // 05:05 in Providence: the morning list may be built.
const CALL_AT = '2026-09-18T14:00:00.000Z'; // 10:00 in Providence: the first call, and so day 0.
const DAY_THREE = '2026-09-21T14:00:00.000Z'; // CALL_AT + 72 h.
const DAY_SEVEN = '2026-09-25T14:00:00.000Z'; // CALL_AT + 168 h.
const BEFORE_DAY_SEVEN = '2026-09-25T13:59:00.000Z';
const DAY_TWELVE = '2026-09-30T14:00:00.000Z'; // CALL_AT + 288 h.
/** ENROLLED_AT + 168 h: what the enrollment-time anchor made of the day-7 email. Three days before the call. */
const ENROLLMENT_DAY_SEVEN = '2026-09-15T13:00:00.000Z';

const FIRM_ID = 'account-ri-1';
const FIRM_EMAIL = 'office@rifirm1.invalid';
const RI_PHONE = '+14015550201';

type Harness = Awaited<ReturnType<typeof enrolledFirm>>;

/** One researched Rhode Island firm, enrolled under the standing policy at `startedAt` and never called. */
async function enrolledFirm(start: string, enrollment: Partial<Parameters<typeof enrollFirm>[1]> = {}) {
  const f = v1Fixture(start);
  const policy = await putTerritoryPolicy(f.store, '2026-09-01T12:00:00.000Z');
  const device = await f.pairDevice();
  await setPosture(f, device.bearer, 'RI', 'calling');
  await setPostalAddress(f.store);
  await approveWithFooter(f.store, 'T4');
  await putFirm(f.store, riFirm(1, { businessEmail: FIRM_EMAIL, researchedAt: '2026-09-07T12:00:00.000Z' }));
  const routeId = listedRouteId(FIRM_ID, RI_PHONE);
  const enrolled = await enrollFirm(f.store, { firmId: FIRM_ID, routeId, policy, startedAt: ENROLLED_AT, ...enrollment });
  return { f, policy, device, routeId, enrolled, steps: deriveTerritoryCampaignVersion(policy, FIRM_ID).steps };
}

/** One outcome through the real command route. */
async function log(h: Harness, body: Record<string, unknown>) {
  return v1CommandReceiptSchema.parse(h.f.json(await h.f.request('POST', '/v1/commands', { authorization: h.device.bearer,
    body: { commandId: randomUUID(), kind: 'log_call_outcome', firmId: FIRM_ID, ...body } })));
}

const seq = (h: Harness) => sequenceRecordSchema.parse(h.f.db.inspect(sequenceKey(FIRM_ID)));

function recordingQueue(): QueueClient & { sent: { jobId: string; kind: JobKind }[] } {
  const sent: { jobId: string; kind: JobKind }[] = [];
  return { sent, async enqueue(job: { jobId: string; kind: JobKind }) { sent.push(job); } };
}

/** One scheduler tick on the real scheduler, with the queue recorded rather than reached. */
async function tick(h: Harness): Promise<string[]> {
  const queue = recordingQueue();
  await runScheduler({ store: h.f.store, queue }, AbortSignal.timeout(10000));
  return queue.sent.map(job => job.jobId);
}

const lanesOf = (view: TodayView) => { if (view.list === null) throw new Error(`no list: ${view.reason}`); return view.list.lanes; };

describe('day 0 is the first call, not the enrollment', () => {
  it('re-bases the sequence on the first logged outcome, so the day-3 call is due in 72 h and T4 is not offered until 168 h', async () => {
    const h = await enrolledFirm(MORNING);
    // The enrollment anchored the firm ten days ago, so its day-7 email instant is already three days in the past.
    expect(ENROLLMENT_DAY_SEVEN < CALL_AT).toBe(true);
    await tickOf(h.f)();

    h.f.advance(CALL_AT);
    expect(await log(h, { outcome: 'voicemail', observedAt: CALL_AT, note: 'Left a message with the front desk.' }))
      .toMatchObject({ outcome: 'applied', reason: null });

    // The cadence now counts from the call: day 3 is 72 h away, and the record says why it moved.
    expect(seq(h)).toMatchObject({ startedAt: CALL_AT, currentStepId: h.steps[1]!.id, nextDueAt: DAY_THREE,
      restingUntil: null, state: 'active', entries: 1, lastAdvance: 'rebased_to_first_call' });
    // The `DUE#` pointer matches the re-based anchor, and the enrollment-time pointer it stood on is retired.
    expect(h.f.db.inspect(dueKey(DAY_THREE, FIRM_ID))).toMatchObject({ firmId: FIRM_ID, stepId: h.steps[1]!.id, nextDueAt: DAY_THREE });
    expect(h.f.db.inspect(dueKey(ENROLLED_AT, FIRM_ID))).toMatchObject({ retired: true, firmId: FIRM_ID });

    // The day-7 email is not offered on the day of the call, nor a minute before its own re-based instant.
    const t4 = sendStepJobId(FIRM_ID, h.steps[2]!.id);
    expect(h.steps[2]!.channel).toBe('email');
    expect(await tick(h)).not.toContain(t4);
    h.f.advance(BEFORE_DAY_SEVEN);
    expect(await tick(h)).not.toContain(t4);
    // And it is offered exactly 168 h after the call.
    h.f.advance(DAY_SEVEN);
    expect(await tick(h)).toContain(t4);
  });

  it('keeps a never-called firm in the new lane and out of the due lane, however old its due pointer is', async () => {
    const h = await enrolledFirm(MORNING);
    await tickOf(h.f)();
    // The pointer really is due: the enrollment's day-0 instant is ten days old and the range read returns it.
    const firms = await createAccountFirmSource(h.f.store).listFirms();
    expect((await readDuePointers(h.f.store, firms, MORNING)).map(pointer => pointer.firmId)).toEqual([FIRM_ID]);
    // The lanes still agree that this is a firm to start, not a firm to continue: nothing has been said to it.
    const morning = todayViewSchema.parse(h.f.json(await h.f.request('GET', '/v1/today', { authorization: h.device.bearer })));
    expect(lanesOf(morning).due).toEqual([]);
    expect(lanesOf(morning).new.map(card => card.firmId)).toEqual([FIRM_ID]);
  });

  it('never re-bases a sequence that already carries a call: neither its own second outcome nor an old-key one', async () => {
    const own = await enrolledFirm(CALL_AT);
    await log(own, { outcome: 'voicemail', observedAt: CALL_AT });
    own.f.advance(DAY_THREE);
    await log(own, { outcome: 'no_answer', observedAt: DAY_THREE });
    // The anchor stands where the first call put it: day 12 counts from day 0, not from the second call.
    expect(seq(own)).toMatchObject({ startedAt: CALL_AT, currentStepId: own.steps[3]!.id, nextDueAt: DAY_TWELVE, lastAdvance: 'continue' });

    // A firm the old app already called is past its first call too, whatever the `SEQ#` record knows.
    const old = await enrolledFirm(CALL_AT);
    await putCallEvidence(old.f.store, { enrollment: old.enrolled.enrollment, version: old.enrolled.version,
      routeId: old.routeId, outcome: 'no_answer', observedAt: '2026-09-09T13:00:00.000Z' });
    await log(old, { outcome: 'voicemail', observedAt: CALL_AT });
    expect(seq(old)).toMatchObject({ startedAt: ENROLLED_AT, currentStepId: old.steps[1]!.id,
      nextDueAt: '2026-09-11T13:00:00.000Z', lastAdvance: 'continue' });
  });

  it('leaves a record the carried rule cannot read exactly as it stood: step_unknown is never dressed up as a re-base', async () => {
    const h = await enrolledFirm(CALL_AT);
    // A mail job reached the sequence before any call, so the record carries a seed with no frozen steps at all.
    await createSequencePort(h.f.store).holdStep({ firmId: FIRM_ID, enrollmentId: h.enrolled.enrollment.id, startedAt: ENROLLED_AT,
      currentStepId: h.steps[2]!.id, nextDueAt: null, stepId: h.steps[2]!.id, code: 'mailbox_not_connected' });
    expect(seq(h).steps).toEqual([]);
    await log(h, { outcome: 'voicemail', observedAt: CALL_AT });
    expect(seq(h)).toMatchObject({ startedAt: ENROLLED_AT, currentStepId: h.steps[2]!.id, lastAdvance: 'step_unknown' });
  });

  it('leaves a firm re-entering after its rest on the restart anchor the carried re-entry rule gives it', async () => {
    const h = await enrolledFirm(CALL_AT, { state: 'paused', restingUntil: '2026-09-17T13:00:00.000Z', nextDueAt: null });
    await log(h, { outcome: 'voicemail', observedAt: CALL_AT });
    // The restart is the anchor, and it keeps the carried word: this is a second entry, not a first call.
    expect(seq(h)).toMatchObject({ entries: 2, startedAt: CALL_AT, currentStepId: h.steps[1]!.id,
      nextDueAt: DAY_THREE, state: 'active', lastAdvance: 'continue' });
  });
});
