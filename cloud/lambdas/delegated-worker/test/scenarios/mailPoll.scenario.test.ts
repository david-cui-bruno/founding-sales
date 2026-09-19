import { describe, expect, it } from 'vitest';
import { jobMessageId, pollJobId, sendStepJobId } from '../../src/queue/jobs';
import { applyReplyDecision, approveDraft, draftKey, draftRecordSchema, mailboxCursorSchema, MAILBOX_CURSOR_KEY, readDrafts, readMailboxCursor,
  readReplies, replyKey, replyRecordSchema, requestFollowup, runMailPollJob, type MailDependencies } from '../../src/v1/mail';
import { invalidRouteKey, runSendStepJob } from '../../src/v1/send';
import { seqKey, sequenceRecordSchema, suppressFirmKey, suppressHandleKey } from '../../src/v1/sequenceBridge';
import { gmailFetch, mailboxAccess, MAILBOX, sendWorkspace } from './sendFixtures';
import { v1Fixture } from './v1Fixture';

/**
 * `mail.poll` on the real handler and the real store adapter (FSS target design section 4; slice S3). Every Gmail
 * call goes through an injected fetch built here; the mailbox, the addresses and the message ids are fictional.
 *
 * The cases are the ones a morning depends on: the cursor advances, a reply is matched once across two polls,
 * "STOP" suppresses the whole set and stops the sequence, a bounce marks the route and drafts nothing, and an
 * ambiguous reply holds `replied` until David answers with `reply_decision`.
 */

const START = '2026-09-18T12:00:00.000Z';

type Message = { id: string; threadId: string; from: string; subject: string; body: string; references?: string[]; date?: string };

/** A Gmail mailbox the poller can read: a profile history id, one history page, and the messages behind it. */
function mailboxFetch(input: { historyId?: string; pages?: Message[][]; historyMissing?: boolean }): { fetch: typeof globalThis.fetch; calls: string[] } {
  const calls: string[] = [];
  const pages = input.pages ?? [];
  const all = new Map(pages.flat().map(message => [message.id, message]));
  const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  let historyPage = 0;
  const fetch: typeof globalThis.fetch = async (resource, init) => {
    const url = new URL(String(resource));
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
    if (url.pathname.endsWith('/profile')) return json(200, { historyId: input.historyId ?? '900' });
    if (url.pathname.endsWith('/history')) {
      if (input.historyMissing) return json(404, {});
      const page = pages[historyPage] ?? [];
      historyPage += 1;
      return json(200, { historyId: input.historyId ?? '900',
        history: page.length ? [{ messagesAdded: page.map(message => ({ message: { id: message.id } })) }] : [],
        ...(historyPage < pages.length ? { nextPageToken: `page-${historyPage}` } : {}) });
    }
    if (url.pathname.endsWith('/messages')) {
      const page = pages[historyPage] ?? [];
      historyPage += 1;
      return json(200, { messages: page.map(message => ({ id: message.id })), ...(historyPage < pages.length ? { nextPageToken: `page-${historyPage}` } : {}) });
    }
    const id = /\/messages\/([^/?]+)$/.exec(url.pathname)?.[1];
    const message = id ? all.get(id) : undefined;
    if (!message) return json(404, {});
    return json(200, { id: message.id, threadId: message.threadId, internalDate: String(Date.parse(message.date ?? START)),
      payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: message.from }, { name: 'To', value: MAILBOX },
        { name: 'Subject', value: message.subject }, { name: 'Message-ID', value: `<${message.id}@firm.invalid>` },
        ...(message.references?.length ? [{ name: 'References', value: message.references.join(' ') }] : [])],
      body: { data: Buffer.from(message.body).toString('base64url') } } });
  };
  return { fetch, calls };
}

const deps = (f: ReturnType<typeof v1Fixture>, fetch: typeof globalThis.fetch): MailDependencies => ({ store: f.store, mailbox: mailboxAccess(), fetch });
const POLL = { jobId: pollJobId(1) };

