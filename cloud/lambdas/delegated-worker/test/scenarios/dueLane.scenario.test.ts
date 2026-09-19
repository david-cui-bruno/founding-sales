import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { deriveTerritoryCampaignVersion } from '../../../../../src/shared/contracts/territoryCallPolicyContract';
import { todayViewSchema, v1CommandReceiptSchema, type TodayView } from '../../../../../src/shared/contracts/v1Contract';
import { sendStepJobId, type JobKind } from '../../src/queue/jobs';
import type { QueueClient } from '../../src/queue/queueClient';
import { runScheduler } from '../../src/scheduler';
import { sequenceKey, sequenceRecordSchema } from '../../src/v1/sequence';
import { enrollFirm, listedRouteId, putFirm, putTerritoryPolicy, readDay, riFirm, setPosture, morningOf } from './firmFixtures';
import { approveWithFooter, setPostalAddress } from './sendFixtures';
import { v1Fixture } from './v1Fixture';

/**
 * The morning after a call (FSS target design section 4, the `due` and `callbacks` lanes; slice S2b). A firm David
 * called yesterday must come back on the day its cadence says, and the only record that knows where it stands is
 * the `SEQ#` one: the S2 path never edits the old `CAMPAIGN_ENROLLMENT#` pair, so a build that reads the enrollment
 * for the standing step still sees step 0 and drops the firm out of the due lane — and out of the new lane too,
 * as `already_listed`. It then appears in no lane at all, which is what this file exists to stop.
 *
 * Everything runs on the real handler, the real scheduled tick and the real scheduler, on the in-memory Dynamo
 * harness. Nothing dials, sends or books; every address and number is fictional and stays outside the 555-0100 to
 * 555-0199 block the production launcher refuses.
 *
 * The cadence is David's standing policy (D13 v1): day 0 call, day 3 call, day 7 email T4, day 12 call, day 21
 * email T5, every offset counted from the first call (slice S2b).
 */

const ENROLLED_AT = '2026-09-08T13:00:00.000Z'; // The old backfill enrolled the firm at listing time, ten days early.
const MORNING = '2026-09-18T09:05:00.000Z'; // 05:05 in Providence: the morning list may be built.
const CALL_AT = '2026-09-18T14:00:00.000Z'; // 10:00 in Providence: the first call, and so day 0.
const DAY_THREE_BUILD = '2026-09-21T09:05:00.000Z'; // The 05:05 build of the day the day-3 call comes due.
const DAY_THREE_CALL = '2026-09-21T14:05:00.000Z'; // 10:05 in Providence on day 3.
const DAY_THREE_DUE = '2026-09-21T14:00:00.000Z'; // CALL_AT + 72 h.
const DAY_SEVEN_BUILD = '2026-09-25T09:05:00.000Z';
const DAY_SEVEN_DUE = '2026-09-25T14:00:00.000Z'; // CALL_AT + 168 h.
const DAY_TWELVE_DUE = '2026-09-30T14:00:00.000Z'; // CALL_AT + 288 h.

const FIRM_ID = 'account-ri-1';
const FIRM_EMAIL = 'office@rifirm1.invalid';
const RI_PHONE = '+14015550201';

type Harness = Awaited<ReturnType<typeof enrolledFirm>>;

/** One researched Rhode Island firm, enrolled under the standing policy ten days ago and never called. */
async function enrolledFirm() {
  const f = v1Fixture(MORNING);
  const policy = await putTerritoryPolicy(f.store, '2026-09-01T12:00:00.000Z');
  const device = await f.pairDevice();
  await setPosture(f, device.bearer, 'RI', 'calling');
  await setPostalAddress(f.store);
  await approveWithFooter(f.store, 'T4');
  await putFirm(f.store, riFirm(1, { businessEmail: FIRM_EMAIL, researchedAt: '2026-09-07T12:00:00.000Z' }));
  await enrollFirm(f.store, { firmId: FIRM_ID, routeId: listedRouteId(FIRM_ID, RI_PHONE), policy, startedAt: ENROLLED_AT });
  return { f, policy, device, steps: deriveTerritoryCampaignVersion(policy, FIRM_ID).steps };
}

async function log(h: Harness, body: Record<string, unknown>) {
  return v1CommandReceiptSchema.parse(h.f.json(await h.f.request('POST', '/v1/commands', { authorization: h.device.bearer,
    body: { commandId: randomUUID(), kind: 'log_call_outcome', firmId: FIRM_ID, ...body } })));
}

const view = async (h: Harness): Promise<TodayView> =>
  todayViewSchema.parse(h.f.json(await h.f.request('GET', '/v1/today', { authorization: h.device.bearer })));
const lanesOf = (v: TodayView) => { if (v.list === null) throw new Error(`no list: ${v.reason}`); return v.list.lanes; };
const seq = (h: Harness) => sequenceRecordSchema.parse(h.f.db.inspect(sequenceKey(FIRM_ID)));

function recordingQueue(): QueueClient & { sent: { jobId: string; kind: JobKind }[] } {
  const sent: { jobId: string; kind: JobKind }[] = [];
  return { sent, async enqueue(job: { jobId: string; kind: JobKind }) { sent.push(job); } };
}
async function tick(h: Harness): Promise<string[]> {
  const queue = recordingQueue();
  await runScheduler({ store: h.f.store, queue }, AbortSignal.timeout(10000));
  return queue.sent.map(job => job.jobId);
}

