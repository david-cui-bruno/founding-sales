import { createHash, randomUUID } from 'node:crypto';
import { ConditionalCommandHarness } from './sdkHarness';
import { DynamoStore, fingerprint } from '../src/dynamoStore';
import { WorkerAuth } from '../src/workerAuth';
import { RemoteGoogleAuthorization } from '../src/remoteGoogleAuthorization';
import { googleScopes } from '../src/googleGrantCapabilities';
import { OwnerCommandCoordinator } from '../src/ownerCommandCoordinator';
import { createExecutionRepository , executionAuthorityFields } from '../src/executionRepository';
import { DynamoThreadIntakeRepository } from '../src/threadIntakeRepository';
import { CampaignExecution } from '../src/campaignExecution';
import { WorkerCampaignRepository } from '../src/workerCampaignRepository';
import { DynamoDispatchRepository } from '../src/dispatchRepository';
import { mailScopeFingerprint } from '../../../../src/main/outreach/providers/gmailThreadProvider';
import type { Account, AccountRoute } from '../../../../src/shared/contracts/accountContract';

/** Actual C2/C6/D1 original call and authorized empty mailbox, never a synthetic inbound thread. */
export async function requestedCallFixture() {
  let now = '2026-09-09T00:04:00.000Z'; const dynamo = new ConditionalCommandHarness();
  const options = { dynamo, tableName: 't', workspaceId: 'ws', clock: { now: () => now } }; const store = new DynamoStore(options);
  const auth = new WorkerAuth(options); const invitation = await auth.issuePairing({ scopes: ['commands:write', 'events:read', 'google:grant'], expiresInSeconds: 300 });
  const pairing = await auth.redeemPairing(invitation.code, 'fictional-requested');
  const authorization = new RemoteGoogleAuthorization({ auth, config: { clientId: 'fictional.apps.googleusercontent.com', clientSecret: 'fictional', redirectUri: 'https://worker.example.invalid/oauth/callback', encryptionKey: Buffer.alloc(32, 7) }, fetch: async url => {
    if (String(url) === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'fictional', refresh_token: 'fictional-refresh', token_type: 'Bearer', expires_in: 3600, scope: `openid email ${googleScopes.relevant_read} ${googleScopes.send}` });
    if (String(url) === 'https://openidconnect.googleapis.com/v1/userinfo') return Response.json({ sub: 'mailbox', email: 'sender@example.invalid', email_verified: true });
    throw new Error('unconfigured external boundary');
  } });
  const grant = await authorization.beginGoogleGrant(pairing.pairingId, ['send', 'relevant_read']);
  await authorization.completeGoogleGrant(new URL(grant.authorizationUrl).searchParams.get('state')!, 'fictional-code');
  const account: Account = { id: 'acct', name: 'Fictional PM', domain: null, version: 1 };
  const routes: AccountRoute[] = [{ id: 'phone', accountId: 'acct', personId: null, channel: 'phone', value: '+12025550123', purpose: 'business', evidenceIds: ['source'], verification: 'published', version: 1 },
    { id: 'email', accountId: 'acct', personId: null, channel: 'email', value: 'recipient@example.invalid', purpose: 'business', evidenceIds: ['source'], verification: 'published', version: 1 }];
  await store.transact([store.put('ACCOUNT#acct', { account, routes, sources: [{ id: 'source', url: 'https://example.invalid/team', fetchedAt: now, sha256: 'a'.repeat(64), excerpt: 'Fictional published business contacts', permitted: true }], claims: [], researchRevision: 1, history: [{ at: now, account, routes, claims: [] }] }, null)]);
  const campaigns = new CampaignExecution(new WorkerCampaignRepository(options)); const policy = new DynamoDispatchRepository(options, authorization, campaigns);
  const execution = createExecutionRepository({ ...options, dispatchPolicy: policy }); await execution.seedLocalAuthority('acct');
  await execution.applyCommand({ commandId: 'delegate', workspaceId: 'ws', accountId: 'acct', expectedAuthorityGeneration: 0, expectedVersion: 0, kind: 'delegate', payload: { delegationId: 'explicit', approvedAt: now } });
  const owner = new OwnerCommandCoordinator({ auth, authorization });
  const apply = async (kind: string, payload: unknown) => {
    const command = { commandId: randomUUID(), workspaceId: 'ws', accountId: 'acct', expectedAuthorityGeneration: 1, expectedVersion: await execution.currentVersion('acct'), kind, payload };
    await owner.apply(command, `Bearer ${pairing.credential}`); return command;
  };
  await apply('configure-owner', { expectedConfigurationRevision: 0, configuration: { version: 1, workspaceId: 'ws', accountId: 'acct', pairingId: pairing.pairingId, revision: 1, state: 'active', mailboxSubject: 'mailbox', calendarId: null, research: null }, mailScope: { expectedEnvelopeRevision: null, since: now } });
  const threads = new DynamoThreadIntakeRepository(options); const scope = (await threads.scope('acct', 'mailbox'))!;
  await threads.beginPoll('acct', 'mailbox', 'original-poll');
  await threads.applyPage({ threads: [], complete: true, nextCursor: { version: 1, accountId: 'acct', mailboxSubject: 'mailbox', scopeRevision: scope.revision, scopeFingerprint: mailScopeFingerprint(scope), mode: 'history', historyId: '1', pageToken: null, since: scope.since } }, null, 'original-poll');
  const version = { id: 'call-version', campaignId: 'call-campaign', version: 1, audienceHash: 'a'.repeat(64), offer: 'Fictional offer', objective: 'meeting', cohortAccountIds: ['acct'], approvedAt: null as null,
    steps: [{ id: 'call-step', channel: 'call', condition: 'initial', delayHours: 0 }, { id: 'later-step', channel: 'call', condition: 'no_reply', delayHours: 24 }], capScope: 'campaign_version_lifetime', channelCaps: { call: 2, email: 0, linkedin: 0 }, contentPolicyHash: 'b'.repeat(64) };
  await apply('campaign-command', { kind: 'campaign.version', version });
  await apply('campaign-command', { kind: 'campaign.approve', campaignVersionId: version.id, snapshotHash: fingerprint(version), approvedAt: now });
  await apply('campaign-command', { kind: 'campaign.enroll', enrollmentId: 'call-enrollment', campaignVersionId: version.id, selectedRouteId: 'phone', executionContextId: 'call-context', contextRevision: 1 });
  const targetHash = createHash('sha256').update(routes[0]!.value).digest('hex');
  await apply('prepare-manual', { actionId: 'call-action', channel: 'call', routeId: 'phone', routeVersion: 1, targetHash, contentHash: 'b'.repeat(64), contextRevision: 'call-context', campaign: { campaignId: 'call-campaign', campaignRevision: 1, enrollmentId: 'call-enrollment', enrollmentRevision: 1, stepId: 'call-step' } });
  const handoff = (await execution.eventsAfter(null)).events.find(event => event.kind === 'manual.handoff');
  if (handoff?.kind !== 'manual.handoff') throw new Error('missing actual handoff');
  const command = await apply('complete-manual', { handoffId: handoff.payload.handoffId, targetHash, outcome: { actionId: 'call-action', channel: 'call', outcome: 'connected', observedAt: now, evidenceRef: 'owner-reported-request-call' } });
  const event = (await execution.eventsAfter(null)).events.find(event => event.kind === 'manual.outcome' && event.receipt.commandId === command.commandId);
  if (!event) throw new Error('missing actual call result');
  const originalCall = { commandId: command.commandId, handoffId: handoff.payload.handoffId, actionId: 'call-action', commandFingerprint: fingerprint(command), outcomeEventId: event.id, outcomeEventHash: fingerprint(event) };
  await policy.configureCaps({ sender: 'sender@example.invalid', dailyLimit: 3 }, null);
  return { options, dynamo, store, auth, pairing, authorization, owner, execution, policy, campaigns, threads, apply, originalCall, advance: (value: string) => { now = value; } };
}

