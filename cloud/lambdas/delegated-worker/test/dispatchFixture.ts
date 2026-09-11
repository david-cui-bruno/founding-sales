import type { Account, AccountRoute } from '../../../../src/shared/contracts/accountContract';
import { OwnerCommandCoordinator } from '../src/ownerCommandCoordinator';
import { ownerSourceKey, type OwnerSourceConfiguration } from '../../../../src/shared/contracts/ownerCommandContract';
import { mailScopeFingerprint } from '../../../../src/main/outreach/providers/gmailThreadProvider';
import { DynamoDispatchRepository, type DispatchIntent } from '../src/dispatchRepository';
import { DynamoStore, fingerprint } from '../src/dynamoStore';
import { ConditionalCommandHarness } from './sdkHarness';
import { WorkerAuth } from '../src/workerAuth';
import { RemoteGoogleAuthorization } from '../src/remoteGoogleAuthorization';
import { googleScopes } from '../src/googleGrantCapabilities';
import { mailThreadKey, mailCursorKey } from '../src/threadIntakeRepository';
import { intakeRegistryKey } from '../src/intakeBarrier';
import type { AccountReplyDraft, MailMessage } from '../../../../src/shared/contracts/mailThreadContract';
import { createExecutionRepository } from '../src/executionRepository';
import { createDispatchService } from '../src/dispatchService';
import { CampaignExecution } from '../src/campaignExecution';
import { WorkerCampaignRepository } from '../src/workerCampaignRepository';
import type { CampaignCommandPayload, CampaignVersion, CampaignEventPayload } from '../../../../src/shared/contracts/campaignContract';
import type { DelegationCommand } from '../../../../src/shared/contracts/delegationContract';

export async function fixture(configured = true) {
  const dynamo = new ConditionalCommandHarness(); let now = '2026-09-09T00:04:00.000Z';
  const options = { dynamo, tableName: 't', workspaceId: 'ws', clock: { now: () => now } };
  const store = new DynamoStore(options); const auth = new WorkerAuth(options);
  let oauthFetch: typeof globalThis.fetch | null = null;
  const fetch: typeof globalThis.fetch = async (url, init) => {
    if (oauthFetch) return oauthFetch(url, init);
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
  const delegate: DelegationCommand = { commandId: 'delegate', workspaceId: 'ws', accountId: 'acct', expectedAuthorityGeneration: 0, expectedVersion: 0, kind: 'delegate', payload: { delegationId: 'operator-approved', approvedAt: now } };
  await execution.applyCommand(delegate);
  const commands: DelegationCommand[] = [delegate];
  const account: Account = { id: 'acct', name: 'Fictional PM', domain: null, version: 1 };
  await store.transact([store.put('ACCOUNT#acct', { account, routes: [], sources: [], claims: [], researchRevision: 1, history: [{ at: now, account, routes: [], claims: [] }] }, null)]);
  const owner = new OwnerCommandCoordinator({ auth, authorization }); let configSequence = 800;
  const configure = async (changes: Partial<OwnerSourceConfiguration> = {}) => {
    const previous = await store.get<OwnerSourceConfiguration>(ownerSourceKey('acct'));
    const config: OwnerSourceConfiguration = { version: 1, workspaceId: 'ws', accountId: 'acct', pairingId: pair.pairingId, revision: (previous?.data.revision ?? 0) + 1,
      state: 'active', mailboxSubject: 'mailbox', calendarId: null, research: null, ...changes };
    const command: DelegationCommand = { commandId: `00000000-0000-4000-8000-${String(configSequence++).padStart(12, '0')}`, workspaceId: 'ws', accountId: 'acct', expectedAuthorityGeneration: 1,
      expectedVersion: await execution.currentVersion('acct'), kind: 'configure-owner', payload: { expectedConfigurationRevision: previous?.data.revision ?? 0, configuration: config, mailScope: null } };
    commands.push(command);
    return owner.apply(command, `Bearer ${pair.credential}`);
  };
  if (configured) await configure();
  return { dynamo, options, store, authorization, access, policy, intent, approval, permission, draft, message, scope, scopeBinding, configure, execution, commands, owner, pair, onOAuthFetch: (handler: typeof globalThis.fetch) => { oauthFetch = handler; }, advance: (value: string) => { now = value; } };
}

export async function dispatchFixture() {
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

export async function campaignFixture(followup = false) {
  const f = await dispatchFixture(); const campaigns = new WorkerCampaignRepository(f.options); const campaignExecution = new CampaignExecution(campaigns);
  const policy = new DynamoDispatchRepository(f.options, f.authorization, campaignExecution);
  const execution = createExecutionRepository({ ...f.options, dispatchPolicy: policy });
  const account: Account = { id: 'acct', name: 'Fictional PM', domain: null, version: 1 };
  const route: AccountRoute = { id: 'route', accountId: 'acct', personId: null, channel: 'email', value: f.draft.recipient, purpose: 'business', evidenceIds: ['actual-source'], verification: 'confirmed', version: 1 };
  await f.store.transact([f.store.put('ACCOUNT#acct', { account, routes: [route], sources: [], claims: [], researchRevision: 1, history: [] }, 1)]);
  const campaignPayloads: CampaignEventPayload[] = [];
  let sequence = 100;
  const apply = async (payload: CampaignCommandPayload) => {
    const commandId = `00000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`;
    const plan = await campaigns.planCommand({ commandId, accountId: 'acct', payload });
    await f.store.transact(plan.items);
    campaignPayloads.push(plan.payload);
  };
  const version: CampaignVersion = { id: 'campaign-version', campaignId: 'campaign', version: 1, audienceHash: 'a'.repeat(64), offer: 'Requested information', objective: 'meeting', cohortAccountIds: ['acct'], approvedAt: null,
    steps: [{ id: 'email-step', channel: 'email', condition: 'initial', delayHours: 0 }, ...(followup ? [{ id: 'followup-step', channel: 'call' as const, condition: 'no_reply' as const, delayHours: 24 }] : [])], capScope: 'campaign_version_lifetime', channelCaps: { call: 0, email: 1, linkedin: 0 }, contentPolicyHash: 'b'.repeat(64) };
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
  return { ...f, policy, execution, campaigns, campaignExecution, version, intent, apply, campaignPayloads,
    service: () => createDispatchService({ execution, policy, authorization: f.authorization, fetch: f.fetch }) };
}
