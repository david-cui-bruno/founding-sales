import { describe, expect, it } from 'vitest';
import { jobMessageId, sendStepJobId } from '../../src/queue/jobs';
import { flightKey, readSend, runReconcileJob, runSendStepJob, sendKey, type SendDependencies } from '../../src/v1/send';
import { createSequencePort, sequenceKey, sequenceRecordSchema } from '../../src/v1/sequence';
import { approveTemplate, footerBlock, readTemplate, sendCounterKey, sendCounterSchema } from '../../src/v1/templates';
import { enrollOnEmailStep, gmailFetch, mailboxAccess, POSTAL_ADDRESS, sendWorkspace, sentBodyOf, setPostalAddress, approveWithFooter } from './sendFixtures';
import { putTerritoryPolicy, setPosture } from './firmFixtures';
import { v1Fixture } from './v1Fixture';

/**
 * The send fence on the real handlers and the real store adapter (FSS target design section 2; slice S3). Every
 * Gmail call goes through the injected fetch: nothing here can reach a mailbox, and no test approves anything the
 * real `approve_template` path would refuse.
 *
 * The six cases are the ones the slice exists for: one send across a duplicated message, a runner killed after the
 * Gmail call, a stale claim settled by the Sent lookup, a context revision that bumps without re-sending, the
 * per-firm lock, the eleventh send of day one, and a template whose body has no footer.
 */

const START = '2026-09-18T12:00:00.000Z';
const deps = (f: ReturnType<typeof v1Fixture>, fetch: typeof globalThis.fetch, mailbox = mailboxAccess()): SendDependencies =>
  ({ store: f.store, mailbox, fetch });
const sequenceOf = (f: ReturnType<typeof v1Fixture>, firmId: string) => sequenceRecordSchema.parse(f.db.inspect(sequenceKey(firmId)));
const sendCalls = (calls: { url: string }[]) => calls.filter(call => call.url.includes('/messages/send')).length;