import { DynamoRequestedFollowupRepository } from '../src/requestedFollowupRepository';
import { requestedFollowupContextRevision } from '../../../../src/main/outreach/requestedFollowupService';
import type { RequestedFollowupDraft } from '../../../../src/shared/contracts/requestedFollowupContract';
import { loadRequestedApproval } from '../src/requestedFollowupApproval';
import { workerEventSchema } from '../../../../src/shared/contracts/delegationContract';
export async function requestedCapturedFixture(ownerSupplied = false) {
  const f = await requestedCallFixture(); const drafts = new DynamoRequestedFollowupRepository(f.options);
  const recipientBinding = ownerSupplied ? { kind: 'owner_supplied' as const, email: 'recipient@example.invalid', originalCall: f.originalCall }
    : { kind: 'account_route' as const, routeId: 'email', routeVersion: 1, email: 'recipient@example.invalid' };
  const context = await drafts.readContext({ accountId: 'acct', originalCall: f.originalCall, recipientBinding, expectedAccountVersion: 1, mode: 'manual' });
  const draft: RequestedFollowupDraft = { kind: 'requested_phone_followup', id: 'requested-draft', accountId: 'acct', revision: 1, mailboxSubject: 'mailbox', sender: 'sender@example.invalid', recipient: recipientBinding.email,
    recipientBinding, originalCall: f.originalCall, accountVersion: 1, researchRevision: 1, mailContext: context.mailContext, contextRevision: '0'.repeat(64), subject: 'Requested information', body: 'Owner reviewed details.',
    evidenceIds: [f.originalCall.outcomeEventId], generation: 'edited', updatedAt: f.options.clock.now() };
  draft.contextRevision = requestedFollowupContextRevision(draft); await drafts.save(draft, null);
  const command = await f.apply('approve-requested-followup', { draft, expectedRemoteDraftRevision: 1, approvalId: 'requested-approval', actionId: 'requested-email', intentCommandId: '11111111-1111-4111-8111-111111111111',
    request: { statement: 'recipient_requested_information_by_email', recipient: draft.recipient }, expiresAt: '2026-09-10T00:00:00.000Z' });
  return { ...f, drafts, draft, command };
}
export async function materializeRequested(f: Awaited<ReturnType<typeof requestedCapturedFixture>>) {
  const plan = await f.policy.planRequestedAdmission(f.command.commandId);
  const action = await f.execution.planPrepareAction(plan.preparedInput, plan.authority.data);
  const capture = await loadRequestedApproval(f.store, f.command.commandId); if (!capture) throw new Error('missing capture');
  const next = { ...plan.authority.data, version: plan.authority.data.version + 1 };
  const event = workerEventSchema.parse({ id: `requested-materialized-${fingerprint(f.command)}`, workspaceId: 'ws', accountId: 'acct', authorityGeneration: next.authority.generation, aggregateVersion: next.version,
    kind: 'requested_followup.status', payload: { commandId: f.command.commandId, draftId: f.draft.id, status: { receipt: capture.receipt, state: 'materialized', intentCommandId: plan.intent.commandId, reason: null } }, campaign: plan.campaign });
  const outbox = await f.store.eventItems(event);
  if (Date.parse(f.options.clock.now()) >= plan.validUntil) throw new Error('expired materialization');
  await f.store.transact([f.store.put(plan.authority.key, next, plan.authority.rev, executionAuthorityFields(next), executionAuthorityFields(plan.authority.data)), ...plan.items, ...action.items, ...outbox.items]);
  return plan.intent;
}
