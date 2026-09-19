import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { diagnosticsViewSchema, todayViewSchema } from '../../../../../src/shared/contracts/v1Contract';
import { sendFollowupJobId, sendStepJobId } from '../../src/queue/jobs';
import type { QueueClient } from '../../src/queue/queueClient';
import { runScheduler } from '../../src/scheduler';
import { readDrafts } from '../../src/v1/mail';
import { runSendStepJob } from '../../src/v1/send';
import { footerBlock, POSTAL_ADDRESS_MAX, readSendingSettings, readTemplate, templateApproved } from '../../src/v1/templates';
import { putDay, putTerritoryPolicy, setPosture } from './firmFixtures';
import { enrollOnEmailStep, gmailFetch, mailboxAccess, POSTAL_ADDRESS } from './sendFixtures';
import { v1Fixture } from './v1Fixture';

/**
 * The `/v1` commands and views email adds (FSS target design section 3; slice S3), through the real handler, the
 * real router and the real store adapter. Every command goes over HTTP with a real device token and a real
 * receipt; no test reaches past the injected fetch, and no command here sends anything.
 */

const START = '2026-09-18T12:00:00.000Z';
const command = (kind: string, body: Record<string, unknown>) => ({ commandId: randomUUID(), kind, ...body });

function recordingQueue(): QueueClient & { sent: { jobId: string }[] } {
  const sent: { jobId: string }[] = [];
  return { sent, async enqueue(job) { sent.push({ jobId: job.jobId }); } };
}

