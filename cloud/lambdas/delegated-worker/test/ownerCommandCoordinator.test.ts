import { expect, it } from 'vitest';
import { ownerCommandSchema } from '../../../../src/shared/contracts/ownerCommandContract';
const envelope = { commandId: '11111111-1111-4111-8111-111111111111', workspaceId: 'ws', accountId: 'account', expectedAuthorityGeneration: 1, expectedVersion: 2 };
it('accepts exact existing intent references but rejects caller permission flags and arbitrary dispatch contents', () => {
  const command = { ...envelope, kind: 'submit-approved-reply', payload: { intentCommandId: '22222222-2222-4222-8222-222222222222' } };
  expect(ownerCommandSchema.safeParse(command).success).toBe(true);
  expect(ownerCommandSchema.safeParse({ ...command, payload: { ...command.payload, senderAllowed: true } }).success).toBe(false);
  expect(ownerCommandSchema.safeParse({ ...command, payload: { ...command.payload, body: 'Unapproved content' } }).success).toBe(false);
});
it('binds manual preparation to exact generation/action/route/content/context and campaign revisions', () => {
  const command = { ...envelope, kind: 'prepare-manual', payload: { actionId: 'action', channel: 'call', routeId: 'route', routeVersion: 1,
    targetHash: 'a'.repeat(64), contentHash: 'b'.repeat(64), contextRevision: 'context', campaign: { campaignId: 'campaign', campaignRevision: 1, enrollmentId: 'enrollment', enrollmentRevision: 1, stepId: 'step' } } };
  expect(ownerCommandSchema.safeParse(command).success).toBe(true);
  expect(ownerCommandSchema.safeParse({ ...command, payload: { ...command.payload, campaign: null } }).success).toBe(false);
  expect(ownerCommandSchema.safeParse({ ...command, payload: { ...command.payload, targetHash: '' } }).success).toBe(false);
});
it('requires source-backed human basis and exact edited reply rather than permission booleans', () => {
  const draft = { id: 'draft', accountId: 'account', threadId: 'thread', mailboxSubject: 'mailbox', threadRevision: 1, contextRevision: 'context', revision: 2,
    recipient: 'recipient@example.test', sender: 'sender@example.test', subject: 'Requested details', body: 'Reviewed reply', evidenceIds: ['message'], generation: 'edited', updatedAt: '2026-09-08T12:00:00.000Z' };
  const payload = { draft, expectedRemoteDraftRevision: 1, approvalId: 'approval', actionId: 'action', intentCommandId: '22222222-2222-4222-8222-222222222222',
    permission: { id: 'permission', sourceMessageId: 'message', sourceMessageHash: 'a'.repeat(64), basis: 'requested_followup', expiresAt: '2026-09-09T12:00:00.000Z' },
    binding: { kind: 'thread_participant', threadId: 'thread', sourceMessageId: 'message', sourceMessageHash: 'a'.repeat(64) }, expiresAt: '2026-09-09T12:00:00.000Z' };
  expect(ownerCommandSchema.safeParse({ ...envelope, kind: 'approve-reply', payload }).success).toBe(true);
  expect(ownerCommandSchema.safeParse({ ...envelope, kind: 'approve-reply', payload: { ...payload, permission: { allowed: true } } }).success).toBe(false);
  expect(ownerCommandSchema.safeParse({ ...envelope, kind: 'approve-reply', payload: { ...payload, binding: { kind: 'account_route', routeId: 'invented' } } }).success).toBe(false);
});