describe('the morning after a call: the due lane reads the sequence, not the old enrollment', () => {
  it('brings a firm called on day 0 back in the due lane on day 3, with the step it actually stands on', async () => {
    const h = await enrolledFirm();
    await morningOf(h.f)();
    expect(lanesOf(await view(h)).new.map(card => card.firmId)).toEqual([FIRM_ID]);

    h.f.advance(CALL_AT);
    await log(h, { outcome: 'voicemail', observedAt: CALL_AT, note: 'Left a message with the front desk.' });
    expect(seq(h)).toMatchObject({ startedAt: CALL_AT, currentStepId: h.steps[1]!.id, nextDueAt: DAY_THREE_DUE });

    // Day three. The build reads where the firm stands from `SEQ#`, so it is a due-lane firm, not a firm that
    // vanished between the lanes: the old enrollment still says step 0 and the day record no longer believes it.
    h.f.advance(DAY_THREE_BUILD);
    await morningOf(h.f)();
    const day = readDay(h.f, '2026-09-21');
    expect(day?.lanes.due).toEqual([{ firmId: FIRM_ID, reason: 'step_due' }]);
    expect(day?.lanes.new).toEqual([]);
    expect(day?.excluded).not.toHaveProperty('already_listed');

    // And the card David reads at ten past ten is the call he is meant to make: step 1 of 5, due at 72 h.
    h.f.advance(DAY_THREE_CALL);
    const lanes = lanesOf(await view(h));
    expect(lanes.due.map(card => card.firmId)).toEqual([FIRM_ID]);
    expect(lanes.due[0]).toMatchObject({ lane: 'due', reason: 'step_due', dialAllowed: true, holdReason: null,
      phone: { number: RI_PHONE }, lastOutcome: { outcome: 'voicemail', at: CALL_AT, note: 'Left a message with the front desk.' },
      pendingCallback: null, nextStep: { kind: 'call', stepIndex: 1, stepCount: 5, dueAt: DAY_THREE_DUE } });
  });

  it('leaves the day-7 email to the scheduler: the due lane never offers a call for an email step', async () => {
    const h = await enrolledFirm();
    await morningOf(h.f)();
    h.f.advance(CALL_AT);
    await log(h, { outcome: 'voicemail', observedAt: CALL_AT });
    h.f.advance(DAY_THREE_CALL);
    await log(h, { outcome: 'no_answer', observedAt: DAY_THREE_CALL });
    // The cadence walked past the day-7 email and held it; the next call step is day 12.
    const record = seq(h);
    expect(record).toMatchObject({ currentStepId: h.steps[3]!.id, nextDueAt: DAY_TWELVE_DUE });
    expect(record.heldSteps.map(step => step.stepId)).toContain(h.steps[2]!.id);

    // Day seven: there is nothing to call, and the build says so rather than offering the email step as a call.
    h.f.advance(DAY_SEVEN_BUILD);
    await morningOf(h.f)();
    expect(readDay(h.f, '2026-09-25')).toMatchObject({ lanes: { replies: [], callbacks: [], due: [], new: [] } });
    expect(await view(h)).toMatchObject({ list: null, reason: 'no_candidates' });
    // The email step is the scheduler's, on its own re-based instant.
    h.f.advance(DAY_SEVEN_DUE);
    expect(await tick(h)).toContain(sendStepJobId(FIRM_ID, h.steps[2]!.id));
  });

  it('puts a firm with a callback promised for today in the callbacks lane, never in the due lane', async () => {
    const h = await enrolledFirm();
    await morningOf(h.f)();
    h.f.advance(CALL_AT);
    await log(h, { outcome: 'callback', callbackOn: '2026-09-21', observedAt: CALL_AT, note: 'Call back Monday after ten.' });
    // A promised callback overrides the cadence's timing: the sequence keeps its step and carries no due instant.
    expect(seq(h)).toMatchObject({ currentStepId: h.steps[0]!.id, nextDueAt: null, lastAdvance: 'callback_promised' });

    h.f.advance(DAY_THREE_BUILD);
    await morningOf(h.f)();
    expect(readDay(h.f, '2026-09-21')).toMatchObject({ lanes: { callbacks: [{ firmId: FIRM_ID, reason: 'callback_due' }], due: [], new: [] } });

    h.f.advance(DAY_THREE_CALL);
    const lanes = lanesOf(await view(h));
    expect(lanes.due).toEqual([]);
    expect(lanes.callbacks[0]).toMatchObject({ lane: 'callbacks', reason: 'callback_due', dialAllowed: true,
      pendingCallback: { dueOn: '2026-09-21', promisedAt: CALL_AT }, nextStep: { kind: 'callback', dueOn: '2026-09-21' } });
  });

  it('does not offer a callback before the day it was promised for', async () => {
    const h = await enrolledFirm();
    await morningOf(h.f)();
    h.f.advance(CALL_AT);
    await log(h, { outcome: 'callback', callbackOn: '2026-09-21', observedAt: CALL_AT });
    // The next morning is not the promised morning: the firm waits, and no lane claims it.
    h.f.advance('2026-09-19T09:05:00.000Z');
    await morningOf(h.f)();
    expect(readDay(h.f, '2026-09-19')).toMatchObject({ lanes: { replies: [], callbacks: [], due: [], new: [] } });
  });
});