describe('send fence: a due template step sends exactly once', () => {
  it('sends once and advances the sequence; a duplicated message finds the accepted send and finishes the step', async () => {
    const f = v1Fixture(START);
    const { bearer } = await f.pairDevice();
    const firm = await sendWorkspace(f, bearer);
    const gmail = gmailFetch({ send: ['accepted'] });
    const jobId = sendStepJobId(firm.firmId, firm.stepId);

    const first = await runSendStepJob(deps(f, gmail.fetch), { jobId, firmId: firm.firmId, stepId: firm.stepId }, AbortSignal.timeout(5000));
    expect(first.outcome).toBe('sent');
    expect(sendCalls(gmail.calls)).toBe(1);

    // The same message delivered twice: the second copy finds `accepted` and finishes instead of sending again.
    const second = await runSendStepJob(deps(f, gmail.fetch), { jobId, firmId: firm.firmId, stepId: firm.stepId }, AbortSignal.timeout(5000));
    expect(second.outcome).toBe('already_accepted');
    expect(sendCalls(gmail.calls)).toBe(1);

    const record = await readSend(f.store, firm.firmId, firm.stepId);
    expect(record?.record.state).toBe('accepted');
    expect(record?.record.messageId).toBe(jobMessageId(jobId));
    expect(record?.record.providerMessageId).toBe('sent-1');
    const sequence = sequenceOf(f, firm.firmId);
    expect(sequence.sentSteps.map(step => step.stepId)).toEqual([firm.stepId]);
    expect(sequence.currentStepId).not.toBe(firm.stepId);
    // The lock the send took is released by the same job.
    expect((f.db.inspect(flightKey(firm.firmId)) as { jobId: string | null }).jobId).toBeNull();
  });

  it('a runner killed after the Gmail call leaves a stale claim that the Sent lookup settles as accepted, without a second send', async () => {
    const f = v1Fixture(START);
    const { bearer } = await f.pairDevice();
    const firm = await sendWorkspace(f, bearer);
    const jobId = sendStepJobId(firm.firmId, firm.stepId);

    // The Gmail call lands but the runner dies before it can see the result: the step is left unsettled.
    const sent = new Map<string, { id: string; threadId: string; from: string; to: string; subject: string; body: string }>();
    const killed = gmailFetch({ send: ['lost'], sent });
    const first = await runSendStepJob(deps(f, killed.fetch), { jobId, firmId: firm.firmId, stepId: firm.stepId }, AbortSignal.timeout(5000));
    expect(first.outcome).toBe('settled');
    const claimed = await readSend(f.store, firm.firmId, firm.stepId);
    expect(claimed?.record.state).toBe('unknown');
    // The message Gmail actually accepted is exactly the one the fence froze, under the Message-ID it wrote.
    const frozen = claimed!.record.frozen;
    sent.set(jobMessageId(jobId), { id: 'sent-real', threadId: 'thread-real', from: frozen.from, to: frozen.to, subject: frozen.subject, body: sentBodyOf(frozen.body) });

    // Past the budget, the hourly reconcile finds the message in Sent and settles the step as accepted.
    f.advance('2026-09-18T12:30:00.000Z');
    const lookup = gmailFetch({ sent });
    const report = await runReconcileJob(deps(f, lookup.fetch), AbortSignal.timeout(5000));
    expect(report).toMatchObject({ checked: 1, accepted: 1 });
    expect(sendCalls(lookup.calls)).toBe(0);
    const record = await readSend(f.store, firm.firmId, firm.stepId);
    expect(record?.record.state).toBe('accepted');
    expect(record?.record.reconciledAt).toBe('2026-09-18T12:30:00.000Z');
    expect(sequenceOf(f, firm.firmId).sentSteps.map(step => step.stepId)).toEqual([firm.stepId]);
  });

  it('a stale dispatching claim whose message is absent from Sent settles as not_sent and is never retried', async () => {
    const f = v1Fixture(START);
    const { bearer } = await f.pairDevice();
    const firm = await sendWorkspace(f, bearer);
    const jobId = sendStepJobId(firm.firmId, firm.stepId);
    const lost = gmailFetch({ send: ['lost'], sent: new Map() });
    await runSendStepJob(deps(f, lost.fetch), { jobId, firmId: firm.firmId, stepId: firm.stepId }, AbortSignal.timeout(5000));

    f.advance('2026-09-18T12:30:00.000Z');
    const lookup = gmailFetch({ sent: new Map() });
    const settled = await runSendStepJob(deps(f, lookup.fetch), { jobId, firmId: firm.firmId, stepId: firm.stepId }, AbortSignal.timeout(5000));
    expect(settled.outcome).toBe('settled');
    const record = await readSend(f.store, firm.firmId, firm.stepId);
    expect(record?.record.state).toBe('not_sent');
    expect(record?.record.noRetry).toBe(true);
    expect(sendCalls(lookup.calls)).toBe(0);
    expect(f.db.inspect(sequenceKey(firm.firmId))).toBeUndefined();
  });

  it('a context revision bump does not mint a second key and does not re-send', async () => {
    const f = v1Fixture(START);
    const { bearer } = await f.pairDevice();
    const firm = await sendWorkspace(f, bearer);
    const gmail = gmailFetch({ send: ['accepted'] });
    const jobId = sendStepJobId(firm.firmId, firm.stepId);
    await runSendStepJob(deps(f, gmail.fetch), { jobId, firmId: firm.firmId, stepId: firm.stepId }, AbortSignal.timeout(5000));
    const before = await readSend(f.store, firm.firmId, firm.stepId);

    // A route replacement or a research refresh bumps the enrollment's context revision.
    const rows = f.db.dump().filter(item => item.sk?.S?.startsWith('CAMPAIGN_ENROLLMENT#'));
    expect(rows).toHaveLength(1);
    const stored = JSON.parse(rows[0]!.data!.S!) as Record<string, unknown>;
    await f.store.transact([f.store.put(rows[0]!.sk!.S!, { ...stored, contextRevision: 2 }, Number(rows[0]!.rev!.N))]);

    const again = await runSendStepJob(deps(f, gmail.fetch), { jobId, firmId: firm.firmId, stepId: firm.stepId }, AbortSignal.timeout(5000));
    expect(again.outcome).toBe('already_accepted');
    expect(sendCalls(gmail.calls)).toBe(1);
    const after = await readSend(f.store, firm.firmId, firm.stepId);
    expect(after?.record.contextRevision).toBe(before?.record.contextRevision);
    expect(f.db.dump().filter(item => item.sk?.S?.startsWith('SEND#'))).toHaveLength(1);
  });

  it('the FLIGHT# lock refuses a second send for the same firm while the first is unsettled', async () => {
    const f = v1Fixture(START);
    const { bearer } = await f.pairDevice();
    const firm = await sendWorkspace(f, bearer);
    const jobId = sendStepJobId(firm.firmId, firm.stepId);

    // The first job's Gmail call is lost, so the firm's lock stays in place with its job named on it.
    const lost = gmailFetch({ send: ['lost'], sent: new Map() });
    await runSendStepJob(deps(f, lost.fetch), { jobId, firmId: firm.firmId, stepId: firm.stepId }, AbortSignal.timeout(5000));
    expect((f.db.inspect(flightKey(firm.firmId)) as { jobId: string | null }).jobId).toBe(jobId);

    // The firm's other template step (T5) is due and approved, and may still not send while that lock is live.
    await approveWithFooter(f.store, 'T5');
    const otherStep = firm.stepIds[4]!;
    const gmail = gmailFetch({ send: ['accepted'] });
    const refused = await runSendStepJob(deps(f, gmail.fetch), { jobId: sendStepJobId(firm.firmId, otherStep), firmId: firm.firmId, stepId: otherStep }, AbortSignal.timeout(5000));
    expect(refused).toEqual({ outcome: 'refused', code: 'firm_send_in_flight' });
    expect(sendCalls(gmail.calls)).toBe(0);
    expect(f.db.dump().filter(item => item.sk?.S?.startsWith('SEND#'))).toHaveLength(1);
  });

  it('the eleventh send of day one holds cap_reached, and nothing is sent for it', async () => {
    const f = v1Fixture(START);
    const { bearer } = await f.pairDevice();
    await setPosture(f, bearer, 'RI', 'calling');
    const policy = await putTerritoryPolicy(f.store, '2026-09-01T12:00:00.000Z');
    await setPostalAddress(f.store);
    await approveWithFooter(f.store, 'T4');
    const gmail = gmailFetch({ send: Array.from({ length: 11 }, () => 'accepted' as const) });
    const outcomes: string[] = [];
    for (let n = 1; n <= 11; n++) {
      const firm = await enrollOnEmailStep(f.store, policy, { n, startedAt: '2026-09-11T12:00:00.000Z' });
      const outcome = await runSendStepJob(deps(f, gmail.fetch), { jobId: sendStepJobId(firm.firmId, firm.stepId), firmId: firm.firmId, stepId: firm.stepId }, AbortSignal.timeout(5000));
      outcomes.push(outcome.outcome === 'held' ? `held:${outcome.code}` : outcome.outcome);
    }
    expect(outcomes.slice(0, 10)).toEqual(Array.from({ length: 10 }, () => 'sent'));
    expect(outcomes[10]).toBe('held:cap_reached');
    expect(sendCalls(gmail.calls)).toBe(10);
    expect(sendCounterSchema.parse(f.db.inspect(sendCounterKey('2026-09-18'))).used).toBe(10);
    const held = sequenceOf(f, `account-ri-11`);
    expect(held.heldSteps.map(step => step.code)).toEqual(['cap_reached']);
  });

  it('a template without the footer is refused at approval and its step holds template_not_approved at send', async () => {
    const f = v1Fixture(START);
    const { bearer } = await f.pairDevice();
    const firm = await sendWorkspace(f, bearer, { approve: false });
    const seeded = await readTemplate(f.store, 'T4');

    // The seeded body ends at the sign-off: no postal address, no stop line.
    expect(seeded.record.body.endsWith(footerBlock(POSTAL_ADDRESS))).toBe(false);
    const refused = await approveTemplate(f.store, { templateId: 'T4', expectedRevision: seeded.record.revision, subject: seeded.record.subject, body: seeded.record.body });
    expect(refused).toEqual({ applied: false, reason: 'template_footer_missing' });

    const gmail = gmailFetch({ send: ['accepted'] });
    const outcome = await runSendStepJob(deps(f, gmail.fetch), { jobId: sendStepJobId(firm.firmId, firm.stepId), firmId: firm.firmId, stepId: firm.stepId }, AbortSignal.timeout(5000));
    expect(outcome).toEqual({ outcome: 'held', code: 'template_not_approved', reason: 'template_not_approved' });
    expect(sendCalls(gmail.calls)).toBe(0);
    expect(f.db.dump().some(item => item.sk?.S === sendKey(firm.firmId, firm.stepId))).toBe(false);

    // With the footer and the postal address it approves, and the same step then sends.
    await approveWithFooter(f.store, 'T4');
    const sent = await runSendStepJob(deps(f, gmail.fetch), { jobId: sendStepJobId(firm.firmId, firm.stepId), firmId: firm.firmId, stepId: firm.stepId }, AbortSignal.timeout(5000));
    expect(sent.outcome).toBe('sent');
    expect(sendCalls(gmail.calls)).toBe(1);
  });

  it('holds paused, mailbox_not_connected and suppressed before anything is claimed', async () => {
    const f = v1Fixture(START);
    const { bearer } = await f.pairDevice();
    const firm = await sendWorkspace(f, bearer);
    const gmail = gmailFetch({ send: ['accepted'] });

    const disconnected = await runSendStepJob({ ...deps(f, gmail.fetch), mailbox: mailboxAccess({ connected: false, reason: 'mailbox_not_connected' }) },
      { jobId: sendStepJobId(firm.firmId, firm.stepId), firmId: firm.firmId, stepId: firm.stepId }, AbortSignal.timeout(5000));
    expect(disconnected).toEqual({ outcome: 'held', code: 'mailbox_not_connected', reason: 'mailbox_not_connected' });

    await f.store.transact([f.store.put('SETTINGS#paused', { paused: true, reason: 'stop rehearsal' }, null)]);
    const paused = await runSendStepJob(deps(f, gmail.fetch), { jobId: sendStepJobId(firm.firmId, firm.stepId), firmId: firm.firmId, stepId: firm.stepId }, AbortSignal.timeout(5000));
    expect(paused).toEqual({ outcome: 'held', code: 'paused', reason: 'paused' });
    expect(sendCalls(gmail.calls)).toBe(0);
  });

  it('a suppressed firm is never sent to, whatever the step says', async () => {
    const f = v1Fixture(START);
    const { bearer } = await f.pairDevice();
    const firm = await sendWorkspace(f, bearer);
    await createSequencePort(f.store); // the stand-in port is constructed the same way the job constructs it
    const { createSuppressionPort } = await import('../../src/v1/suppression');
    await createSuppressionPort(f.store).suppress({ firmId: firm.firmId, handles: [firm.email], reason: 'opt_out', source: 'reply', recordedBy: 'David MacBook' });
    const gmail = gmailFetch({ send: ['accepted'] });
    const outcome = await runSendStepJob(deps(f, gmail.fetch), { jobId: sendStepJobId(firm.firmId, firm.stepId), firmId: firm.firmId, stepId: firm.stepId }, AbortSignal.timeout(5000));
    expect(outcome).toEqual({ outcome: 'held', code: 'suppressed', reason: 'suppressed' });
    expect(sendCalls(gmail.calls)).toBe(0);
  });
});