import { OwnerCommandCoordinator } from '../src/ownerCommandCoordinator';
import { ConditionalCommandHarness } from './sdkHarness';
import { WorkerAuth } from '../src/workerAuth';
import { RemoteGoogleAuthorization } from '../src/remoteGoogleAuthorization';
import { createExecutionRepository } from '../src/executionRepository';
import { DynamoThreadIntakeRepository } from '../src/threadIntakeRepository';
import { DynamoDispatchRepository } from '../src/dispatchRepository';
import { DynamoStore, fingerprint } from '../src/dynamoStore';
import type { AccountReplyDraft, MailMessage } from '../../../../src/shared/contracts/mailThreadContract';
async function approvalFixture() {
  const now = '2026-09-08T12:00:00.000Z'; const dynamo = new ConditionalCommandHarness();
  const options = { dynamo, tableName: 'fictional', workspaceId: 'ws', clock: { now: () => now } };
  const auth = new WorkerAuth(options); const bootstrap = await auth.issuePairing({ scopes: ['commands:write', 'events:read'], expiresInSeconds: 300 });
  const pairing = await auth.redeemPairing(bootstrap.code, 'fictional');
  const google = new RemoteGoogleAuthorization({ auth });
  const execution = createExecutionRepository(options); await execution.seedLocalAuthority('account');
  await execution.applyCommand({ ...envelope, commandId: 'delegate', expectedAuthorityGeneration: 0, expectedVersion: 0, kind: 'delegate', payload: { delegationId: 'explicit', approvedAt: now } });
  const threads = new DynamoThreadIntakeRepository(options);
  const message: MailMessage = { id: 'message', threadId: 'thread', rfcMessageId: '<message@example.test>', references: [], from: ['recipient@example.test'], to: ['sender@example.test'], cc: [], date: now,
    subject: 'Requested details', bodyParts: [{ mimeType: 'text/plain', text: 'Please send me the details.', truncated: false }] };
  await threads.applyPage({ complete: true, nextCursor: { version: 1, accountId: 'account', mailboxSubject: 'mailbox', mode: 'history', historyId: '1', pageToken: null, since: now },
    threads: [{ accountId: 'account', mailboxSubject: 'mailbox', provider: 'gmail', providerThreadId: 'thread', messages: [message] }] }, null);
  const projection = (await threads.getThread('account', 'thread'))!;
  const draft: AccountReplyDraft = { id: 'draft', accountId: 'account', threadId: 'thread', mailboxSubject: 'mailbox', threadRevision: projection.revision, contextRevision: projection.contextRevision,
    revision: 1, sender: 'sender@example.test', recipient: 'recipient@example.test', subject: 'Requested details', body: 'Initial text', evidenceIds: ['mail:message'], generation: 'edited', updatedAt: now };
  await threads.saveReplyDraft(draft, null);
  const command = ownerCommandSchema.parse({ ...envelope, kind: 'approve-reply', payload: { draft: { ...draft, body: 'Owner reviewed details', revision: 2 }, expectedRemoteDraftRevision: 1,
    approvalId: 'approval', actionId: 'action', intentCommandId: '22222222-2222-4222-8222-222222222222', permission: { id: 'permission', sourceMessageId: message.id, sourceMessageHash: fingerprint(message), basis: 'requested_followup', expiresAt: '2026-09-09T12:00:00.000Z' },
    binding: { kind: 'thread_participant', threadId: 'thread', sourceMessageId: message.id, sourceMessageHash: fingerprint(message) }, expiresAt: '2026-09-09T12:00:00.000Z' } });
  return { options, auth, google, execution, threads, pairing, command, coordinator: new OwnerCommandCoordinator({ auth, authorization: google }) };
}
it('authenticates and admits actual edited C3 draft/C4 permission/approval/intent without dispatch', async () => {
  const f = await approvalFixture();
  const receipt = await f.coordinator.apply(f.command, `Bearer ${f.pairing.credential}`);
  expect(receipt).toMatchObject({ status: 'applied', aggregateVersion: 3, authorityGeneration: 1 });
  const policy = new DynamoDispatchRepository(f.options, f.google);
  expect(await policy.loadIntent('22222222-2222-4222-8222-222222222222')).toMatchObject({ kind: 'standalone_reply', frozenMessage: { body: 'Owner reviewed details' } });
  expect((await f.threads.getReplyDraft('account', 'draft'))?.draft.body).toBe('Owner reviewed details');
  expect(await f.execution.readDispatch('account', 'action')).toMatchObject({ state: 'prepared', reservation: null });
  expect(await f.coordinator.apply(f.command, `Bearer ${f.pairing.credential}`)).toEqual(receipt);
});
it('revoked device cannot admit an approval even with current draft references', async () => {
  const f = await approvalFixture(); await f.auth.revokePairing(f.pairing.pairingId);
  await expect(f.coordinator.apply(f.command, `Bearer ${f.pairing.credential}`)).rejects.toThrow();
  expect(await new DynamoDispatchRepository(f.options, f.google).loadIntent('22222222-2222-4222-8222-222222222222')).toBeNull();
});
it('requires worker handoff identity for typed completion and keeps no-reply distinct from unknown', () => {
  const value = { ...envelope, kind: 'complete-manual', payload: { handoffId: 'handoff', targetHash: 'a'.repeat(64), outcome: {
    actionId: 'action', channel: 'linkedin', outcome: 'no_reply', observedAt: '2026-09-08T12:00:00.000Z', evidenceRef: 'human-report', replyText: null } } };
  expect(ownerCommandSchema.safeParse(value).success).toBe(true);
  expect(ownerCommandSchema.safeParse({ ...value, payload: { ...value.payload, handoffId: '' } }).success).toBe(false);
  expect(ownerCommandSchema.safeParse({ ...value, payload: { ...value.payload, outcome: { ...value.payload.outcome, outcome: 'provider_accepted' } } }).success).toBe(false);
});

