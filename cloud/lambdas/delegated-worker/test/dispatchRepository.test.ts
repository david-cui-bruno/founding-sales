import { OwnerCommandCoordinator } from '../src/ownerCommandCoordinator';
import { ownerSourceKey, type OwnerSourceConfiguration } from '../../../../src/shared/contracts/ownerCommandContract';
import { mailScopeFingerprint } from '../../../../src/main/outreach/providers/gmailThreadProvider';
import { describe, expect, it, vi } from 'vitest';
import { DynamoDispatchRepository, dispatchIntentKey, dispatchApprovalKey, dispatchPermissionKey, dispatchCapPolicyKey, type DispatchIntent } from '../src/dispatchRepository';
import { DynamoStore, fingerprint } from '../src/dynamoStore';
import { ConditionalCommandHarness } from './sdkHarness';
import { WorkerAuth } from '../src/workerAuth';
import { RemoteGoogleAuthorization } from '../src/remoteGoogleAuthorization';
import { googleScopes } from '../src/googleGrantCapabilities';
import { DynamoThreadIntakeRepository, mailThreadKey, mailCursorKey } from '../src/threadIntakeRepository';
import { intakeRegistryKey } from '../src/intakeBarrier';
import type { AccountReplyDraft, MailMessage } from '../../../../src/shared/contracts/mailThreadContract';

