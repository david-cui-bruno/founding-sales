import { fixture, dispatchFixture, campaignFixture } from './dispatchFixture';
import { ownerSourceKey, type OwnerSourceConfiguration } from '../../../../src/shared/contracts/ownerCommandContract';
import { describe, expect, it, vi } from 'vitest';
import { dispatchIntentKey, dispatchApprovalKey, dispatchPermissionKey, dispatchCapPolicyKey, type DispatchIntent, type SendEvidence } from '../src/dispatchRepository';
import { fingerprint } from '../src/dynamoStore';
import { DynamoThreadIntakeRepository, mailThreadKey, mailCursorKey } from '../src/threadIntakeRepository';
import { intakeRegistryKey } from '../src/intakeBarrier';


describe('actual persisted dispatch reservation plan', () => {
  it('produces exact draft/approval/permission/intake/suppression/grant and cap Dynamo conditions', async () => {
    const f = await fixture(); const input = { ...f.intent.action, expectedVersion: 2 };
    const plan = await f.policy.reservationPlan(input, f.access.accessEvidence);
    const items = plan.finalize();
    const keys = items.map(item => item.ConditionCheck?.Key?.sk?.S ?? item.Put?.Item?.sk?.S);
    expect(keys).toContain(dispatchIntentKey(f.intent.commandId));
    expect(keys.filter(key => key === ownerSourceKey('acct'))).toHaveLength(1);
    expect(keys).toContain(dispatchApprovalKey('approval'));
    expect(keys).toContain(dispatchPermissionKey('acct', 'permission'));
    expect(keys).toContain('MAIL_DRAFT#acct#draft');
    expect(keys).toContain('MAIL_THREAD#acct#thread1');
    expect(keys).toContain('MAIL_CURSOR#acct#mailbox');
    expect(keys).toContain('MAIL_SUPPRESSION#acct');
    expect(keys).toContain(`GOOGLE_GRANT#${f.intent.pairingId}`);
    expect(new Set(keys).size).toBe(keys.length);
    await f.store.transact(items);
    expect(f.dynamo.inspect(`DISPATCH_CAP#sender%40example.invalid#2026-09-09`)).toEqual({ sender: f.draft.sender, day: '2026-09-09', used: 1 });
  });
  it.each(['approval', 'permission', 'draft', 'thread', 'caps', 'suppression'])('rejects changed or revoked %s before send reservation', async changed => {
    const f = await fixture();
    if (changed === 'approval') await f.policy.revokeApproval('approval');
    if (changed === 'permission') await f.policy.revokePermission('acct', 'permission');
    if (changed === 'draft') await f.store.transact([f.store.put('MAIL_DRAFT#acct#draft', { ...f.draft, body: 'Unapproved edit', revision: 2 }, 1)]);
    if (changed === 'thread') await f.store.transact([f.store.put(mailThreadKey('acct', 'thread1'), { thread: { accountId: 'acct', mailboxSubject: 'mailbox', provider: 'gmail', providerThreadId: 'thread1', messages: [f.message] }, revision: 2, contextRevision: 'context2', signals: [] }, 1)]);
    if (changed === 'caps') await f.policy.configureCaps({ sender: f.draft.sender, dailyLimit: 0 }, 1);
    if (changed === 'suppression') await f.store.transact([f.store.put('MAIL_SUPPRESSION#acct', { reason: 'opt_out' }, null)]);
    await expect(f.policy.reservationPlan({ ...f.intent.action, expectedVersion: 2 }, f.access.accessEvidence)).rejects.toThrow();
  });
  it('rechecks time after async reads and never grants expired approval or intake', async () => {
    const f = await fixture(); const plan = await f.policy.reservationPlan({ ...f.intent.action, expectedVersion: 2 }, f.access.accessEvidence);
    f.advance('2026-09-09T00:09:00.000Z');
    expect(() => plan.finalize()).toThrow('dispatch_evidence_expired');
  });
  it('approval identity cannot be edited or unrevoked by re-admission', async () => {
    const f = await fixture();
    await expect(f.policy.admitApproval({ ...f.approval, expiresAt: '2026-09-11T00:00:00.000Z' })).rejects.toThrow();
    await f.policy.revokeApproval('approval');
    await expect(f.policy.admitApproval(f.approval)).rejects.toThrow();
  });
  it('missing configured cap or invented campaign binding cannot grant permission', async () => {
    const f = await fixture();
    expect(dispatchCapPolicyKey(f.draft.sender)).toBe('DISPATCH_CAP_POLICY#sender%40example.invalid');
    const campaign = { ...f.intent, kind: 'campaign_step' as const, campaign: { campaignId: 'campaign', campaignRevision: 1, enrollmentId: 'enrollment', enrollmentRevision: 1, stepId: 'step' } };
    const hash = fingerprint(campaign);
    await f.store.transact([f.store.put(dispatchIntentKey(f.intent.commandId), campaign, 1), f.store.put(dispatchApprovalKey('approval'), { ...f.approval, intentHash: hash }, 1)]);
    await expect(f.policy.reservationPlan({ ...f.intent.action, expectedVersion: 2 }, f.access.accessEvidence)).rejects.toThrow('campaign_binding_unavailable');
  });
});