import { workerEventSchema } from '../../../../src/shared/contracts/delegationContract';
it('admits exact handoff event receipt and rejects mismatch instead of authority by token shape alone', () => {
  const event = { id: 'event', workspaceId: 'ws', accountId: 'account', authorityGeneration: 1, aggregateVersion: 3, kind: 'manual.handoff',
    receipt: { commandId: envelope.commandId, status: 'applied', authorityGeneration: 1, aggregateVersion: 3, reason: null },
    payload: { handoffId: 'handoff', expiresAt: '2026-09-08T12:01:00.000Z', actionId: 'action', channel: 'call', routeId: 'route', routeVersion: 1,
      targetHash: 'a'.repeat(64), contentHash: 'b'.repeat(64), contextRevision: 'context', campaign: { campaignId: 'campaign', campaignRevision: 1, enrollmentId: 'enrollment', enrollmentRevision: 1, stepId: 'step' } } };
  expect(workerEventSchema.safeParse(event).success).toBe(true);
  expect(workerEventSchema.safeParse({ ...event, receipt: { ...event.receipt, status: 'pending' } }).success).toBe(false);
});
it('requires explicit paused/active source identity and never treats raw queues or permission flags as configuration', async () => {
  const { ownerSourceConfigurationSchema } = await import('../../../../src/shared/contracts/ownerCommandContract');
  const config = { version: 1, workspaceId: 'ws', accountId: 'account', pairingId: 'pairing', revision: 1, state: 'paused', mailboxSubject: null, calendarId: null, research: null };
  expect(ownerSourceConfigurationSchema.safeParse(config).success).toBe(true);
  expect(ownerSourceConfigurationSchema.safeParse({ ...config, approvedSendCommandIds: ['intent'] }).success).toBe(false);
  expect(ownerSourceConfigurationSchema.safeParse({ ...config, senderAllowed: true }).success).toBe(false);
});
it('authenticates revisioned paused source configuration without grants or provider calls', async () => {
  const f = await approvalFixture();
  const config = { version: 1, workspaceId: 'ws', accountId: 'account', pairingId: f.pairing.pairingId, revision: 1, state: 'paused', mailboxSubject: null, calendarId: null, research: null };
  const command = { ...envelope, commandId: '33333333-3333-4333-8333-333333333333', kind: 'configure-owner', payload: { expectedConfigurationRevision: 0, configuration: config, mailScope: null } };
  expect(await f.coordinator.apply(command, `Bearer ${f.pairing.credential}`)).toMatchObject({ status: 'applied', aggregateVersion: 3 });
  expect(f.options.dynamo.inspect('OWNER_SOURCE#account')).toEqual(config);
  expect(await f.coordinator.apply(command, `Bearer ${f.pairing.credential}`)).toMatchObject({ status: 'applied' });
  await expect(f.coordinator.apply({ ...command, commandId: '44444444-4444-4444-8444-444444444444', expectedVersion: 3 }, `Bearer ${f.pairing.credential}`)).rejects.toThrow();
});

