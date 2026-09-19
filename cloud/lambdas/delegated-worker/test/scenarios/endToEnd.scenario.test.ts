import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { deriveTerritoryCampaignVersion } from '../../../../../src/shared/contracts/territoryCallPolicyContract';
import { todayViewSchema, v1CommandReceiptSchema, v1FirmViewSchema, type TodayView } from '../../../../../src/shared/contracts/v1Contract';
import { queueMessage, sendStepJobId, pollJobId, type JobKind } from '../../src/queue/jobs';
import { runQueuedJob } from '../../src/runner';
import { runScheduler } from '../../src/scheduler';
import type { QueueClient } from '../../src/queue/queueClient';
import { callKey, callRecordSchema } from '../../src/v1/calls';
import { dueKey } from '../../src/v1/dayBuild';
import { runMailPollJob } from '../../src/v1/mail';
import { readSend } from '../../src/v1/send';
import { sequenceKey, sequenceRecordSchema } from '../../src/v1/sequence';
import { suppressionFirmKey, suppressionHandleKey } from '../../src/v1/suppression';
import { putFirm, putTerritoryPolicy, riFirm, setPosture, dayBuildOf, tickOf } from './firmFixtures';
import { approveWithFooter, gmailFetch, mailboxAccess, MAILBOX, setPostalAddress } from './sendFixtures';
import { v1Fixture } from './v1Fixture';

/**
 * One firm, end to end, on the real handlers and the real store adapter: the morning list offers it, a call is
 * logged as voicemail, its day-7 email step comes due, the runner sends it exactly once, the firm replies "stop",
 * and from then on it is in the suppression set and never appears in a list again.
 *
 * This is the seam every slice meets at. S1 builds the day and reads `DUE#`; S2 owns `SEQ#`, the call record and
 * the suppression set; S3 schedules, sends and polls the mailbox. Nothing here stubs a port: the only synthetic
 * boundaries are the Dynamo SDK harness, the recording queue (which is exactly where SQS sits) and one injected
 * fetch. Every address, number and message id is fictional and the mailbox is never reached.
 *
 * The cadence is David's standing policy (D13 v1): day 0 call, day 3 call, day 7 email T4, day 12 call, day 21
 * email T5. The call cadence steps past an email step and records it as held — that is the carried rule — so the
 * day-7 email becomes due on its own start-anchored instant, which is what the scheduler reads below.
 */

const FRIDAY_EARLY = '2026-09-18T09:05:00.000Z'; // 05:05 in Providence: the morning list may be built.
const FRIDAY_CALL = '2026-09-18T14:00:00.000Z'; // 10:00 in Providence: inside the code floor.
const DAY_THREE = '2026-09-21T14:00:00.000Z'; // The day-3 call step, 72 h after the call that is day 0.
const DAY_SEVEN = '2026-09-25T14:05:00.000Z'; // Just past the day-7 instant that same call anchored (168 h).
const REPLY_AT = '2026-09-25T16:00:00.000Z';
const NEXT_WEEK = '2026-09-28T09:05:00.000Z'; // The following Monday's 05:05 build.

const FIRM_ID = 'account-ri-1';
const FIRM_EMAIL = 'office@rifirm1.invalid';

function recordingQueue(): QueueClient & { sent: { jobId: string; kind: JobKind }[] } {
  const sent: { jobId: string; kind: JobKind }[] = [];
  return { sent, async enqueue(job: { jobId: string; kind: JobKind }) { sent.push(job); } };
}

/** A Gmail mailbox holding one message from the firm, for the poll that reads the reply. */
function replyFetch(message: { id: string; from: string; subject: string; body: string; at: string }): typeof globalThis.fetch {
  const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  let page = 0;
  return async resource => {
    const url = new URL(String(resource));
    if (url.pathname.endsWith('/profile')) return json(200, { historyId: '900' });
    if (url.pathname.endsWith('/messages')) { page += 1; return json(200, page === 1 ? { messages: [{ id: message.id }] } : {}); }
    if (url.pathname.endsWith('/history')) return json(200, { historyId: '900', history: [] });
    if (url.pathname.endsWith(`/messages/${message.id}`)) {
      return json(200, { id: message.id, threadId: 'thread-reply', internalDate: String(Date.parse(message.at)),
        payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: message.from }, { name: 'To', value: MAILBOX },
          { name: 'Subject', value: message.subject }, { name: 'Message-ID', value: `<${message.id}@rifirm1.invalid>` }],
        body: { data: Buffer.from(message.body).toString('base64url') } } });
    }
    return json(404, {});
  };
}