async function fixture(configured = true) {
  const dynamo = new ConditionalCommandHarness(); let now = '2026-09-09T00:04:00.000Z';
  const options = { dynamo, tableName: 't', workspaceId: 'ws', clock: { now: () => now } };
  const store = new DynamoStore(options); const auth = new WorkerAuth(options);
  const fetch: typeof globalThis.fetch = async url => {
    if (String(url) === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'fictional-access', refresh_token: 'fictional-refresh', token_type: 'Bearer', expires_in: 3600, scope: `openid email ${googleScopes.send} ${googleScopes.relevant_read}` });
    if (String(url) === 'https://openidconnect.googleapis.com/v1/userinfo') return Response.json({ sub: 'mailbox', email: 'sender@example.invalid', email_verified: true });
    throw new Error('unconfigured external boundary');
  };
  const authorization = new RemoteGoogleAuthorization({ auth, fetch, config: { clientId: 'fictional.apps.googleusercontent.com', clientSecret: 'fictional', redirectUri: 'https://worker.example.invalid/oauth/callback', encryptionKey: Buffer.alloc(32, 7) } });
  const { code } = await auth.issuePairing({ scopes: ['google:grant', 'commands:write'], expiresInSeconds: 300 });
  const pair = await auth.redeemPairing(code, 'fictional-source');
  const grant = await authorization.beginGoogleGrant(pair.pairingId, ['send', 'relevant_read']);
  await authorization.completeGoogleGrant(new URL(grant.authorizationUrl).searchParams.get('state')!, 'fictional-code');
  const access = await authorization.authorizedAccess(pair.pairingId, ['send', 'relevant_read']);
  const message: MailMessage = { id: 'inbound1', threadId: 'thread1', rfcMessageId: '<request@example.invalid>', references: [], from: ['recipient@example.invalid'], to: ['sender@example.invalid'], cc: [], date: '2026-09-09T00:00:00.000Z', subject: 'Requested information', bodyParts: [{ mimeType: 'text/plain', text: 'Please send the details.', truncated: false }] };
  const draft: AccountReplyDraft = { id: 'draft', accountId: 'acct', threadId: 'thread1', mailboxSubject: 'mailbox', threadRevision: 1, contextRevision: 'context1', revision: 1, sender: 'sender@example.invalid', recipient: 'recipient@example.invalid', subject: 'Requested information', body: 'Approved details.\nSender address.', evidenceIds: ['inbound1'], generation: 'edited', updatedAt: now };
  const frozenMessage = { commandId: '11111111-1111-4111-8111-111111111111', from: draft.sender, to: draft.recipient, subject: draft.subject, body: draft.body, threadId: draft.threadId, inReplyTo: message.rfcMessageId!, references: [message.rfcMessageId!] };
  const intent: DispatchIntent = { commandId: frozenMessage.commandId, action: { workspaceId: 'ws', accountId: 'acct', actionId: 'action', expectedAuthorityGeneration: 1, approvalId: 'approval', contentHash: fingerprint(frozenMessage), targetHash: fingerprint({ sender: draft.sender, recipient: draft.recipient, threadId: draft.threadId }) }, kind: 'standalone_reply', draftId: draft.id, draftRevision: 1, pairingId: pair.pairingId, mailboxSubject: 'mailbox', frozenMessage, binding: { kind: 'thread_participant', threadId: 'thread1', sourceMessageId: 'inbound1', sourceMessageHash: fingerprint(message) } };
  const permission = { id: 'permission', accountId: 'acct', recipient: draft.recipient, sender: draft.sender, threadId: 'thread1', sourceMessageId: 'inbound1', sourceMessageHash: fingerprint(message), basis: 'requested_followup' as const, recordedAt: now, expiresAt: '2026-09-10T00:00:00.000Z' };
  const approval = { id: 'approval', commandId: intent.commandId, intentHash: fingerprint(intent), draft, permissionEvidenceId: permission.id, approvedAt: now, expiresAt: '2026-09-10T00:00:00.000Z' };
  const policy = new DynamoDispatchRepository(options, authorization);
  const scope = { version: 1 as const, accountId: 'acct', mailboxSubject: 'mailbox', revision: 1, participantAddresses: [draft.recipient], knownThreadIds: ['thread1'], since: '2026-09-09T00:00:00.000Z', approvedAt: now };
  const scopeBinding = { scopeRevision: scope.revision, scopeFingerprint: mailScopeFingerprint(scope) };
  await store.transact([
    store.put(`MAIL_DRAFT#acct#draft`, draft, null), store.put(mailThreadKey('acct', 'thread1'), { thread: { accountId: 'acct', mailboxSubject: 'mailbox', provider: 'gmail', providerThreadId: 'thread1', messages: [message] }, revision: 1, contextRevision: 'context1', signals: [] }, null),
    store.put(mailCursorKey('acct', 'mailbox'), { scope, checkpoint: { ...scopeBinding, version: 1, accountId: 'acct', mailboxSubject: 'mailbox', mode: 'history', historyId: '1', pageToken: null, since: '2026-09-09T00:00:00.000Z' }, poll: { ...scopeBinding, attemptId: 'poll', accountId: 'acct', mailboxSubject: 'mailbox', status: 'complete', startedAt: now, completedAt: now } }, null),
    store.put(intakeRegistryKey('acct'), { accountId: 'acct', adapters: [{ id: 'gmail', kind: 'gmail', enabled: true, relevant: true, mailboxSubject: 'mailbox' }], manualDependencies: [] }, null),
  ]);
  await policy.admitPermission(permission); await policy.admitApproval(approval); await policy.admitIntent(intent);
  await policy.configureCaps({ sender: draft.sender, dailyLimit: 3 }, null);
  const execution = createExecutionRepository({ ...options, dispatchPolicy: policy });
  await execution.seedLocalAuthority('acct');
  await execution.applyCommand({ commandId: 'delegate', workspaceId: 'ws', accountId: 'acct', expectedAuthorityGeneration: 0, expectedVersion: 0, kind: 'delegate', payload: { delegationId: 'operator-approved', approvedAt: now } });
  const account = { id: 'acct', name: 'Fictional PM', domain: null, version: 1 };
  await store.transact([store.put('ACCOUNT#acct', { account, routes: [], sources: [], claims: [], researchRevision: 1, history: [{ at: now, account, routes: [], claims: [] }] }, null)]);
  const owner = new OwnerCommandCoordinator({ auth, authorization }); let configSequence = 800;
  const configure = async (changes: Partial<OwnerSourceConfiguration> = {}) => {
    const previous = await store.get<OwnerSourceConfiguration>(ownerSourceKey('acct'));
    const config: OwnerSourceConfiguration = { version: 1, workspaceId: 'ws', accountId: 'acct', pairingId: pair.pairingId, revision: (previous?.data.revision ?? 0) + 1,
      state: 'active', mailboxSubject: 'mailbox', calendarId: null, research: null, ...changes };
    return owner.apply({ commandId: `00000000-0000-4000-8000-${String(configSequence++).padStart(12, '0')}`, workspaceId: 'ws', accountId: 'acct', expectedAuthorityGeneration: 1,
      expectedVersion: await execution.currentVersion('acct'), kind: 'configure-owner', payload: { expectedConfigurationRevision: previous?.data.revision ?? 0, configuration: config, mailScope: null } }, `Bearer ${pair.credential}`);
  };
  if (configured) await configure();
  return { dynamo, options, store, authorization, access, policy, intent, approval, permission, draft, message, scope, scopeBinding, configure, execution, advance: (value: string) => { now = value; } };
}

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
async function dispatchFixture() {
  const f = await fixture();
  const execution = createExecutionRepository({ ...f.options, dispatchPolicy: f.policy });
  await execution.prepareAction({ ...f.intent.action, expectedVersion: 2 });
  let sends = 0;
  let onSend: () => Promise<Response> = async () => Response.json({ id: 'sent1', threadId: 'thread1' });
  const fetch: typeof globalThis.fetch = async url => {
    const target = new URL(String(url));
    if (target.pathname.endsWith('/history')) return Response.json({ historyId: '2', history: [] });
    if (target.pathname.endsWith('/messages/send')) { sends++; return onSend(); }
    throw new Error('unconfigured external boundary');
  };
  const service = () => createDispatchService({ execution, policy: f.policy, authorization: f.authorization, fetch });
  return { ...f, execution, fetch, service, sends: () => sends, onSend: (callback: () => Promise<Response>) => { onSend = callback; } };
}
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
  const route = { id: 'route', accountId: 'acct', personId: null, channel: 'email', value: f.draft.recipient, purpose: 'business', evidenceIds: ['published-source'], verification: 'confirmed', version: 1 };
  const account = { account: { id: 'acct', name: 'Fictional PM', domain: null, version: 1 }, routes: [route] };
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
  const registry = { accountId: 'acct', adapters: [{ id: 'gmail', kind: 'gmail', enabled: true, relevant: true, mailboxSubject: 'mailbox' }], manualDependencies: [] };
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