import { googleScopes } from '../src/googleGrantCapabilities';
import { mailScopeFingerprint } from '../../../../src/main/outreach/providers/gmailThreadProvider';
import { createHash, randomUUID } from 'node:crypto';
async function configuredManualFixture() {
  const f = await approvalFixture(); const now = f.options.clock.now(); const store = new DynamoStore(f.options);
  const google = new RemoteGoogleAuthorization({ auth: f.auth, config: { clientId: 'fictional.apps.googleusercontent.com', clientSecret: 'fictional', redirectUri: 'https://worker.example.test/oauth/callback', encryptionKey: Buffer.alloc(32, 7) }, fetch: async url => {
    if (String(url) === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'fictional', refresh_token: 'fictional-refresh', token_type: 'Bearer', expires_in: 3600, scope: `openid email ${googleScopes.relevant_read} ${googleScopes.send}` });
    if (String(url) === 'https://openidconnect.googleapis.com/v1/userinfo') return Response.json({ sub: 'mailbox', email: 'sender@example.test', email_verified: true });
    throw new Error('Unconfigured network forbidden');
  } });
  const grant = await google.beginGoogleGrant(f.pairing.pairingId, ['relevant_read','send']);
  await google.completeGoogleGrant(new URL(grant.authorizationUrl).searchParams.get('state')!, 'fictional-code');
  const account = { id: 'account', name: 'Fictional PM', domain: null, version: 1 };
  const route = { id: 'route', accountId: 'account', personId: null, channel: 'phone', value: '+12025550123', version: 1, purpose: 'business', verification: 'published', evidenceIds: ['source'] };
  await store.transact([store.put('ACCOUNT#account', { account, sources: [{ id: 'source', url: 'https://example.invalid/team', fetchedAt: now, sha256: 'a'.repeat(64), excerpt: 'Fictional published phone', permitted: true }], claims: [], routes: [route], researchRevision: 1, history: [{ at: now, account, claims: [], routes: [route] }] }, null)]);
  const coordinator = new OwnerCommandCoordinator({ auth: f.auth, authorization: google });
  let version = 2;
  const apply = async (kind: string, payload: unknown) => {
    const command = { ...envelope, commandId: randomUUID(), expectedVersion: version, kind, payload };
    const receipt = await coordinator.apply(command, `Bearer ${f.pairing.credential}`); version = receipt.aggregateVersion; return { command, receipt };
  };
  await apply('configure-owner', { expectedConfigurationRevision: 0, configuration: { version: 1, workspaceId: 'ws', accountId: 'account', pairingId: f.pairing.pairingId, revision: 1, state: 'active', mailboxSubject: 'mailbox', calendarId: null, research: null }, mailScope: { expectedEnvelopeRevision: 1, since: now } });
  const scope = (await f.threads.scope('account','mailbox'))!;
  await f.threads.beginPoll('account','mailbox','actual-poll');
  await f.threads.applyPage({ threads: [], complete: true, nextCursor: { version: 1, accountId: 'account', mailboxSubject: 'mailbox', scopeRevision: scope.revision, scopeFingerprint: mailScopeFingerprint(scope), mode: 'history', historyId: '2', pageToken: null, since: scope.since } }, null, 'actual-poll');
  return { ...f, store, coordinator, apply, route, getVersion: () => version };
}
it('joins actual campaign approval/cap with authenticated exact one-shot manual handoff and typed outcome', async () => {
  const f = await configuredManualFixture();
  const version = { id: 'campaign-version', campaignId: 'campaign', version: 1, audienceHash: 'a'.repeat(64), offer: 'Fictional offer', objective: 'meeting', cohortAccountIds: ['account'], approvedAt: null,
    steps: [{ id: 'call-step', channel: 'call', condition: 'initial', delayHours: 0 }], capScope: 'campaign_version_lifetime', channelCaps: { call: 1, email: 0, linkedin: 0 }, contentPolicyHash: 'b'.repeat(64) };
  await f.apply('campaign-command', { kind: 'campaign.version', version });
  await f.apply('campaign-command', { kind: 'campaign.approve', campaignVersionId: version.id, snapshotHash: fingerprint(version), approvedAt: f.options.clock.now() });
  await f.apply('campaign-command', { kind: 'campaign.enroll', enrollmentId: 'enrollment', campaignVersionId: version.id, selectedRouteId: 'route', executionContextId: 'context', contextRevision: 1 });
  const payload = { actionId: 'manual-action', channel: 'call', routeId: 'route', routeVersion: 1, targetHash: createHash('sha256').update(f.route.value).digest('hex'), contentHash: 'b'.repeat(64), contextRevision: 'context', campaign: { campaignId: 'campaign', campaignRevision: 1, enrollmentId: 'enrollment', enrollmentRevision: 1, stepId: 'call-step' } };
  const handoff = await f.apply('prepare-manual', payload);
  const events = await f.store.eventsAfter(null); const event = events.events.find(event => event.kind === 'manual.handoff');
  expect(event?.kind).toBe('manual.handoff'); if (event?.kind !== 'manual.handoff') throw new Error('Expected handoff');
  expect(f.options.dynamo.inspect('CAMPAIGN_CAP#campaign-version#call')).toEqual({ reserved: 1, sent: 0 });
  expect(await f.coordinator.apply(handoff.command, `Bearer ${f.pairing.credential}`)).toEqual(handoff.receipt);
  await expect(f.apply('prepare-manual', payload)).rejects.toThrow();
  await f.apply('complete-manual', { handoffId: event.payload.handoffId, targetHash: payload.targetHash, outcome: { actionId: payload.actionId, channel: 'call', outcome: 'no_answer', observedAt: f.options.clock.now(), evidenceRef: 'human-report' } });
  expect(f.options.dynamo.inspect('CAMPAIGN_CAP#campaign-version#call')).toEqual({ reserved: 0, sent: 1 });
  const result = (await f.store.eventsAfter(null)).events.at(-1);
  expect(result).toMatchObject({ kind: 'manual.outcome', payload: { outcome: 'no_answer' }, campaign: { evidence: { routeVersion: 1, state: 'human_reported_sent' } } });
});
