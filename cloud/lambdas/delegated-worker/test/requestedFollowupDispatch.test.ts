import { expect, it } from 'vitest';
import { requestedCapturedFixture, materializeRequested } from './requestedFollowupFixture';
import { createDispatchService } from '../src/dispatchService';
import { createSendReconciler } from '../src/sendReconciler';
import { requestedApprovalKey } from '../src/requestedFollowupApproval';
import { dispatchApprovalKey, dispatchPermissionKey } from '../src/dispatchRepository';
import { requestedFollowupDraftKey } from '../src/requestedFollowupRepository';
import { mailCursorKey } from '../src/threadIntakeRepository';

async function setup(ownerSupplied = false) {
  const f = await requestedCapturedFixture(ownerSupplied); const intent = await materializeRequested(f);
  const sends: { raw: string; threadId?: string }[] = []; let sendResult: () => Promise<Response> = async () => Response.json({ id: 'first-sent', threadId: 'first-thread' });
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith('/history')) return Response.json({ history: [], historyId: '2' });
    if (parsed.pathname.endsWith('/messages/send')) { sends.push(JSON.parse(String(init?.body))); return sendResult(); }
    throw new Error('unconfigured fictional HTTP');
  };
  const service = () => createDispatchService({ policy: f.policy, execution: f.execution, authorization: f.authorization, fetch });
  return { ...f, intent, sends, fetch, service, onSend: (fn: () => Promise<Response>) => { sendResult = fn; } };
}
it.each([false, true])('actual individually approved first email ownerSupplied=%s uses one existing sender without reply headers', async ownerSupplied => {
  const f = await setup(ownerSupplied);
  expect(await f.store.list('MAIL_THREAD#')).toHaveLength(0);
  expect(await f.service().dispatch(f.intent.commandId)).toMatchObject({ status: 'provider_accepted', providerIdentity: { messageId: 'first-sent', threadId: 'first-thread' } });
  expect(f.sends).toHaveLength(1); expect(f.sends[0]!.threadId).toBeUndefined();
  const mime = Buffer.from(f.sends[0]!.raw, 'base64url').toString('utf8');
  expect(mime).not.toMatch(/^(In-Reply-To|References):/m); expect(mime).toContain(`Message-ID: <${f.intent.commandId}@callie.invalid>`);
  expect(await f.store.list('MAIL_THREAD#')).toHaveLength(0);
  expect(f.dynamo.inspect('CAMPAIGN_CAP#call-version#email')).toEqual({ reserved: 0, sent: 0 });
  await f.service().dispatch(f.intent.commandId); expect(f.sends).toHaveLength(1);
});
it('two first-email clients cannot send twice', async () => {
  const f = await setup(); await Promise.all([f.service().dispatch(f.intent.commandId), f.service().dispatch(f.intent.commandId)]);
  expect(f.sends).toHaveLength(1);
});
function firstRaw(f: Awaited<ReturnType<typeof setup>>, headers: { name: string; value: string }[] = []) {
  const message = f.intent.frozenMessage; const body = Buffer.from(message.body);
  return { id: 'first-sent', threadId: 'first-thread', labelIds: ['SENT'], internalDate: String(Date.parse(f.options.clock.now())), payload: { mimeType: 'text/plain', headers: [
    { name: 'From', value: message.from }, { name: 'To', value: message.to }, { name: 'Subject', value: message.subject }, { name: 'Message-ID', value: `<${message.commandId}@callie.invalid>` },
    { name: 'MIME-Version', value: '1.0' }, { name: 'Content-Type', value: 'text/plain; charset=UTF-8' }, { name: 'Content-Transfer-Encoding', value: 'base64' }, ...headers,
  ], body: { data: body.toString('base64url'), size: body.length } } };
}
it.each(['exact', 'In-Reply-To', 'References', 'Bcc', 'absent', 'ambiguous'] as const)('unknown first-email Sent lookup %s never resends', async variant => {
  const f = await setup(); f.onSend(async () => { throw new Error('lost provider response'); });
  expect((await f.service().dispatch(f.intent.commandId)).status).toBe('unknown');
  const fetch: typeof globalThis.fetch = async url => new URL(String(url)).pathname.endsWith('/messages')
    ? Response.json({ messages: variant === 'absent' ? [] : variant === 'ambiguous' ? [{ id: 'first-sent' }, { id: 'other' }] : [{ id: 'first-sent' }] })
    : Response.json(firstRaw(f, ['In-Reply-To', 'References', 'Bcc'].includes(variant) ? [{ name: variant, value: variant === 'Bcc' ? 'extra@example.invalid' : '<foreign@example.invalid>' }] : []));
  const result = await createSendReconciler({ policy: f.policy, execution: f.execution, authorization: f.authorization, fetch }).reconcileSend(f.intent.commandId);
  expect(result.status).toBe(variant === 'exact' ? 'provider_accepted' : 'unknown');
  await f.service().dispatch(f.intent.commandId); expect(f.sends).toHaveLength(1);
});
it.each(['pending', 'draft', 'permission', 'approval', 'scope', 'account', 'grant', 'pairing', 'source'] as const)('final first-email reservation checks actual %s revision', async changed => {
  const f = await setup(); const access = await f.authorization.authorizedAccess(f.pairing.pairingId, ['send', 'relevant_read']);
  const plan = await f.policy.reservationPlan({ ...f.intent.action, expectedVersion: await f.execution.currentVersion('acct') }, access.accessEvidence);
  const keys = { pending: requestedApprovalKey(f.command.commandId), draft: requestedFollowupDraftKey('acct', f.draft.id), permission: dispatchPermissionKey('acct', `phone-request-${f.command.commandId}`),
    approval: dispatchApprovalKey('requested-approval'), scope: mailCursorKey('acct', 'mailbox'), account: 'ACCOUNT#acct', grant: `GOOGLE_GRANT#${f.pairing.pairingId}`, pairing: `PAIRING#${f.pairing.pairingId}`, source: 'OWNER_SOURCE#acct' };
  const key = keys[changed]; const row = await f.store.get(key); expect(row).not.toBeNull();
  await f.store.transact([f.store.put(key, row!.data, row!.rev)]);
  await expect(f.store.transact(plan.finalize())).rejects.toThrow(); expect(f.sends).toHaveLength(0);
});
it.each(['exact', 'foreign-reference', 'foreign-participant', 'unknown', 'conflict'] as const)('links only actual accepted first email to real inbound projection: %s', async variant => {
  const f = await setup(); if (variant === 'unknown') f.onSend(async () => { throw new Error('lost'); });
  await f.service().dispatch(f.intent.commandId);
  const checkpoint = (await f.threads.checkpoint('acct', 'mailbox'))!;
  await f.threads.beginPoll('acct', 'mailbox', 'reply-poll');
  await f.threads.applyPage({ complete: true, nextCursor: { ...checkpoint, historyId: '3' }, threads: [{ accountId: 'acct', mailboxSubject: 'mailbox', provider: 'gmail', providerThreadId: 'first-thread', messages: [{
    id: 'incoming', threadId: 'first-thread', rfcMessageId: '<incoming@example.invalid>', references: [variant === 'foreign-reference' ? '<foreign@example.invalid>' : `<${f.intent.commandId}@callie.invalid>`],
    from: [variant === 'foreign-participant' ? 'foreign@example.invalid' : f.intent.frozenMessage.to], to: [f.intent.frozenMessage.from], cc: [], date: f.options.clock.now(), subject: 'Re: requested information', bodyParts: [{ mimeType: 'text/plain', text: 'Please explain the details', truncated: false }],
  }] }] }, checkpoint, 'reply-poll');
  if (variant === 'conflict') await f.store.transact([f.store.put('DISPATCH_CONFLICT#acct', { accountId: 'acct' }, null)]);
  const linked = await f.policy.requestedReplyAssociation(f.intent.commandId, 'first-thread');
  if (variant !== 'exact') expect(linked).toBeNull(); else {
    expect(linked).toMatchObject({ commandId: f.intent.commandId, providerMessageId: 'first-sent', threadId: 'first-thread', inboundMessageId: 'incoming' });
    await f.store.transact(linked!.checks);
    await f.store.transact([f.store.put('DISPATCH_CONFLICT#acct', { accountId: 'acct' }, null)]);
    await expect(f.store.transact(linked!.checks)).rejects.toThrow();
  }
  expect(f.sends).toHaveLength(1);
});