// End-to-end worker service through actual C1/C2/C3 code and fictional HTTP only.
import { createExecutionRepository } from '../src/executionRepository';
import { createDispatchService } from '../src/dispatchService';
import { createSendReconciler } from '../src/sendReconciler';
it('missing policy fails closed in actual C1 reserve, prepare is not permission', async () => {
  const f = await dispatchFixture();
  const unsafe = createExecutionRepository(f.options);
  await expect(unsafe.reserveDispatch({ ...f.intent.action, expectedVersion: 2 })).rejects.toThrow('dispatch_policy_missing');
});
it('one dispatch invocation sends once and duplicate command never sends again', async () => {
  const f = await dispatchFixture();
  expect(await f.service().dispatch(f.intent.commandId)).toMatchObject({ status: 'provider_accepted', providerIdentity: { messageId: 'sent1', threadId: 'thread1' } });
  await f.service().dispatch(f.intent.commandId);
  expect(f.sends()).toBe(1);
  const transactions = f.dynamo.transactions.filter(tx => tx.TransactItems?.some(item => item.Put?.Item?.sk?.S === 'ACTION#acct#action' && item.Put.Item.state?.S === 'dispatching'));
  expect(transactions).toHaveLength(1);
  const reservation = transactions[0]!;
  const keys = reservation.TransactItems!.map(item => item.Put?.Item?.sk?.S ?? item.ConditionCheck?.Key?.sk?.S);
  expect(keys).toContain('MAIL_CURSOR#acct#mailbox');
  expect(keys).toContain(`GOOGLE_GRANT#${f.intent.pairingId}`);
  expect(keys).toContain('DISPATCH_CAP#sender%40example.invalid#2026-09-09');
});
it('pause during token preparation yields zero sends', async () => {
  const f = await dispatchFixture(); const original = f.authorization.authorizedAccess.bind(f.authorization);
  vi.spyOn(f.authorization, 'authorizedAccess').mockImplementation(async (...args) => {
    const access = await original(...args);
    if (args[1].includes('send')) await f.execution.applyCommand({ commandId: 'pause', workspaceId: 'ws', accountId: 'acct', expectedAuthorityGeneration: 1, expectedVersion: await f.execution.currentVersion('acct'), kind: 'pause', payload: { reason: 'operator pause' } });
    return access;
  });
  expect((await f.service().dispatch(f.intent.commandId)).status).toBe('held');
  expect(f.sends()).toBe(0);
});
it('late provider acceptance after pause preserves paused authority and durable evidence', async () => {
  const f = await dispatchFixture();
  f.onSend(async () => {
    await f.execution.applyCommand({ commandId: 'pause', workspaceId: 'ws', accountId: 'acct', expectedAuthorityGeneration: 1, expectedVersion: await f.execution.currentVersion('acct'), kind: 'pause', payload: { reason: 'operator pause' } });
    return Response.json({ id: 'sent1', threadId: 'thread1' });
  });
  expect((await f.service().dispatch(f.intent.commandId)).status).toBe('provider_accepted');
  expect(f.dynamo.inspect('AUTH#acct')).toMatchObject({ authority: { state: 'paused' } });
  const evidence = await f.policy.sendEvidence(f.intent.commandId);
  expect(evidence).toHaveLength(1);
  expect(evidence[0]).toMatchObject({ state: 'provider_accepted', providerIdentity: { messageId: 'sent1' } });
});
it('ambiguous committed reservation crash remains unknown after restart without sending', async () => {
  const f = await dispatchFixture();
  const reserve = f.execution.reserveDispatch.bind(f.execution);
  vi.spyOn(f.execution, 'reserveDispatch').mockImplementation(async (...args) => { await reserve(...args); throw new Error('lost reservation response'); });
  expect((await f.service().dispatch(f.intent.commandId)).status).toBe('unknown');
  expect((await f.service().dispatch(f.intent.commandId)).status).toBe('unknown');
  expect(f.sends()).toBe(0);
});
it('timeout and absent Sent result retain reservation, caps and original unknown evidence', async () => {
  const f = await dispatchFixture(); f.onSend(async () => { throw new Error('timeout'); });
  expect((await f.service().dispatch(f.intent.commandId)).status).toBe('unknown');
  const lookupFetch: typeof globalThis.fetch = async url => {
    expect(new URL(String(url)).searchParams.get('q')).toBe(`in:sent rfc822msgid:${f.intent.commandId}@callie.invalid`);
    return Response.json({ messages: [] });
  };
  const reconciler = createSendReconciler({ execution: f.execution, policy: f.policy, authorization: f.authorization, fetch: lookupFetch });
  expect((await reconciler.reconcileSend(f.intent.commandId)).status).toBe('unknown');
  await f.service().dispatch(f.intent.commandId);
  expect(f.sends()).toBe(1);
  expect(await f.policy.sendEvidence(f.intent.commandId)).toHaveLength(1);
  expect(f.dynamo.inspect('DISPATCH_CAP#sender%40example.invalid#2026-09-09')).toMatchObject({ used: 1 });
});