function sentRaw(f: Awaited<ReturnType<typeof dispatchFixture>>, extraHeaders: { name: string; value: string }[] = []) {
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

import { CampaignExecution } from '../src/campaignExecution';
import { WorkerCampaignRepository, campaignCapKey, campaignEnrollmentKey } from '../src/workerCampaignRepository';
import type { CampaignCommandPayload, CampaignVersion } from '../../../../src/shared/contracts/campaignContract';
async function campaignFixture() {
  const f = await dispatchFixture(); const campaigns = new WorkerCampaignRepository(f.options); const campaignExecution = new CampaignExecution(campaigns);
  const policy = new DynamoDispatchRepository(f.options, f.authorization, campaignExecution);
  const execution = createExecutionRepository({ ...f.options, dispatchPolicy: policy });
  const account = { id: 'acct', name: 'Fictional PM', domain: null, version: 1 };
  const route = { id: 'route', accountId: 'acct', personId: null, channel: 'email', value: f.draft.recipient, purpose: 'business', evidenceIds: ['actual-source'], verification: 'confirmed', version: 1 };
  await f.store.transact([f.store.put('ACCOUNT#acct', { account, routes: [route], sources: [], claims: [], researchRevision: 1, history: [] }, 1)]);
  let sequence = 100;
  const apply = async (payload: CampaignCommandPayload) => {
    const commandId = `00000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`;
    const plan = await campaigns.planCommand({ commandId, accountId: 'acct', payload });
    await f.store.transact(plan.items);
  };
  const version: CampaignVersion = { id: 'campaign-version', campaignId: 'campaign', version: 1, audienceHash: 'a'.repeat(64), offer: 'Requested information', objective: 'meeting', cohortAccountIds: ['acct'], approvedAt: null,
    steps: [{ id: 'email-step', channel: 'email', condition: 'initial', delayHours: 0 }], capScope: 'campaign_version_lifetime', channelCaps: { call: 0, email: 1, linkedin: 0 }, contentPolicyHash: 'b'.repeat(64) };
  await apply({ kind: 'campaign.version', version });
  await apply({ kind: 'campaign.approve', campaignVersionId: version.id, snapshotHash: fingerprint(version), approvedAt: f.options.clock.now() });
  await apply({ kind: 'campaign.enroll', enrollmentId: 'enrollment', campaignVersionId: version.id, selectedRouteId: 'route', executionContextId: f.draft.contextRevision, contextRevision: 1 });
  const commandId = '33333333-3333-4333-8333-333333333333'; const frozenMessage = { ...f.intent.frozenMessage, commandId };
  const intent: DispatchIntent = { ...f.intent, commandId, frozenMessage, kind: 'campaign_step', campaign: { campaignId: 'campaign', campaignRevision: 1, enrollmentId: 'enrollment', enrollmentRevision: 1, stepId: 'email-step' },
    action: { ...f.intent.action, actionId: 'campaign-action', approvalId: 'campaign-email-approval', contentHash: fingerprint(frozenMessage) }, binding: { kind: 'account_route', routeId: 'route', routeVersion: 1, accountVersion: 1 } };
  await campaigns.admitActionApproval({ workspaceId: 'ws', accountId: 'acct', ...intent.campaign, actionId: intent.action.actionId, channel: 'email', authorityGeneration: 1, selectedRouteId: 'route', contextRevision: f.draft.contextRevision,
    contentHash: intent.action.contentHash, targetHash: intent.action.targetHash, approvedAt: f.options.clock.now(), expiresAt: f.approval.expiresAt });
  await policy.admitApproval({ ...f.approval, id: intent.action.approvalId, commandId, intentHash: fingerprint(intent) });
  await policy.admitIntent(intent); await execution.prepareAction({ ...intent.action, expectedVersion: 2 });
  return { ...f, policy, execution, campaigns, campaignExecution, version, intent, apply,
    service: () => createDispatchService({ execution, policy, authorization: f.authorization, fetch: f.fetch }) };
}
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
it.each([{ state: 'paused' as const }, { mailboxSubject: null }])('source configuration %j admitted by owner holds dispatch', async change => {
  const f = await fixture(); await f.configure(change);
  await expect(f.policy.reservationPlan({ ...f.intent.action, expectedVersion: await f.execution.currentVersion('acct') }, f.access.accessEvidence)).rejects.toThrow('source_configuration_unavailable');
});
it.each([{ state: 'paused' as const }, { mailboxSubject: null }])('final source config CAS rejects selective owner change %j', async change => {
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