const lanesOf = (view: TodayView) => { if (view.list === null) throw new Error(`no list: ${view.reason}`); return view.list.lanes; };
/** Every firm any lane offers, and nothing at all when the build found no candidate to offer. */
const firmIdsIn = (view: TodayView) => (view.list === null ? [] : Object.values(view.list.lanes).flat().map(card => card.firmId));

describe('one firm end to end: listed, called, emailed once, stopped, suppressed', () => {
  it('walks the whole cadence on the real handlers and never lists the firm again after it says stop', async () => {
    const f = v1Fixture(FRIDAY_EARLY);
    const device = await f.pairDevice();
    const policy = await putTerritoryPolicy(f.store, '2026-09-01T12:00:00.000Z');
    await setPosture(f, device.bearer, 'RI', 'calling');
    await setPostalAddress(f.store);
    await approveWithFooter(f.store, 'T4');
    await putFirm(f.store, riFirm(1, { businessEmail: FIRM_EMAIL, researchedAt: '2026-09-10T12:00:00.000Z' }));
    const steps = deriveTerritoryCampaignVersion(policy, FIRM_ID).steps;
    const emailStep = steps[2]!;
    expect(emailStep.channel).toBe('email');

    // 1. Listed. The morning build offers the firm as a new one; nothing has been said to it yet.
    // The old tick still enrolls the firm under the standing policy; S6 moved only the list build off it.
    await tickOf(f)();
    await dayBuildOf(f)();
    const morning = todayViewSchema.parse(f.json(await f.request('GET', '/v1/today', { authorization: device.bearer })));
    expect(lanesOf(morning).new.map(card => card.firmId)).toEqual([FIRM_ID]);
    expect(lanesOf(morning).new[0]).toMatchObject({ lane: 'new', reason: 'new_firm', lastOutcome: null, pendingCallback: null });

    // 2. The call, logged once through the real command route: voicemail, at 10:00 on the firm's own clock.
    f.advance(FRIDAY_CALL);
    const receipt = v1CommandReceiptSchema.parse(f.json(await f.request('POST', '/v1/commands', { authorization: device.bearer,
      body: { commandId: randomUUID(), kind: 'log_call_outcome', firmId: FIRM_ID, outcome: 'voicemail', observedAt: FRIDAY_CALL,
        note: 'Left a message with the front desk.' } })));
    expect(receipt).toMatchObject({ outcome: 'applied', reason: null });
    expect(callRecordSchema.parse(f.db.inspect(callKey(FIRM_ID, FRIDAY_CALL)))).toMatchObject({ outcome: 'voicemail', dial: { dialAllowed: true } });
    // The cadence is anchored on the call, not on the enrollment. The old tick that builds the list also enrolls
    // the firm under the standing policy at 05:05, and the logged call advances that sequence rather than starting
    // a second one — the `SEQ#` record is read new-first and seeded from the carried enrollment when there is none
    // — but nothing had been said to the firm before 10:00, so this call is day 0 and everything counts from it.
    const anchored = sequenceRecordSchema.parse(f.db.inspect(sequenceKey(FIRM_ID)));
    expect(anchored).toMatchObject({ startedAt: FRIDAY_CALL, currentStepId: steps[1]!.id, nextDueAt: DAY_THREE,
      state: 'active', lastAdvance: 'rebased_to_first_call' });
    expect(anchored.heldSteps.map(step => step.stepId)).toContain(emailStep.id);
    expect(anchored.heldSteps.find(step => step.stepId === emailStep.id)?.templateId).toBe('T4');
    expect(f.db.dump().map(item => item.sk!.S!)).toContain(dueKey(DAY_THREE, FIRM_ID));

    // 3. Day seven. The scheduler reads the `SEQ#` record and offers the email step exactly once, by its own id.
    f.advance(DAY_SEVEN);
    const queue = recordingQueue();
    const tick = await runScheduler({ store: f.store, queue }, AbortSignal.timeout(5000));
    const jobId = sendStepJobId(FIRM_ID, emailStep.id);
    expect(queue.sent.filter(job => job.kind === 'mail.send_step')).toEqual([{ jobId, kind: 'mail.send_step' }]);
    expect(tick.enqueued.map(job => job.jobId)).toContain(jobId);

    // 4. Sent once by the runner. The second delivery of the same message sends nothing.
    const gmail = gmailFetch({ send: ['accepted'] });
    const runner = { store: f.store, mailbox: mailboxAccess(), fetch: gmail.fetch, budgetMs: 5000 };
    const body = JSON.stringify(queueMessage(jobId, 'mail.send_step'));
    expect(await runQueuedJob(runner, body)).toMatchObject({ jobId, state: 'done' });
    expect(await runQueuedJob(runner, body)).toEqual({ jobId, state: 'skipped', reason: 'already_done' });
    expect(gmail.calls.filter(call => call.url.includes('/messages/send'))).toHaveLength(1);
    const send = await readSend(f.store, FIRM_ID, emailStep.id);
    expect(send?.record).toMatchObject({ state: 'accepted', templateId: 'T4', providerMessageId: 'sent-1' });
    expect(send?.record.frozen).toMatchObject({ from: MAILBOX, to: FIRM_EMAIL });
    // The send is recorded on the sequence, and sending a step the call cadence already walked past never rewinds it.
    const sent = sequenceRecordSchema.parse(f.db.inspect(sequenceKey(FIRM_ID)));
    expect(sent.sentSteps.map(step => step.stepId)).toEqual([emailStep.id]);
    expect(sent.heldSteps.map(step => step.stepId)).not.toContain(emailStep.id);
    expect(sent).toMatchObject({ currentStepId: steps[1]!.id, nextDueAt: DAY_THREE, state: 'active' });

    // A second scheduler tick offers nothing for the step that has gone out.
    const later = recordingQueue();
    await runScheduler({ store: f.store, queue: later }, AbortSignal.timeout(5000));
    expect(later.sent.map(job => job.jobId)).not.toContain(jobId);

    // 5. The firm replies "stop". The poller matches it by sender, suppresses the firm and every handle it knows,
    //    and stops the sequence. Suppression is permanent: there is no command anywhere that lifts it.
    f.advance(REPLY_AT);
    const poll = await runMailPollJob({ store: f.store, mailbox: mailboxAccess(), fetch: replyFetch({ id: 'msg-stop', from: FIRM_EMAIL,
      subject: 'Re: A quick question', body: 'STOP', at: REPLY_AT }) }, { jobId: pollJobId(1) }, AbortSignal.timeout(5000));
    expect(poll).toMatchObject({ matched: 1, recorded: 1, optOuts: 1, drafts: 0 });
    expect(f.db.inspect(suppressionFirmKey(FIRM_ID))).toMatchObject({ reason: 'opt_out', source: 'reply' });
    expect(f.db.inspect(suppressionHandleKey(FIRM_EMAIL))).toMatchObject({ firmId: FIRM_ID });
    expect(sequenceRecordSchema.parse(f.db.inspect(sequenceKey(FIRM_ID)))).toMatchObject({ state: 'stopped', holdCode: 'opt_out', currentStepId: null, nextDueAt: null });

    // 6. Never listed again. The next morning's build offers no lane with this firm in it, and the scheduler has
    //    nothing left to enqueue for it.
    f.advance(NEXT_WEEK);
    // The old tick still enrolls the firm under the standing policy; S6 moved only the list build off it.
    await tickOf(f)();
    await dayBuildOf(f)();
    const monday = todayViewSchema.parse(f.json(await f.request('GET', '/v1/today', { authorization: device.bearer })));
    expect(firmIdsIn(monday)).not.toContain(FIRM_ID);
    // It was the only firm in the workspace, so the morning has nothing to offer at all — not a held card, not a
    // card with a reason on it. A firm that asked to stop leaves the list entirely.
    expect(monday).toMatchObject({ list: null, reason: 'no_candidates' });
    const mondayQueue = recordingQueue();
    await runScheduler({ store: f.store, queue: mondayQueue }, AbortSignal.timeout(5000));
    expect(mondayQueue.sent.filter(job => job.kind === 'mail.send_step')).toEqual([]);

    // The firm's own page still tells the whole story: the call, the send, the reply and why it is closed.
    const view = v1FirmViewSchema.parse(f.json(await f.request('GET', '/v1/firms', { authorization: device.bearer, query: `firmId=${FIRM_ID}` })));
    expect(view).toMatchObject({ firmId: FIRM_ID, status: 'suppressed', suppression: { reason: 'opt_out', source: 'reply' } });
    expect(view.calls.map(call => call.outcome)).toEqual(['voicemail']);
    expect(view.sends).toEqual([expect.objectContaining({ stepId: emailStep.id, state: 'accepted', templateId: 'T4' })]);
    expect(view.replies).toEqual([expect.objectContaining({ replyId: 'msg-stop', classification: 'opt_out', matchedBy: 'sender' })]);
    expect(view.drafts).toEqual([]);
    expect(view.sequence).toMatchObject({ state: 'stopped' });
  });
});