it.each(['standalone', 'campaign'])('%s unknown reconciliation appends acceptance evidence without erasing unknown or resending', async kind => {
  const f = kind === 'campaign' ? await campaignFixture() : await dispatchFixture(); f.onSend(async () => { throw new Error('timeout'); });
  await f.service().dispatch(f.intent.commandId);
  const original = await f.policy.sendEvidence(f.intent.commandId);
  if (kind === 'campaign') expect(f.dynamo.inspect(campaignCapKey('campaign-version', 'email'))).toEqual({ reserved: 1, sent: 0 });
  const email = f.intent.frozenMessage;
  const lookup: typeof globalThis.fetch = async url => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/messages')) return Response.json({ messages: [{ id: 'sent1' }] });
    const body = Buffer.from(email.body.replace(/\n/g, '\r\n'));
    return Response.json({ id: 'sent1', threadId: email.threadId, internalDate: String(Date.parse(f.options.clock.now())), labelIds: ['SENT'], payload: { mimeType: 'text/plain', headers: [
      { name: 'Message-ID', value: `<${email.commandId}@callie.invalid>` }, { name: 'From', value: email.from }, { name: 'To', value: email.to }, { name: 'Subject', value: `=?UTF-8?B?${Buffer.from(email.subject).toString('base64')}?=` },
      { name: 'In-Reply-To', value: email.inReplyTo }, { name: 'References', value: email.references.join(' ') },
      { name: 'MIME-Version', value: '1.0' }, { name: 'Content-Type', value: 'text/plain; charset=UTF-8' }, { name: 'Content-Transfer-Encoding', value: 'base64' },
    ], body: { data: body.toString('base64url'), size: body.length } } });
  };
  const restarted = createExecutionRepository({ ...f.options, dispatchPolicy: f.policy });
  const reconciler = createSendReconciler({ execution: restarted, policy: f.policy, authorization: f.authorization, fetch: lookup });
  expect((await reconciler.reconcileSend(f.intent.commandId)).status).toBe('provider_accepted');
  const records = await f.policy.sendEvidence(f.intent.commandId);
  expect(records).toHaveLength(2);
  expect(records).toContainEqual(original[0]);
  if (kind === 'campaign') {
    expect(f.dynamo.inspect(campaignCapKey('campaign-version', 'email'))).toEqual({ reserved: 0, sent: 1 });
    expect(await f.store.list('CAMPAIGN_EVIDENCE#enrollment#')).toHaveLength(2);
  }
  await reconciler.reconcileSend(f.intent.commandId); await f.service().dispatch(f.intent.commandId);
  expect(await f.policy.sendEvidence(f.intent.commandId)).toHaveLength(2);
  expect(f.sends()).toBe(1);
});
it('two final reservation contenders use actual persisted policy, one wins and consumes one cap', async () => {
  const f = await dispatchFixture();
  const request = { ...f.intent.action, expectedVersion: 2 };
  const results = await Promise.allSettled([f.execution.reserveDispatch(request, f.access.accessEvidence), f.execution.reserveDispatch(request, f.access.accessEvidence)]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(f.dynamo.inspect('DISPATCH_CAP#sender%40example.invalid#2026-09-09')).toMatchObject({ used: 1 });
});
it('a distinct action cannot bypass unknown account flight by acquiring a fresh authority version', async () => {
  const f = await dispatchFixture(); f.onSend(async () => { throw new Error('timeout'); });
  await f.service().dispatch(f.intent.commandId);
  const second: DispatchIntent = { ...f.intent, commandId: '22222222-2222-4222-8222-222222222222', action: { ...f.intent.action, actionId: 'second', approvalId: 'second-approval' }, frozenMessage: { ...f.intent.frozenMessage, commandId: '22222222-2222-4222-8222-222222222222' } };
  second.action.contentHash = fingerprint(second.frozenMessage);
  await f.policy.admitApproval({ ...f.approval, id: 'second-approval', commandId: second.commandId, intentHash: fingerprint(second) });
  await f.policy.admitIntent(second);
  const expectedVersion = await f.execution.currentVersion('acct');
  await f.execution.prepareAction({ ...second.action, expectedVersion });
  await expect(f.execution.reserveDispatch({ ...second.action, expectedVersion }, f.access.accessEvidence)).rejects.toThrow('account_dispatch_unresolved');
});
it.each(['approval', 'permission', 'draft', 'cursor', 'caps', 'suppression', 'grant'])('actual final Dynamo conditions reject racing %s change', async changed => {
  const f = await dispatchFixture();
  const plan = await f.policy.reservationPlan({ ...f.intent.action, expectedVersion: 2 }, f.access.accessEvidence);
  const items = plan.finalize();
  if (changed === 'approval') await f.policy.revokeApproval('approval');
  if (changed === 'permission') await f.policy.revokePermission('acct', 'permission');
  if (changed === 'draft') await f.store.transact([f.store.put('MAIL_DRAFT#acct#draft', { ...f.draft, body: 'new', revision: 2 }, 1)]);
  if (changed === 'cursor') { const key = mailCursorKey('acct', 'mailbox'); const row = await f.store.get(key); await f.store.transact([f.store.put(key, { invalidated: true }, row!.rev)]); }
  if (changed === 'caps') await f.policy.configureCaps({ sender: f.draft.sender, dailyLimit: 0 }, 1);
  if (changed === 'suppression') await f.store.transact([f.store.put('MAIL_SUPPRESSION#acct', { reason: 'opt_out' }, null)]);
  if (changed === 'grant') { const key = `GOOGLE_GRANT#${f.intent.pairingId}`; const row = await f.store.get(key); await f.store.transact([f.store.put(key, { revoked: true }, row!.rev)]); }
  await expect(f.store.transact(items)).rejects.toThrow('TransactionCanceledException');
  expect(f.dynamo.inspect('DISPATCH_CAP#sender%40example.invalid#2026-09-09')).toBeUndefined();
});
it('rejects corrupt loaded intent content before any preparation or send', async () => {
  const f = await fixture();
  await f.store.transact([f.store.put(dispatchIntentKey(f.intent.commandId), { ...f.intent, frozenMessage: { ...f.intent.frozenMessage, body: 'Not approved' } }, 1)]);
  await expect(f.policy.loadIntent(f.intent.commandId)).rejects.toThrow('dispatch_identity_conflict');
});
it('route-bound approval checks the real B1 account route and rejects changed version', async () => {
  const f = await fixture();
  const intent: DispatchIntent = { ...f.intent, binding: { kind: 'account_route', routeId: 'route', routeVersion: 1, accountVersion: 1 } };
  const route = { id: 'route', accountId: 'acct', personId: null as null, channel: 'email', value: f.draft.recipient, purpose: 'business', evidenceIds: ['published-source'], verification: 'confirmed', version: 1 };
  const account = { account: { id: 'acct', name: 'Fictional PM', domain: null as null, version: 1 }, routes: [route] };
  await f.store.transact([f.store.put('ACCOUNT#acct', account, 1), f.store.put(dispatchIntentKey(intent.commandId), intent, 1), f.store.put(dispatchApprovalKey('approval'), { ...f.approval, intentHash: fingerprint(intent) }, 1)]);
  const plan = await f.policy.reservationPlan({ ...intent.action, expectedVersion: 2 }, f.access.accessEvidence);
  expect(plan.finalize().some(item => item.ConditionCheck?.Key?.sk?.S === 'ACCOUNT#acct')).toBe(true);
  await f.store.transact([f.store.put('ACCOUNT#acct', { ...account, routes: [{ ...route, version: 2 }] }, 2)]);
  await expect(f.policy.reservationPlan({ ...intent.action, expectedVersion: 2 }, f.access.accessEvidence)).rejects.toThrow('route_not_current');
  await expect(f.store.transact(plan.finalize())).rejects.toThrow('TransactionCanceledException');
});
it.each(['request', 'recipient', 'sender', 'expiry'])('does not admit unsupported recipient permission: %s', async changed => {
  const f = await fixture();
  const permission = { ...f.permission, id: 'another', ...(changed === 'request' ? { sourceMessageHash: 'a'.repeat(64) } : changed === 'recipient' ? { recipient: 'other@example.invalid' } : changed === 'sender' ? { sender: 'other@example.invalid' } : { expiresAt: '2026-09-09T00:00:00.000Z' }) };
  await expect(f.policy.admitPermission(permission)).rejects.toThrow();
});
it('complete live preflight failure overrides a prior successful poll and never sends', async () => {
  const f = await dispatchFixture();
  const service = createDispatchService({ execution: f.execution, policy: f.policy, authorization: f.authorization, fetch: async () => { throw new Error('fictional disconnected provider'); } });
  expect((await service.dispatch(f.intent.commandId)).status).toBe('held');
  expect(f.sends()).toBe(0);
  expect(f.dynamo.inspect('MAIL_CURSOR#acct#mailbox')).toMatchObject({ poll: { status: 'failed' } });
});
it('unambiguous provider rejection is not_sent and cannot auto retry the command', async () => {
  const f = await dispatchFixture(); f.onSend(async () => new Response('', { status: 403 }));
  expect((await f.service().dispatch(f.intent.commandId)).status).toBe('not_sent');
  await f.service().dispatch(f.intent.commandId);
  expect(f.sends()).toBe(1);
});
it('unknown and multiple Sent matches never append acceptance or resend', async () => {
  const f = await dispatchFixture(); f.onSend(async () => { throw new Error('timeout'); }); await f.service().dispatch(f.intent.commandId);
  const reconcile = createSendReconciler({ execution: f.execution, policy: f.policy, authorization: f.authorization, fetch: async () => Response.json({ messages: [{ id: 'sent1' }, { id: 'sent2' }] }) });
  expect(await reconcile.reconcileSend(f.intent.commandId)).toEqual({ status: 'unknown', reason: 'sent_ambiguous' });
  expect(await f.policy.sendEvidence(f.intent.commandId)).toHaveLength(1);
  expect(f.sends()).toBe(1);
});
it('trusted intake configuration is durable and revision fenced', async () => {
  const f = await fixture();
  const registry = { accountId: 'acct', adapters: [{ id: 'gmail', kind: 'gmail', enabled: true, relevant: true, mailboxSubject: 'mailbox' }], manualDependencies: [] as never[] };
  await f.policy.configureIntake(registry, 2);
  expect((await f.store.get(intakeRegistryKey('acct')))?.rev).toBe(3);
  await expect(f.policy.configureIntake(registry, 1)).rejects.toThrow('TransactionCanceledException');
});
it('durable action read rejects mismatched reservation identities', async () => {
  const f = await dispatchFixture();
  const reservation = await f.execution.reserveDispatch({ ...f.intent.action, expectedVersion: 2 }, f.access.accessEvidence);
  const row = await f.store.get<{ input: unknown; state: string; reservation: unknown }>('ACTION#acct#action');
  await f.store.transact([f.store.put('ACTION#acct#action', { ...row!.data, reservation: { ...reservation, accountId: 'other' } }, row!.rev)]);
  await expect(f.execution.readDispatch('acct', 'action')).rejects.toThrow('reservation_identity_conflict');
});

function sentRaw(f: Pick<Awaited<ReturnType<typeof dispatchFixture>>, 'options'> & { intent: DispatchIntent }, extraHeaders: { name: string; value: string }[] = []) {
  if (f.intent.kind === 'phone_requested_followup') throw new Error('threaded_fixture_required');
  const email = f.intent.frozenMessage; const body = Buffer.from(email.body.replace(/\n/g, '\r\n'));
  return { id: 'sent1', threadId: email.threadId, internalDate: String(Date.parse(f.options.clock.now())), labelIds: ['SENT'], payload: { mimeType: 'text/plain', headers: [
    { name: 'Message-ID', value: `<${email.commandId}@callie.invalid>` }, { name: 'From', value: email.from }, { name: 'To', value: email.to }, { name: 'Subject', value: email.subject },
    { name: 'In-Reply-To', value: email.inReplyTo }, { name: 'References', value: email.references.join(' ') },
    { name: 'MIME-Version', value: '1.0' }, { name: 'Content-Type', value: 'text/plain; charset=UTF-8' }, { name: 'Content-Transfer-Encoding', value: 'base64' }, ...extraHeaders,
  ], body: { data: body.toString('base64url'), size: body.length } } };
}
it.each(['Bcc', 'Resent-To', 'charset', 'disposition', 'transfer-encoding', 'filename', 'nested-part'])('I2 raw Sent %s evidence stays unknown without append or releasing flight', async variant => {
  const f = await dispatchFixture(); f.onSend(async () => { throw new Error('timeout'); }); await f.service().dispatch(f.intent.commandId);
  const raw = sentRaw(f, variant === 'Bcc' || variant === 'Resent-To' ? [{ name: variant, value: 'extra@example.invalid' }] : variant === 'disposition' ? [{ name: 'Content-Disposition', value: 'attachment; filename=reply.txt' }] : []);
  if (variant === 'charset') raw.payload.headers.find(h => h.name === 'Content-Type')!.value = 'text/plain; charset=ISO-8859-1';
  if (variant === 'transfer-encoding') raw.payload.headers.find(h => h.name === 'Content-Transfer-Encoding')!.value = 'quoted-printable';
  const payload = { ...raw.payload, ...(variant === 'filename' ? { filename: 'reply.txt' } : {}), ...(variant === 'nested-part' ? { parts: [{ mimeType: 'text/plain', body: { data: 'ZXh0cmE', size: 5 } }] } : {}) };
  const lookup: typeof globalThis.fetch = async url => new URL(String(url)).pathname.endsWith('/messages') ? Response.json({ messages: [{ id: 'sent1' }] }) : Response.json({ ...raw, payload });
  const reconciler = createSendReconciler({ execution: f.execution, policy: f.policy, authorization: f.authorization, fetch: lookup });
  expect((await reconciler.reconcileSend(f.intent.commandId)).status).toBe('unknown');
  expect(await f.policy.sendEvidence(f.intent.commandId)).toHaveLength(1);
  expect(f.dynamo.inspect('DISPATCH_ACCOUNT#acct')).toMatchObject({ state: 'unknown' });
  expect(f.sends()).toBe(1);
});
it('minor replay preserves proven provider not_sent without another send', async () => {
  const f = await dispatchFixture(); f.onSend(async () => new Response('', { status: 403 }));
  expect(await f.service().dispatch(f.intent.commandId)).toMatchObject({ status: 'not_sent', reason: 'provider_not_sent' });
  expect(await f.service().dispatch(f.intent.commandId)).toMatchObject({ status: 'not_sent', reason: 'provider_not_sent' });
  expect(f.sends()).toBe(1);
});
it('I1 preflight must include B opt-out in full persisted A+B account scope before dispatch to A', async () => {
  const f = await dispatchFixture();
  const accountScope = { version: 1 as const, accountId: 'acct', mailboxSubject: 'mailbox', revision: 2, participantAddresses: ['other@example.invalid', f.draft.recipient].sort(), knownThreadIds: ['thread1', 'threadB'], since: '2026-09-09T00:00:00.000Z', approvedAt: f.options.clock.now() };
  await new DynamoThreadIntakeRepository(f.options).admitScope(accountScope, 1);
  let sends = 0; let fullReads = 0;
  const raw = { id: 'optoutB', threadId: 'threadB', internalDate: String(Date.parse(f.options.clock.now())), payload: { mimeType: 'text/plain', headers: [
    { name: 'Message-ID', value: '<optout-b@example.invalid>' }, { name: 'From', value: 'other@example.invalid' }, { name: 'To', value: f.draft.sender }, { name: 'Subject', value: 'Stop' },
    { name: 'Content-Type', value: 'text/plain; charset=UTF-8' },
  ], body: { data: Buffer.from('Please unsubscribe me. Do not contact me again.').toString('base64url') } } };
  const fetch: typeof globalThis.fetch = async url => {
    const target = new URL(String(url));
    if (target.pathname.endsWith('/profile')) return Response.json({ historyId: '1' });
    if (target.pathname.endsWith('/messages')) return Response.json({ messages: [{ id: 'optoutB' }] });
    if (target.pathname.endsWith('/history')) return Response.json({ historyId: '2', history: [{ messagesAdded: [{ message: { id: 'optoutB' } }] }] });
    if (target.pathname.endsWith('/messages/optoutB')) { if (target.searchParams.get('format') === 'full') fullReads++; return Response.json(raw); }
    if (target.pathname.endsWith('/messages/send')) { sends++; return Response.json({ id: 'sent1', threadId: 'thread1' }); }
    throw new Error('unconfigured external boundary');
  };
  const service = createDispatchService({ execution: f.execution, policy: f.policy, authorization: f.authorization, fetch });
  expect((await service.dispatch(f.intent.commandId)).status).toBe('held');
  expect(fullReads).toBe(1);
  expect(f.dynamo.inspect('MAIL_SUPPRESSION#acct')).toBeDefined();
  expect(sends).toBe(0);
});
it.each(['broader', 'narrower', 'missing'])('I1 fresh checkpoint cannot certify %s current account scope', async change => {
  const f = await dispatchFixture(); const key = mailCursorKey('acct', 'mailbox');
  const row = await f.store.get<Record<string, unknown>>(key);
  const scope = change === 'missing' ? null : { ...f.scope, revision: 2, participantAddresses: change === 'broader' ? [f.draft.recipient, 'second@example.invalid'].sort() : ['other@example.invalid'] };
  await f.store.transact([f.store.put(key, { ...row!.data, scope }, row!.rev)]);
  await expect(f.policy.reservationPlan({ ...f.intent.action, expectedVersion: 2 }, f.access.accessEvidence)).rejects.toThrow();
  expect(f.dynamo.inspect('DISPATCH_ACCOUNT#acct')).toBeUndefined();
});
it('I1 same final cursor condition fences a scope change after policy reads', async () => {
  const f = await dispatchFixture(); const plan = await f.policy.reservationPlan({ ...f.intent.action, expectedVersion: 2 }, f.access.accessEvidence);
  const items = plan.finalize();
  expect(items.filter(item => item.ConditionCheck?.Key?.sk?.S === mailCursorKey('acct', 'mailbox'))).toHaveLength(1);
  await new DynamoThreadIntakeRepository(f.options).admitScope({ ...f.scope, revision: 2, participantAddresses: [...f.scope.participantAddresses, 'second@example.invalid'].sort() }, 1);
  await expect(f.store.transact(items)).rejects.toThrow('TransactionCanceledException');
  expect(f.dynamo.inspect('DISPATCH_CAP#sender%40example.invalid#2026-09-09')).toBeUndefined();
});
it('I1 expanded scope requires bounded full rescan before any later send', async () => {
  const f = await dispatchFixture();
  await new DynamoThreadIntakeRepository(f.options).admitScope({ ...f.scope, revision: 2, participantAddresses: [...f.scope.participantAddresses, 'second@example.invalid'].sort() }, 1);
  const requests: string[] = []; let sends = 0;
  const fetch: typeof globalThis.fetch = async url => {
    const target = new URL(String(url)); requests.push(target.href);
    if (target.pathname.endsWith('/profile')) return Response.json({ historyId: '10' });
    if (target.pathname.endsWith('/messages')) { expect(target.searchParams.get('q')).toContain('from:second@example.invalid'); return Response.json({ messages: [] }); }
    if (target.pathname.endsWith('/history')) return Response.json({ historyId: '11', history: [] });
    if (target.pathname.endsWith('/messages/send')) { sends++; return Response.json({ id: 'sent1', threadId: 'thread1' }); }
    throw new Error('unconfigured boundary');
  };
  const service = createDispatchService({ execution: f.execution, policy: f.policy, authorization: f.authorization, fetch });
  expect((await service.dispatch(f.intent.commandId)).status).toBe('held');
  expect(sends).toBe(0);
  expect((await service.dispatch(f.intent.commandId)).status).toBe('provider_accepted');
  expect(requests.findIndex(url => url.includes('/profile'))).toBeLessThan(requests.findIndex(url => url.includes('/history')));
  expect(sends).toBe(1);
});

import { campaignCapKey, campaignEnrollmentKey } from '../src/workerCampaignRepository';
it('D1 concrete campaign checks and reservation caps join actual C1 send transaction once', async () => {
  const f = await campaignFixture();
  expect((await f.service().dispatch(f.intent.commandId)).status).toBe('provider_accepted');
  expect(f.sends()).toBe(1);
  expect(f.dynamo.inspect(campaignCapKey(f.version.id, 'email'))).toEqual({ reserved: 0, sent: 1 });
  const tx = f.dynamo.transactions.find(tx => tx.TransactItems?.some(item => item.Put?.Item?.sk?.S === 'ACTION#acct#campaign-action' && item.Put.Item.state?.S === 'dispatching'))!;
  const keys = tx.TransactItems!.map(item => item.ConditionCheck?.Key?.sk?.S ?? item.Put?.Item?.sk?.S);
  expect(keys).toContain(campaignEnrollmentKey('enrollment')); expect(keys).toContain(campaignCapKey(f.version.id, 'email'));
  expect(keys).toContain('GOOGLE_GRANT#' + f.intent.pairingId); expect(keys).toContain('MAIL_CURSOR#acct#mailbox');
  expect(keys.filter(key => key === 'ACCOUNT#acct')).toHaveLength(1);
  expect(new Set(keys).size).toBe(keys.length);
  await f.service().dispatch(f.intent.commandId); expect(f.sends()).toBe(1);
});
it.each(['paused', 'conversation', 'held'] as const)('D1 actual %s enrollment blocks campaign send with zero cap consumption', async state => {
  const f = await campaignFixture();
  await f.apply({ kind: 'campaign.state', enrollmentId: 'enrollment', expectedEnrollmentVersion: 1, state, reason: 'operator interruption' });
  expect((await f.service().dispatch(f.intent.commandId)).status).toBe('held');
  expect(f.sends()).toBe(0); expect(f.dynamo.inspect(campaignCapKey(f.version.id, 'email'))).toEqual({ reserved: 0, sent: 0 });
});
it('D1 duplicate ACCOUNT fences with different revisions hold instead of silently dropping a constraint', async () => {
  const f = await campaignFixture(); const original = f.campaigns.accountRoute.bind(f.campaigns);
  vi.spyOn(f.campaigns, 'accountRoute').mockImplementation(async (...args) => {
    const row = await f.store.get('ACCOUNT#acct'); await f.store.transact([f.store.put('ACCOUNT#acct', row!.data, row!.rev)]);
    return original(...args);
  });
  await expect(f.policy.reservationPlan({ ...f.intent.action, expectedVersion: 2 }, f.access.accessEvidence)).rejects.toThrow('dispatch_condition_conflict');
  expect(f.dynamo.inspect(campaignCapKey(f.version.id, 'email'))).toEqual({ reserved: 0, sent: 0 });
});

it('D1 accepted outcome atomically settles capacity with ACTION and one outbox event', async () => {
  const f = await campaignFixture(); await f.service().dispatch(f.intent.commandId);
  expect(f.dynamo.inspect(campaignCapKey(f.version.id, 'email'))).toEqual({ reserved: 0, sent: 1 });
  const tx = f.dynamo.transactions.find(tx => tx.TransactItems?.some(item => item.Put?.Item?.sk?.S === 'ACTION#acct#campaign-action' && item.Put.Item.state?.S === 'provider_accepted'))!;
  expect(tx.TransactItems!.some(item => item.Put?.Item?.sk?.S === campaignCapKey(f.version.id, 'email'))).toBe(true);
  const page = await f.execution.eventsAfter(null);
  const event = page.events.find(event => event.kind === 'action.outcome' && event.payload.actionId === 'campaign-action' && event.payload.state === 'provider_accepted');
  expect(event).toHaveProperty('campaign.enrollment.state', 'completed');
});

it.each(['paused', 'conversation', 'held'] as const)('D1 late accepted %s send settles cap without reopening progression', async state => {
  const f = await campaignFixture();
  f.onSend(async () => {
    await f.apply({ kind: 'campaign.state', enrollmentId: 'enrollment', expectedEnrollmentVersion: 1, state, reason: 'operator interruption' });
    return Response.json({ id: 'sent1', threadId: 'thread1' });
  });
  expect((await f.service().dispatch(f.intent.commandId)).status).toBe('provider_accepted');
  expect(f.dynamo.inspect(campaignCapKey(f.version.id, 'email'))).toEqual({ reserved: 0, sent: 1 });
  expect(f.dynamo.inspect(campaignEnrollmentKey('enrollment'))).toMatchObject({ state, currentStepId: 'email-step' });
});
it.each(['CAMPAIGN_ENROLLMENT#enrollment', 'CAMPAIGN_CAP#campaign-version#email', 'CAMPAIGN_APPROVAL#campaign-version', 'CAMPAIGN_ACTION_APPROVAL#acct#campaign-action'])('D1 final produced transaction fences concurrent %s changes', async key => {
  const f = await campaignFixture();
  const plan = await f.policy.reservationPlan({ ...f.intent.action, expectedVersion: 2 }, f.access.accessEvidence);
  const row = await f.store.get(key); await f.store.transact([f.store.put(key, row!.data, row!.rev)]);
  await expect(f.store.transact(plan.finalize())).rejects.toThrow('TransactionCanceledException');
  expect(f.dynamo.inspect('DISPATCH_CAP#sender%40example.invalid#2026-09-09')).toBeUndefined();
  expect(f.dynamo.inspect('CAMPAIGN_RESERVATION#acct#campaign-action')).toBeUndefined();
});

it('source configuration missing holds even with persisted message approval and grant', async () => {
  const f = await fixture(false);
  await expect(f.policy.reservationPlan({ ...f.intent.action, expectedVersion: 1 }, f.access.accessEvidence)).rejects.toThrow('source_configuration_unavailable');
});
it.each([{ state: 'paused' as const }, { state: 'paused' as const, mailboxSubject: null }])('source configuration %j admitted by owner holds dispatch', async change => {
  const f = await fixture(); await f.configure(change);
  await expect(f.policy.reservationPlan({ ...f.intent.action, expectedVersion: await f.execution.currentVersion('acct') }, f.access.accessEvidence)).rejects.toThrow('source_configuration_unavailable');
});
it.each([{ state: 'paused' as const }, { state: 'paused' as const, mailboxSubject: null }])('final source config CAS rejects selective owner change %j', async change => {
  const f = await fixture(); const plan = await f.policy.reservationPlan({ ...f.intent.action, expectedVersion: 2 }, f.access.accessEvidence);
  await f.configure(change);
  await expect(f.store.transact(plan.finalize())).rejects.toThrow('TransactionCanceledException');
  expect(f.dynamo.inspect('DISPATCH_CAP#sender%40example.invalid#2026-09-09')).toBeUndefined();
});

it('selective source pause during real credential preparation sends zero despite active AUTH', async () => {
  const f = await dispatchFixture(); const original = f.authorization.authorizedAccess.bind(f.authorization);
  vi.spyOn(f.authorization, 'authorizedAccess').mockImplementation(async (...args) => {
    const result = await original(...args);
    if (args[1].includes('send')) await f.configure({ state: 'paused' });
    return result;
  });
  expect((await f.service().dispatch(f.intent.commandId)).status).toBe('held');
  expect(f.sends()).toBe(0);
  expect(f.dynamo.inspect('DISPATCH_CAP#sender%40example.invalid#2026-09-09')).toBeUndefined();
});
it.each(['workspaceId', 'accountId', 'pairingId', 'mailboxSubject'] as const)('final source read rejects mismatched persisted %s', async field => {
  const f = await fixture(); const row = await f.store.get<OwnerSourceConfiguration>(ownerSourceKey('acct'));
  await f.store.transact([f.store.put(ownerSourceKey('acct'), { ...row!.data, [field]: 'other' }, row!.rev)]);
  await expect(f.policy.reservationPlan({ ...f.intent.action, expectedVersion: 2 }, f.access.accessEvidence)).rejects.toThrow('source_configuration_unavailable');
});
it('campaign reservation and accepted outbox events carry exact durable cap snapshots without extra authority events', async () => {
  const f = await campaignFixture();
  expect((await f.service().dispatch(f.intent.commandId)).status).toBe('provider_accepted');
  const events = (await f.execution.eventsAfter(null)).events.filter(event => event.kind === 'action.outcome' && event.payload.actionId === 'campaign-action');
  const reserved = events.find(event => event.kind === 'action.outcome' && event.payload.state === 'dispatching');
  const accepted = events.find(event => event.kind === 'action.outcome' && event.payload.state === 'provider_accepted');
  expect(reserved).toHaveProperty('campaign.cap', { campaignVersionId: 'campaign-version', channel: 'email', revision: 2, reserved: 1, sent: 0 });
  expect(accepted).toHaveProperty('campaign.cap', { campaignVersionId: 'campaign-version', channel: 'email', revision: 3, reserved: 0, sent: 1 });
  expect(events.filter(event => event.kind === 'action.outcome' && event.payload.state === 'dispatching')).toHaveLength(1);
  expect(events.filter(event => event.kind === 'action.outcome' && event.payload.state === 'provider_accepted')).toHaveLength(1);
});

it('unknown campaign event reports retained reserved cap rather than a zero default', async () => {
  const f = await campaignFixture(); f.onSend(async () => { throw new Error('timeout'); });
  expect((await f.service().dispatch(f.intent.commandId)).status).toBe('unknown');
  const event = (await f.execution.eventsAfter(null)).events.find(event => event.kind === 'action.outcome' && event.payload.actionId === 'campaign-action' && event.payload.state === 'unknown');
  const cap = await f.store.get(campaignCapKey('campaign-version', 'email'));
  expect(event).toHaveProperty('campaign.cap', { campaignVersionId: 'campaign-version', channel: 'email', revision: cap!.rev, reserved: 1, sent: 0 });
  expect(cap!.data).toEqual({ reserved: 1, sent: 0 });
  await f.service().dispatch(f.intent.commandId); expect(f.sends()).toBe(1);
});
it.each([
  { kind: 'sent_lookup' as const, reason: 'sent_match' as const },
  { kind: 'provider_result' as const, reason: 'provider_result_unknown' as const },
  { kind: 'provider_result' as const, reason: 'provider_accepted' as const },
])('cancelled outcome refuses unproven provider not-sent pairing %j', async proof => {
  const f = await campaignFixture();
  const reservation = await f.execution.reserveDispatch({ ...f.intent.action, expectedVersion: 2 }, f.access.accessEvidence);
  const evidence = { commandId: f.intent.commandId, reservation, state: 'cancelled' as const, observedAt: f.options.clock.now(), ...proof,
    rfcMessageId: `<${f.intent.commandId}@callie.invalid>`, providerIdentity: null as null };
  await expect(f.policy.outcomePlan({ reservation, state: 'cancelled', observedAt: evidence.observedAt, evidenceRef: fingerprint(evidence) }, evidence)).rejects.toThrow('send_evidence_conflict');
  expect(f.dynamo.inspect(campaignCapKey(f.version.id, 'email'))).toEqual({ reserved: 1, sent: 0 });
});
it('actual provider not-sent releases campaign reserved capacity once without progressing enrollment', async () => {
  const f = await campaignFixture(); f.onSend(async () => new Response('', { status: 403 }));
  expect((await f.service().dispatch(f.intent.commandId)).status).toBe('not_sent');
  expect(f.dynamo.inspect(campaignCapKey(f.version.id, 'email'))).toEqual({ reserved: 0, sent: 0 });
  expect(f.dynamo.inspect(campaignEnrollmentKey('enrollment'))).toMatchObject({ currentStepId: 'email-step' });
  const records = await f.policy.sendEvidence(f.intent.commandId);
  expect(records).toHaveLength(1); expect(records[0]).toMatchObject({ state: 'cancelled', kind: 'provider_result', reason: 'provider_not_sent', providerIdentity: null });
  const event = (await f.execution.eventsAfter(null)).events.find(event => event.kind === 'action.outcome' && event.payload.actionId === 'campaign-action' && event.payload.state === 'cancelled');
  expect(event).toHaveProperty('campaign.evidence.cancellationEvidence.evidenceRef', `send-${fingerprint(records[0])}`);
  expect((await f.service().dispatch(f.intent.commandId)).status).toBe('not_sent');
  expect(f.sends()).toBe(1); expect(f.dynamo.inspect(campaignCapKey(f.version.id, 'email'))).toEqual({ reserved: 0, sent: 0 });
});

it.each(['cancelled', 'provider_accepted'] as const)('explicit opposite provider fact after %s appends immutable conflict without changing terminal execution', async first => {
  const f = await campaignFixture(true);
  if (first === 'cancelled') f.onSend(async () => new Response('', { status: 403 }));
  await f.service().dispatch(f.intent.commandId);
  const original = (await f.policy.sendEvidence(f.intent.commandId))[0]!;
  const before = await Promise.all(['ACTION#acct#campaign-action', 'DISPATCH_ACCOUNT#acct', 'CAMPAIGN_RESERVATION#acct#campaign-action', campaignCapKey(f.version.id, 'email')].map(key => f.store.get(key)));
  const late: SendEvidence = { ...original, state: first === 'cancelled' ? 'provider_accepted' : 'cancelled', kind: 'provider_result',
    reason: first === 'cancelled' ? 'provider_accepted' : 'provider_not_sent', providerIdentity: first === 'cancelled' ? { messageId: 'late-original-result', threadId: 'thread1' } : null };
  const outcome = { reservation: late.reservation, state: late.state, observedAt: late.observedAt, evidenceRef: `send-${fingerprint(late)}` };
  await f.execution.appendOutcome(outcome, late);
  const after = await Promise.all(['ACTION#acct#campaign-action', 'DISPATCH_ACCOUNT#acct', 'CAMPAIGN_RESERVATION#acct#campaign-action', campaignCapKey(f.version.id, 'email')].map(key => f.store.get(key)));
  expect(after).toEqual(before);
  expect(await f.policy.sendEvidence(f.intent.commandId)).toEqual(expect.arrayContaining([original, late]));
  expect(f.dynamo.inspect(campaignEnrollmentKey('enrollment'))).toMatchObject({ state: 'held' });
  await expect(f.policy.reservationPlan({ ...f.intent.action, expectedVersion: await f.execution.currentVersion('acct') }, f.access.accessEvidence)).rejects.toThrow('dispatch_conflict_hold');
  const events = (await f.execution.eventsAfter(null)).events;
  const event = events.find(event => event.kind === 'action.outcome' && event.payload.evidenceRef === outcome.evidenceRef);
  expect(event).toHaveProperty('payload.state', first);
  expect(event).toHaveProperty('campaign.evidence.conflict', 'contradictory_finalized_outcome');
  expect(event).toHaveProperty('campaign.evidence.state', late.state);
  await f.execution.appendOutcome(outcome, late);
  expect(await f.policy.sendEvidence(f.intent.commandId)).toHaveLength(2);
  expect((await f.execution.eventsAfter(null)).events).toEqual(events);
  await f.service().dispatch(f.intent.commandId); expect(f.sends()).toBe(1);
});

it.each(['cancelled', 'provider_accepted'] as const)('standalone opposite fact after %s is retained and blocks future reservations', async first => {
  const f = await dispatchFixture();
  if (first === 'cancelled') f.onSend(async () => new Response('', { status: 403 }));
  await f.service().dispatch(f.intent.commandId);
  const original = (await f.policy.sendEvidence(f.intent.commandId))[0]!;
  const late: SendEvidence = { ...original, state: first === 'cancelled' ? 'provider_accepted' : 'cancelled', kind: 'provider_result',
    reason: first === 'cancelled' ? 'provider_accepted' : 'provider_not_sent', providerIdentity: first === 'cancelled' ? { messageId: 'late-original-result', threadId: 'thread1' } : null };
  const outcome = { reservation: late.reservation, state: late.state, observedAt: late.observedAt, evidenceRef: `send-${fingerprint(late)}` };
  const actionKey = `ACTION#acct#${f.intent.action.actionId}`;
  const before = await f.store.get(actionKey);
  const pendingPlan = await f.policy.reservationPlan({ ...f.intent.action, expectedVersion: await f.execution.currentVersion('acct') }, f.access.accessEvidence);
  await f.execution.appendOutcome(outcome, late);
  expect(await f.store.get(actionKey)).toEqual(before);
  await expect(f.store.transact(pendingPlan.finalize())).rejects.toThrow();
  expect(await f.policy.sendEvidence(f.intent.commandId)).toHaveLength(2);
  await expect(f.policy.reservationPlan({ ...f.intent.action, expectedVersion: await f.execution.currentVersion('acct') }, f.access.accessEvidence)).rejects.toThrow('dispatch_conflict_hold');
  const events = (await f.execution.eventsAfter(null)).events;
  await f.execution.appendOutcome(outcome, late);
  expect((await f.execution.eventsAfter(null)).events).toEqual(events);
  await f.service().dispatch(f.intent.commandId); expect(f.sends()).toBe(1);
});

it.each(['same_terminal', 'unproven_cancellation', 'foreign_reservation'] as const)('terminal late evidence refuses %s before storing conflict or receipt', async variant => {
  const f = await dispatchFixture(); await f.service().dispatch(f.intent.commandId);
  const original = (await f.policy.sendEvidence(f.intent.commandId))[0]!;
  const late: SendEvidence = variant === 'same_terminal' ? { ...original, observedAt: '2026-09-09T00:04:01.000Z' }
    : { ...original, state: 'cancelled', kind: variant === 'unproven_cancellation' ? 'sent_lookup' : 'provider_result', reason: 'provider_not_sent', providerIdentity: null };
  if (variant === 'foreign_reservation') late.reservation = { ...late.reservation, targetHash: 'b'.repeat(64) };
  const events = (await f.execution.eventsAfter(null)).events;
  await expect(f.execution.appendOutcome({ reservation: late.reservation, state: late.state, observedAt: late.observedAt, evidenceRef: fingerprint(late) }, late)).rejects.toThrow();
  expect(await f.store.get('DISPATCH_CONFLICT#acct')).toBeNull();
  expect(await f.store.list('ACTION_LATE_EVIDENCE#')).toHaveLength(0);
  expect(await f.policy.sendEvidence(f.intent.commandId)).toHaveLength(1);
  expect((await f.execution.eventsAfter(null)).events).toEqual(events);
});

it('already-running unknown Sent reconciliation retains verified acceptance after definite non-send wins settlement', async () => {
  const f = await campaignFixture(true); f.onSend(async () => { throw new Error('lost send response'); });
  expect((await f.service().dispatch(f.intent.commandId)).status).toBe('unknown');
  let entered!: () => void; let resume!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }); const gate = new Promise<void>(resolve => { resume = resolve; });
  const lookup: typeof globalThis.fetch = async url => {
    if (new URL(String(url)).pathname.endsWith('/messages')) { entered(); await gate; return Response.json({ messages: [{ id: 'sent1' }] }); }
    return Response.json(sentRaw(f));
  };
  const reconciler = createSendReconciler({ execution: f.execution, policy: f.policy, authorization: f.authorization, fetch: lookup });
  const pending = reconciler.reconcileSend(f.intent.commandId);
  await started;
  const original = (await f.policy.sendEvidence(f.intent.commandId))[0]!;
  const cancelled: SendEvidence = { ...original, state: 'cancelled', kind: 'provider_result', reason: 'provider_not_sent', providerIdentity: null };
  await f.execution.appendOutcome({ reservation: cancelled.reservation, state: 'cancelled', observedAt: cancelled.observedAt, evidenceRef: `send-${fingerprint(cancelled)}` }, cancelled);
  const keys = ['ACTION#acct#campaign-action', 'DISPATCH_ACCOUNT#acct', 'CAMPAIGN_RESERVATION#acct#campaign-action', campaignCapKey(f.version.id, 'email')];
  const before = await Promise.all(keys.map(key => f.store.get(key)));
  resume();
  expect(await pending).toMatchObject({ status: 'provider_accepted', reason: 'sent_match', providerIdentity: { messageId: 'sent1', threadId: 'thread1' } });
  expect(await Promise.all(keys.map(key => f.store.get(key)))).toEqual(before);
  const evidence = await f.policy.sendEvidence(f.intent.commandId);
  expect(evidence).toHaveLength(3);
  const late = evidence.find(item => item.kind === 'sent_lookup')!;
  expect(late).toMatchObject({ state: 'provider_accepted', reason: 'sent_match' });
  const events = (await f.execution.eventsAfter(null)).events;
  expect(events.at(-1)).toMatchObject({ kind: 'action.outcome', payload: { state: 'cancelled' }, campaign: { evidence: { state: 'provider_accepted', conflict: 'contradictory_finalized_outcome' } } });
  await f.execution.appendOutcome({ reservation: late.reservation, state: late.state, observedAt: late.observedAt, evidenceRef: `sent-${fingerprint(late)}` }, late);
  expect((await f.execution.eventsAfter(null)).events).toEqual(events);
  expect(f.dynamo.inspect(campaignEnrollmentKey('enrollment'))).toMatchObject({ state: 'held' });
  expect((await f.service().dispatch(f.intent.commandId)).status).toBe('not_sent'); expect(f.sends()).toBe(1);
});
it.each(['wrong_reason', 'wrong_thread', 'missing_identity', 'wrong_rfc'] as const)('terminal Sent acceptance rejects %s without conflict writes', async variant => {
  const f = await dispatchFixture(); f.onSend(async () => new Response('', { status: 403 })); await f.service().dispatch(f.intent.commandId);
  const original = (await f.policy.sendEvidence(f.intent.commandId))[0]!;
  const evidence: SendEvidence = { ...original, state: 'provider_accepted', kind: 'sent_lookup', reason: variant === 'wrong_reason' ? 'provider_accepted' : 'sent_match',
    providerIdentity: variant === 'missing_identity' ? null : { messageId: 'sent1', threadId: variant === 'wrong_thread' ? 'foreign' : 'thread1' },
    rfcMessageId: variant === 'wrong_rfc' ? '<foreign@callie.invalid>' : original.rfcMessageId };
  const events = (await f.execution.eventsAfter(null)).events;
  await expect(f.execution.appendOutcome({ reservation: evidence.reservation, state: evidence.state, observedAt: evidence.observedAt, evidenceRef: `sent-${fingerprint(evidence)}` }, evidence)).rejects.toThrow('send_evidence_conflict');
  expect(await f.policy.sendEvidence(f.intent.commandId)).toHaveLength(1); expect(await f.store.get('DISPATCH_CONFLICT#acct')).toBeNull();
  expect((await f.execution.eventsAfter(null)).events).toEqual(events);
});