describe('the email commands and views', () => {
  it('refuses approve_template without a postal address, then without the footer, then records the standing approval', async () => {
    const f = v1Fixture(START);
    const { bearer } = await f.pairDevice();
    const seeded = await readTemplate(f.store, 'T4');

    // No postal address in the sending settings yet: nothing can be approved at all.
    const noAddress = await f.request('POST', '/v1/commands', { authorization: bearer,
      body: command('approve_template', { templateId: 'T4', expectedRevision: seeded.record.revision, subject: seeded.record.subject, body: seeded.record.body }) });
    expect(f.json(noAddress)).toMatchObject({ outcome: 'refused', reason: 'postal_address_not_set' });

    const limit = await f.request('POST', '/v1/commands', { authorization: bearer, body: command('set_sending_limit', { postalAddress: POSTAL_ADDRESS }) });
    expect(f.json(limit)).toMatchObject({ outcome: 'applied' });

    // The seeded body ends at the sign-off, with no address and no stop line.
    const noFooter = await f.request('POST', '/v1/commands', { authorization: bearer,
      body: command('approve_template', { templateId: 'T4', expectedRevision: seeded.record.revision, subject: seeded.record.subject, body: seeded.record.body }) });
    expect(f.json(noFooter)).toMatchObject({ outcome: 'refused', reason: 'template_footer_missing' });
    expect(templateApproved((await readTemplate(f.store, 'T4')).record, POSTAL_ADDRESS)).toBe(false);

    const footer = footerBlock(POSTAL_ADDRESS);
    const body = `${seeded.record.body}\n${POSTAL_ADDRESS}\n${footer.split('\n').at(-1)}`;
    const approved = await f.request('POST', '/v1/commands', { authorization: bearer,
      body: command('approve_template', { templateId: 'T4', expectedRevision: seeded.record.revision, subject: seeded.record.subject, body }) });
    expect(f.json(approved)).toMatchObject({ outcome: 'applied', reason: null });
    const record = (await readTemplate(f.store, 'T4')).record;
    expect(templateApproved(record, POSTAL_ADDRESS)).toBe(true);
    // Changing the postal address leaves the approval behind rather than sending a footer David did not read.
    expect(templateApproved(record, '9 Other Way, Providence, RI 02903')).toBe(false);
  });

  it('set_sending_limit narrows the code ceiling and refuses anything that would widen it', async () => {
    const f = v1Fixture(START);
    const { bearer } = await f.pairDevice();
    const narrow = await f.request('POST', '/v1/commands', { authorization: bearer,
      body: command('set_sending_limit', { postalAddress: POSTAL_ADDRESS, dailyLimit: 12, ramp: { startPerDay: 4, stepPerDay: 1, maxPerDay: 12 } }) });
    expect(f.json(narrow)).toMatchObject({ outcome: 'applied' });
    expect((await readSendingSettings(f.store)).settings).toMatchObject({ dailyLimit: 12, ramp: { startPerDay: 4, stepPerDay: 1, maxPerDay: 12 } });

    for (const widening of [{ dailyLimit: 41 }, { ramp: { startPerDay: 11, stepPerDay: 2, maxPerDay: 40 } }, { ramp: { startPerDay: 10, stepPerDay: 3, maxPerDay: 40 } }]) {
      const refused = await f.request('POST', '/v1/commands', { authorization: bearer, body: command('set_sending_limit', widening) });
      expect(f.json(refused), JSON.stringify(widening)).toMatchObject({ outcome: 'refused', reason: 'sending_limit_exceeds_code_ceiling' });
    }
    expect((await readSendingSettings(f.store)).settings.dailyLimit).toBe(12);
    expect(POSTAL_ADDRESS.length).toBeLessThanOrEqual(POSTAL_ADDRESS_MAX);
  });

  it('a follow-up David requests and approves is queued by the scheduler, never by approving it', async () => {
    const f = v1Fixture(START);
    const { bearer } = await f.pairDevice();
    await setPosture(f, bearer, 'RI', 'calling');
    const policy = await putTerritoryPolicy(f.store, '2026-09-01T12:00:00.000Z');
    await f.request('POST', '/v1/commands', { authorization: bearer, body: command('set_sending_limit', { postalAddress: POSTAL_ADDRESS }) });
    const firm = await enrollOnEmailStep(f.store, policy, { n: 1, startedAt: '2026-09-11T12:00:00.000Z' });
    const draftId = randomUUID();

    const requested = await f.request('POST', '/v1/commands', { authorization: bearer, body: command('request_followup', { firmId: firm.firmId, draftId }) });
    expect(f.json(requested)).toMatchObject({ outcome: 'applied' });
    expect(await readDrafts(f.store, firm.firmId)).toMatchObject([{ status: 'pending', text: null }]);

    // A pending draft is never enqueued: only an approved one with David's own text is.
    const queue = recordingQueue();
    await runScheduler({ store: f.store, queue }, AbortSignal.timeout(5000));
    expect(queue.sent.map(job => job.jobId)).not.toContain(sendFollowupJobId(firm.firmId, draftId));

    const approved = await f.request('POST', '/v1/commands', { authorization: bearer,
      body: command('approve_followup_draft', { firmId: firm.firmId, draftId, text: 'A short note David wrote.' }) });
    expect(f.json(approved)).toMatchObject({ outcome: 'applied' });
    queue.sent.length = 0;
    f.advance('2026-09-18T12:05:00.000Z');
    await runScheduler({ store: f.store, queue }, AbortSignal.timeout(5000));
    expect(queue.sent.map(job => job.jobId)).toContain(sendFollowupJobId(firm.firmId, draftId));
  });

  it('Today carries the pending draft and the sequence hold, and Diagnostics carries the queue', async () => {
    const f = v1Fixture(START);
    const { bearer } = await f.pairDevice();
    await setPosture(f, bearer, 'RI', 'calling');
    const policy = await putTerritoryPolicy(f.store, '2026-09-01T12:00:00.000Z');
    await f.request('POST', '/v1/commands', { authorization: bearer, body: command('set_sending_limit', { postalAddress: POSTAL_ADDRESS }) });
    const firm = await enrollOnEmailStep(f.store, policy, { n: 1, startedAt: '2026-09-11T12:00:00.000Z' });
    await putDay(f.store, { date: '2026-09-18', builtAt: '2026-09-18T09:00:00.000Z', newFirmIds: [firm.firmId] });

    // The template is not approved, so the due step holds; the hold is recorded on the sequence.
    const gmail = gmailFetch({ send: ['accepted'] });
    const held = await runSendStepJob({ store: f.store, mailbox: mailboxAccess(), fetch: gmail.fetch },
      { jobId: sendStepJobId(firm.firmId, firm.stepId), firmId: firm.firmId, stepId: firm.stepId }, AbortSignal.timeout(5000));
    expect(held).toMatchObject({ outcome: 'held', code: 'template_not_approved' });
    const draftId = randomUUID();
    await f.request('POST', '/v1/commands', { authorization: bearer, body: command('request_followup', { firmId: firm.firmId, draftId }) });

    const view = todayViewSchema.parse(f.json(await f.request('GET', '/v1/today', { authorization: bearer })));
    expect(view.list).not.toBeNull();
    const card = view.list!.lanes.new.find(entry => entry.firmId === firm.firmId);
    expect(card?.pendingDraft).toMatchObject({ draftId, kind: 'followup', status: 'pending' });
    expect(card?.sequenceHold).toMatchObject({ reason: 'template_not_approved', code: 'template_not_approved', stepId: firm.stepId });

    const queue = recordingQueue();
    await runScheduler({ store: f.store, queue }, AbortSignal.timeout(5000));
    const diagnostics = diagnosticsViewSchema.parse(f.json(await f.request('GET', '/v1/diagnostics', { authorization: bearer })));
    expect(diagnostics.queue).toBeDefined();
    expect(diagnostics.queue!.queued).toBe(queue.sent.length);
    expect(diagnostics.queue!.deadLettered).toBe(0);
    expect(diagnostics.queue!.lastSchedulerRun).toMatchObject({ tickSeq: 1, enqueued: queue.sent.length });
  });

  it('answers a repeated command id from the receipt and refuses a different payload under the same id', async () => {
    const f = v1Fixture(START);
    const { bearer } = await f.pairDevice();
    const body = command('set_sending_limit', { postalAddress: POSTAL_ADDRESS, dailyLimit: 20 });
    expect(f.json(await f.request('POST', '/v1/commands', { authorization: bearer, body }))).toMatchObject({ outcome: 'applied' });
    expect(f.json(await f.request('POST', '/v1/commands', { authorization: bearer, body }))).toMatchObject({ outcome: 'duplicate' });
    expect(f.json(await f.request('POST', '/v1/commands', { authorization: bearer, body: { ...body, dailyLimit: 5 } })))
      .toMatchObject({ outcome: 'refused', reason: 'command_conflict' });
    expect((await readSendingSettings(f.store)).settings.dailyLimit).toBe(20);
  });
});