describe('mail.poll: replies are matched once and David decides what they mean', () => {
  it('scans once, records the cursor, and then reads from history', async () => {
    const f = v1Fixture(START);
    const { bearer } = await f.pairDevice();
    const firm = await sendWorkspace(f, bearer);
    const first = mailboxFetch({ historyId: '1000', pages: [[]] });
    await runMailPollJob(deps(f, first.fetch), POLL, AbortSignal.timeout(5000));
    const cursor = await readMailboxCursor(f.store);
    expect(cursor?.cursor).toMatchObject({ mailbox: MAILBOX, mode: 'history', historyId: '1000', pageToken: null });
    expect(first.calls.some(call => call.includes('/messages?') && call.includes(encodeURIComponent(firm.email)))).toBe(true);

    // The next poll uses the history id rather than the query, and advances the cursor's revision.
    const second = mailboxFetch({ historyId: '1200', pages: [[]] });
    await runMailPollJob(deps(f, second.fetch), { jobId: pollJobId(2) }, AbortSignal.timeout(5000));
    expect(second.calls.some(call => call.includes('/history?'))).toBe(true);
    const advanced = await readMailboxCursor(f.store);
    expect(advanced?.cursor.historyId).toBe('1200');
    expect(advanced!.cursor.revision).toBeGreaterThan(cursor!.cursor.revision);
  });

  it('matches a reply by the Message-ID the fence wrote, records it once across two polls, and holds the sequence', async () => {
    const f = v1Fixture(START);
    const { bearer } = await f.pairDevice();
    const firm = await sendWorkspace(f, bearer);
    const jobId = sendStepJobId(firm.firmId, firm.stepId);
    const gmail = gmailFetch({ send: ['accepted'] });
    await runSendStepJob({ store: f.store, mailbox: mailboxAccess(), fetch: gmail.fetch }, { jobId, firmId: firm.firmId, stepId: firm.stepId }, AbortSignal.timeout(5000));

    const reply: Message = { id: 'msg-reply-1', threadId: 'thread-1', from: `Office <${firm.email}>`, subject: 'Re: One question',
      body: 'Thanks, what does the integration process look like?', references: [jobMessageId(jobId)] };
    const mail = mailboxFetch({ pages: [[reply]] });
    const report = await runMailPollJob(deps(f, mail.fetch), POLL, AbortSignal.timeout(5000));
    expect(report).toMatchObject({ read: 1, matched: 1, recorded: 1 });

    const record = replyRecordSchema.parse(f.db.inspect(replyKey('msg-reply-1')));
    expect(record).toMatchObject({ firmId: firm.firmId, matchedBy: 'message_id', stepId: firm.stepId });
    expect(record.classification.kind).toBe('substantive');
    expect(sequenceRecordSchema.parse(f.db.inspect(seqKey(firm.firmId)))).toMatchObject({ state: 'paused', holdCode: 'replied' });
    // An unambiguous reply opens a pending draft; the worker writes no prose into it.
    const drafts = await readDrafts(f.store, firm.firmId);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ kind: 'reply', status: 'pending', text: null, to: firm.email });

    // The same message in a second poll is matched again but recorded once, and opens no second draft.
    const again = mailboxFetch({ pages: [[reply]] });
    const second = await runMailPollJob(deps(f, again.fetch), { jobId: pollJobId(2) }, AbortSignal.timeout(5000));
    expect(second).toMatchObject({ read: 1, matched: 1, recorded: 0 });
    expect(await readDrafts(f.store, firm.firmId)).toHaveLength(1);
    expect(await readReplies(f.store)).toHaveLength(1);
  });

  it('a whole message of STOP suppresses the firm and every known handle, and stops the sequence', async () => {
    const f = v1Fixture(START);
    const { bearer } = await f.pairDevice();
    const firm = await sendWorkspace(f, bearer);
    const mail = mailboxFetch({ pages: [[{ id: 'msg-stop', threadId: 'thread-2', from: firm.email, subject: 'Re: One question', body: 'STOP' }]] });
    const report = await runMailPollJob(deps(f, mail.fetch), POLL, AbortSignal.timeout(5000));
    expect(report).toMatchObject({ recorded: 1, optOuts: 1, drafts: 0 });

    expect(replyRecordSchema.parse(f.db.inspect(replyKey('msg-stop'))).classification.kind).toBe('opt_out');
    expect(f.db.inspect(suppressFirmKey(firm.firmId))).toMatchObject({ reason: 'opt_out', source: 'reply' });
    expect(f.db.inspect(suppressHandleKey(firm.email))).toMatchObject({ firmId: firm.firmId });
    expect(sequenceRecordSchema.parse(f.db.inspect(seqKey(firm.firmId)))).toMatchObject({ state: 'stopped', holdCode: 'opt_out' });
    expect(await readDrafts(f.store, firm.firmId)).toEqual([]);

    // Nothing is ever sent to a suppressed firm again.
    const gmail = gmailFetch({ send: ['accepted'] });
    const outcome = await runSendStepJob({ store: f.store, mailbox: mailboxAccess(), fetch: gmail.fetch },
      { jobId: sendStepJobId(firm.firmId, firm.stepId), firmId: firm.firmId, stepId: firm.stepId }, AbortSignal.timeout(5000));
    expect(outcome).toEqual({ outcome: 'held', code: 'suppressed', reason: 'suppressed' });
  });

  it('a bounce marks the route invalid and drafts nothing; the step then holds no_email', async () => {
    const f = v1Fixture(START);
    const { bearer } = await f.pairDevice();
    const firm = await sendWorkspace(f, bearer);
    const mail = mailboxFetch({ pages: [[{ id: 'msg-bounce', threadId: 'thread-3', from: firm.email, subject: 'Delivery Status Notification',
      body: 'Delivery failed: address not found.' }]] });
    const report = await runMailPollJob(deps(f, mail.fetch), POLL, AbortSignal.timeout(5000));
    expect(report).toMatchObject({ recorded: 1, bounces: 1, drafts: 0 });
    expect(f.db.inspect(invalidRouteKey(firm.firmId, firm.email))).toMatchObject({ reason: 'delivery_failure', handle: firm.email });
    expect(await readDrafts(f.store, firm.firmId)).toEqual([]);
    // The firm itself is not suppressed: a broken address is not a request to stop.
    expect(f.db.inspect(suppressFirmKey(firm.firmId))).toBeUndefined();

    const gmail = gmailFetch({ send: ['accepted'] });
    const outcome = await runSendStepJob({ store: f.store, mailbox: mailboxAccess(), fetch: gmail.fetch },
      { jobId: sendStepJobId(firm.firmId, firm.stepId), firmId: firm.firmId, stepId: firm.stepId }, AbortSignal.timeout(5000));
    expect(outcome).toEqual({ outcome: 'held', code: 'no_email', reason: 'no_email' });
  });

  it('an ambiguous reply holds replied and waits for reply_decision, which stops or resumes', async () => {
    const f = v1Fixture(START);
    const { bearer } = await f.pairDevice();
    const firm = await sendWorkspace(f, bearer);
    const mail = mailboxFetch({ pages: [[{ id: 'msg-ambiguous', threadId: 'thread-4', from: firm.email, subject: 'Re: One question', body: 'ok' }]] });
    await runMailPollJob(deps(f, mail.fetch), POLL, AbortSignal.timeout(5000));
    const record = replyRecordSchema.parse(f.db.inspect(replyKey('msg-ambiguous')));
    expect(record.classification.kind).toBe('ambiguous');
    expect(record.draftId).toBeNull();
    expect(await readDrafts(f.store, firm.firmId)).toEqual([]);
    expect(sequenceRecordSchema.parse(f.db.inspect(seqKey(firm.firmId)))).toMatchObject({ state: 'paused', holdCode: 'replied' });

    const stopped = await applyReplyDecision(deps(f, mail.fetch), { replyId: 'msg-ambiguous', decision: 'stop', recordedBy: 'David MacBook' });
    expect(stopped).toEqual({ applied: true, decision: 'stop' });
    expect(f.db.inspect(suppressFirmKey(firm.firmId))).toMatchObject({ reason: 'reply_stop' });
    expect(sequenceRecordSchema.parse(f.db.inspect(seqKey(firm.firmId)))).toMatchObject({ state: 'stopped' });
    // The decision is made once: a repeat is refused rather than suppressing twice.
    expect(await applyReplyDecision(deps(f, mail.fetch), { replyId: 'msg-ambiguous', decision: 'continue', recordedBy: 'David MacBook' }))
      .toEqual({ applied: false, reason: 'reply_already_decided' });
  });

  it('a continue decision clears the replied hold and leaves the step where it was', async () => {
    const f = v1Fixture(START);
    const { bearer } = await f.pairDevice();
    const firm = await sendWorkspace(f, bearer);
    const mail = mailboxFetch({ pages: [[{ id: 'msg-maybe', threadId: 'thread-5', from: firm.email, subject: 'Re: One question', body: 'sure' }]] });
    await runMailPollJob(deps(f, mail.fetch), POLL, AbortSignal.timeout(5000));
    expect(await applyReplyDecision(deps(f, mail.fetch), { replyId: 'msg-maybe', decision: 'continue', recordedBy: 'David MacBook' }))
      .toEqual({ applied: true, decision: 'continue' });
    const sequence = sequenceRecordSchema.parse(f.db.inspect(seqKey(firm.firmId)));
    expect(sequence).toMatchObject({ state: 'active', holdCode: null });
    expect(f.db.inspect(suppressFirmKey(firm.firmId))).toBeUndefined();
  });

  it('an out-of-office is recorded and ignored: no hold, no draft, no suppression', async () => {
    const f = v1Fixture(START);
    const { bearer } = await f.pairDevice();
    const firm = await sendWorkspace(f, bearer);
    const mail = mailboxFetch({ pages: [[{ id: 'msg-ooo', threadId: 'thread-6', from: firm.email, subject: 'Automatic reply',
      body: 'I am out of the office until Monday.' }]] });
    await runMailPollJob(deps(f, mail.fetch), POLL, AbortSignal.timeout(5000));
    const record = replyRecordSchema.parse(f.db.inspect(replyKey('msg-ooo')));
    expect(record.classification.kind).toBe('out_of_office');
    expect(record.resolvedAt).toBe(START);
    expect(f.db.inspect(seqKey(firm.firmId))).toBeUndefined();
    expect(await readDrafts(f.store, firm.firmId)).toEqual([]);
  });

  it('a message from nobody this workspace knows is never matched or recorded', async () => {
    const f = v1Fixture(START);
    const { bearer } = await f.pairDevice();
    await sendWorkspace(f, bearer);
    const mail = mailboxFetch({ pages: [[{ id: 'msg-stranger', threadId: 'thread-7', from: 'stranger@elsewhere.invalid', subject: 'Hello', body: 'Interested?' }]] });
    const report = await runMailPollJob(deps(f, mail.fetch), POLL, AbortSignal.timeout(5000));
    expect(report).toMatchObject({ read: 1, matched: 0, recorded: 0 });
    expect(await readReplies(f.store)).toEqual([]);
  });

  it('holds mailbox_not_connected without touching the cursor', async () => {
    const f = v1Fixture(START);
    const mail = mailboxFetch({ pages: [[]] });
    const report = await runMailPollJob({ store: f.store, mailbox: mailboxAccess({ connected: false, reason: 'mailbox_not_connected' }), fetch: mail.fetch },
      POLL, AbortSignal.timeout(5000));
    expect(report.held).toBe('mailbox_not_connected');
    expect(f.db.inspect(MAILBOX_CURSOR_KEY)).toBeUndefined();
    expect(mail.calls).toEqual([]);
  });

  it('a follow-up draft David writes and approves is queued for the same fence, and never sent by approving it', async () => {
    const f = v1Fixture(START);
    const { bearer } = await f.pairDevice();
    const firm = await sendWorkspace(f, bearer);
    const mail = mailboxFetch({ pages: [[]] });
    const requested = await requestFollowup(deps(f, mail.fetch), { firmId: firm.firmId, draftId: 'draft-1' });
    expect(requested).toMatchObject({ applied: true, draft: { status: 'pending', text: null, to: firm.email } });

    const queued: { firmId: string; draftId: string }[] = [];
    const approved = await approveDraft({ ...deps(f, mail.fetch), enqueue: async job => { queued.push(job); } },
      { firmId: firm.firmId, draftId: 'draft-1', text: 'A short note David wrote.' });
    expect(approved).toMatchObject({ applied: true, draft: { status: 'approved', text: 'A short note David wrote.' } });
    expect(queued).toEqual([{ firmId: firm.firmId, draftId: 'draft-1' }]);
    expect(draftRecordSchema.parse(f.db.inspect(draftKey(firm.firmId, 'draft-1'))).status).toBe('approved');

    // Approving twice enqueues once.
    await approveDraft({ ...deps(f, mail.fetch), enqueue: async job => { queued.push(job); } },
      { firmId: firm.firmId, draftId: 'draft-1', text: 'A short note David wrote.' });
    expect(queued).toHaveLength(1);
  });

  it('a cursor for another mailbox is never carried over', async () => {
    const f = v1Fixture(START);
    const { bearer } = await f.pairDevice();
    await sendWorkspace(f, bearer);
    await f.store.transact([f.store.put(MAILBOX_CURSOR_KEY, mailboxCursorSchema.parse({ version: 1, mailbox: 'someone.else@usecallie.invalid',
      mode: 'history', historyId: '1', pageToken: null, since: START, revision: 1, updatedAt: START }), null)]);
    const mail = mailboxFetch({ historyId: '4242', pages: [[]] });
    await runMailPollJob(deps(f, mail.fetch), POLL, AbortSignal.timeout(5000));
    const cursor = await readMailboxCursor(f.store);
    expect(cursor?.cursor.mailbox).toBe(MAILBOX);
    expect(cursor?.cursor.historyId).toBe('4242');
  });
});
