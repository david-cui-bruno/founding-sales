import { expect, it } from 'vitest';
import { ownerCommandSchema, ownerSourceKey, type OwnerSourceConfiguration, type OwnerCommand } from '../../../../src/shared/contracts/ownerCommandContract';
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
  expect(ownerCommandSchema.safeParse({ ...command, payload: { ...command.payload, campaign: null as null } }).success).toBe(false);
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
import { WorkerAuth, pairingKey } from '../src/workerAuth';
import { RemoteGoogleAuthorization } from '../src/remoteGoogleAuthorization';
import { createExecutionRepository, executionAuthorityKey, executionAuthorityFields, authorityRecordSchema } from '../src/executionRepository';
import { DynamoThreadIntakeRepository, mailDraftKey, mailThreadKey } from '../src/threadIntakeRepository';
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
  await threads.applyPage({ complete: true, nextCursor: { version: 1, accountId: 'account', mailboxSubject: 'mailbox', mode: 'history', historyId: '1', pageToken: null as null, since: now },
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
  expect(await f.execution.readDispatch('account', 'action')).toMatchObject({ state: 'prepared', reservation: null as null });
  expect(await f.coordinator.apply(f.command, `Bearer ${f.pairing.credential}`)).toEqual(receipt);
});
it('revoked device cannot admit an approval even with current draft references', async () => {
  const f = await approvalFixture(); await f.auth.revokePairing(f.pairing.pairingId);
  await expect(f.coordinator.apply(f.command, `Bearer ${f.pairing.credential}`)).rejects.toThrow();
  expect(await new DynamoDispatchRepository(f.options, f.google).loadIntent('22222222-2222-4222-8222-222222222222')).toBeNull();
});
it('requires worker handoff identity for typed completion and keeps no-reply distinct from unknown', () => {
  const value = { ...envelope, kind: 'complete-manual', payload: { handoffId: 'handoff', targetHash: 'a'.repeat(64), outcome: {
    actionId: 'action', channel: 'linkedin', outcome: 'no_reply', observedAt: '2026-09-08T12:00:00.000Z', evidenceRef: 'human-report', replyText: null as null } } };
  expect(ownerCommandSchema.safeParse(value).success).toBe(true);
  expect(ownerCommandSchema.safeParse({ ...value, payload: { ...value.payload, handoffId: '' } }).success).toBe(false);
  expect(ownerCommandSchema.safeParse({ ...value, payload: { ...value.payload, outcome: { ...value.payload.outcome, outcome: 'provider_accepted' } } }).success).toBe(false);
});

import { workerEventSchema, publicDelegationCommandSchema } from '../../../../src/shared/contracts/delegationContract';
it('admits exact handoff event receipt and rejects mismatch instead of authority by token shape alone', () => {
  const event = { id: 'event', workspaceId: 'ws', accountId: 'account', authorityGeneration: 1, aggregateVersion: 3, kind: 'manual.handoff',
    receipt: { commandId: envelope.commandId, status: 'applied', authorityGeneration: 1, aggregateVersion: 3, reason: null as null },
    payload: { handoffId: 'handoff', expiresAt: '2026-09-08T12:01:00.000Z', actionId: 'action', channel: 'call', routeId: 'route', routeVersion: 1,
      targetHash: 'a'.repeat(64), contentHash: 'b'.repeat(64), contextRevision: 'context', campaign: { campaignId: 'campaign', campaignRevision: 1, enrollmentId: 'enrollment', enrollmentRevision: 1, stepId: 'step' } } };
  expect(workerEventSchema.safeParse(event).success).toBe(true);
  expect(workerEventSchema.safeParse({ ...event, receipt: { ...event.receipt, status: 'pending' } }).success).toBe(false);
});
it('requires explicit paused/active source identity and never treats raw queues or permission flags as configuration', async () => {
  const { ownerSourceConfigurationSchema } = await import('../../../../src/shared/contracts/ownerCommandContract');
  const config = { version: 1, workspaceId: 'ws', accountId: 'account', pairingId: 'pairing', revision: 1, state: 'paused', mailboxSubject: null as null, calendarId: null as null, research: null as null };
  expect(ownerSourceConfigurationSchema.safeParse(config).success).toBe(true);
  expect(ownerSourceConfigurationSchema.safeParse({ ...config, approvedSendCommandIds: ['intent'] }).success).toBe(false);
  expect(ownerSourceConfigurationSchema.safeParse({ ...config, senderAllowed: true }).success).toBe(false);
});
it('authenticates revisioned paused source configuration without grants or provider calls', async () => {
  const f = await approvalFixture();
  const config = { version: 1, workspaceId: 'ws', accountId: 'account', pairingId: f.pairing.pairingId, revision: 1, state: 'paused', mailboxSubject: null as null, calendarId: null as null, research: null as null };
  const command = { ...envelope, commandId: '33333333-3333-4333-8333-333333333333', kind: 'configure-owner', payload: { expectedConfigurationRevision: 0, configuration: config, mailScope: null as null } };
  expect(await f.coordinator.apply(command, `Bearer ${f.pairing.credential}`)).toMatchObject({ status: 'applied', aggregateVersion: 3 });
  expect(f.options.dynamo.inspect('OWNER_SOURCE#account')).toEqual(config);
  expect(await f.coordinator.apply(command, `Bearer ${f.pairing.credential}`)).toMatchObject({ status: 'applied' });
  await expect(f.coordinator.apply({ ...command, commandId: '44444444-4444-4444-8444-444444444444', expectedVersion: 3 }, `Bearer ${f.pairing.credential}`)).rejects.toThrow();
});

import { googleScopes } from '../src/googleGrantCapabilities';
import { mailScopeFingerprint } from '../../../../src/main/outreach/providers/gmailThreadProvider';
import { createHash, randomUUID } from 'node:crypto';
async function configuredManualFixture(channel:'call'|'linkedin'='call',mail=true) {
  const f = mail?await approvalFixture():await phoneOnlyFixture(); const now = f.options.clock.now(); const store = new DynamoStore(f.options);
  const google = new RemoteGoogleAuthorization({ auth: f.auth, config: { clientId: 'fictional.apps.googleusercontent.com', clientSecret: 'fictional', redirectUri: 'https://worker.example.test/oauth/callback', encryptionKey: Buffer.alloc(32, 7) }, fetch: async url => {
    if (String(url) === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'fictional', refresh_token: 'fictional-refresh', token_type: 'Bearer', expires_in: 3600, scope: `openid email ${googleScopes.relevant_read} ${googleScopes.send}` });
    if (String(url) === 'https://openidconnect.googleapis.com/v1/userinfo') return Response.json({ sub: 'mailbox', email: 'sender@example.test', email_verified: true });
    if(String(url).includes('/history?')) return Response.json({historyId:'3',history:[]});
    throw new Error('Unconfigured network forbidden');
  } });
  if(mail){const grant = await google.beginGoogleGrant(f.pairing.pairingId, ['relevant_read','send']);
  await google.completeGoogleGrant(new URL(grant.authorizationUrl).searchParams.get('state')!, 'fictional-code');}
  const account = { id: 'account', name: 'Fictional PM', domain: null as null, version: 1 };
  const route:import('../../../../src/shared/contracts/accountContract').AccountRoute = { id: 'route', accountId: 'account', personId: null as null, channel: channel==='call'?'phone':'linkedin', value: channel==='call'?'+12025550123':'https://www.linkedin.com/in/fictional-pm', version: 1, purpose: 'business', verification: 'published', evidenceIds: ['source'] };
  await store.transact([store.put('ACCOUNT#account', { account, sources: [{ id: 'source', url: 'https://example.invalid/team', fetchedAt: now, sha256: 'a'.repeat(64), excerpt: 'Fictional published phone', permitted: true }], claims: [], routes: [route], researchRevision: 1, history: [{ at: now, account, claims: [], routes: [route] }] }, null)]);
  const coordinator = new OwnerCommandCoordinator({ auth: f.auth, authorization: google });
  let version = mail?2:1;
  const apply = async (kind: string, payload: unknown) => {
    const command = { ...envelope, commandId: randomUUID(), expectedVersion: version, kind, payload };
    const receipt = await coordinator.apply(command, `Bearer ${f.pairing.credential}`); version = receipt.aggregateVersion; return { command, receipt };
  };
  await apply('configure-owner', { expectedConfigurationRevision: 0, configuration: { version: 1, workspaceId: 'ws', accountId: 'account', pairingId: f.pairing.pairingId, revision: 1, state: 'active', mailboxSubject: mail?'mailbox': null as null, calendarId: null as null, research: null as null }, mailScope: mail?{ expectedEnvelopeRevision: 1, since: now }: null as null });
  if(mail){
  const scope = (await f.threads.scope('account','mailbox'))!;
  await f.threads.beginPoll('account','mailbox','actual-poll');
  await f.threads.applyPage({ threads: [], complete: true, nextCursor: { version: 1, accountId: 'account', mailboxSubject: 'mailbox', scopeRevision: scope.revision, scopeFingerprint: mailScopeFingerprint(scope), mode: 'history', historyId: '2', pageToken: null as null, since: scope.since } }, null, 'actual-poll');
  }
  return { ...f, store, coordinator, apply, route, getVersion: () => version };
}
it('joins actual campaign approval/cap with authenticated exact one-shot manual handoff and typed outcome', async () => {
  const f = await configuredManualFixture();
  const version = { id: 'campaign-version', campaignId: 'campaign', version: 1, audienceHash: 'a'.repeat(64), offer: 'Fictional offer', objective: 'meeting', cohortAccountIds: ['account'], approvedAt: null as null,
    steps: [{ id: 'call-step', channel: 'call', condition: 'initial', delayHours: 0 }], capScope: 'campaign_version_lifetime', channelCaps: { call: 1, email: 0, linkedin: 0 }, contentPolicyHash: 'b'.repeat(64) };
  await f.apply('campaign-command', { kind: 'campaign.version', version });
  await f.apply('campaign-command', { kind: 'campaign.approve', campaignVersionId: version.id, snapshotHash: fingerprint(version), approvedAt: f.options.clock.now() });
  await f.apply('campaign-command', { kind: 'campaign.enroll', enrollmentId: 'enrollment', campaignVersionId: version.id, selectedRouteId: 'route', executionContextId: 'context', contextRevision: 1 });
  const payload = { actionId: 'manual-action', channel: 'call', routeId: 'route', routeVersion: 1, targetHash: createHash('sha256').update(f.route.value).digest('hex'), contentHash: 'b'.repeat(64), contextRevision: 'context', campaign: { campaignId: 'campaign', campaignRevision: 1, enrollmentId: 'enrollment', enrollmentRevision: 1, stepId: 'call-step' } };
  const handoff = await f.apply('prepare-manual', payload);
  const events = await f.store.eventsAfter(null); const event = events.events.find(event => event.kind === 'manual.handoff');
  expect(event?.kind).toBe('manual.handoff'); if (event?.kind !== 'manual.handoff') throw new Error('Expected handoff');
  expect(event.campaign?.cap).toMatchObject({revision:2,reserved:1,sent:0,channel:'call'});
  expect(f.options.dynamo.inspect('CAMPAIGN_CAP#campaign-version#call')).toEqual({ reserved: 1, sent: 0 });
  expect(await f.coordinator.apply(handoff.command, `Bearer ${f.pairing.credential}`)).toEqual(handoff.receipt);
  await expect(f.apply('prepare-manual', payload)).rejects.toThrow();
  await f.apply('complete-manual', { handoffId: event.payload.handoffId, targetHash: payload.targetHash, outcome: { actionId: payload.actionId, channel: 'call', outcome: 'no_answer', observedAt: f.options.clock.now(), evidenceRef: 'human-report' } });
  expect(f.options.dynamo.inspect('CAMPAIGN_CAP#campaign-version#call')).toEqual({ reserved: 0, sent: 1 });
  const result = (await f.store.eventsAfter(null)).events.at(-1);
  expect(result).toMatchObject({ kind: 'manual.outcome', payload: { outcome: 'no_answer' }, campaign: { evidence: { routeVersion: 1, state: 'human_reported_sent' }, cap:{revision:3,reserved:0,sent:1} } });
});

it('admits workspace research configuration through authenticated HTTP CAS without account authority or budget', async () => {
  const f=await approvalFixture();
  const {createWorkerHandler}=await import('../src/handler');
  const handle=createWorkerHandler({auth:f.auth,google:f.google,host:'worker.example.test'});
  const request=(body:unknown,credential=f.pairing.credential)=>handle({version:'2.0',rawPath:'/research/configure',rawQueryString:'',headers:{host:'worker.example.test','x-forwarded-proto':'https',authorization:`Bearer ${credential}`},body:JSON.stringify(body),requestContext:{domainName:'worker.example.test',http:{method:'POST',sourceIp:'fictional'}}});
  const value={commandId:'88888888-8888-4888-8888-888888888888',workspaceId:'ws',pairingId:f.pairing.pairingId,expectedRevision:0,configuration:{version:1,workspaceId:'ws',pairingId:f.pairing.pairingId,revision:1,state:'paused',research: null as null}};
  expect((await request(value)).statusCode).toBe(200);
  expect((await request(value)).statusCode).toBe(200);
  expect((await request({...value,commandId:'99999999-9999-4999-8999-999999999999'})).statusCode).toBe(400);
  expect((await request({...value,workspaceId:'other'})).statusCode).toBe(400);
  expect((await request({...value,allowed:true})).statusCode).toBe(400);
  const store=new DynamoStore(f.options);
  expect((await store.get<{state:string}>('OWNER_RESEARCH_SOURCE'))?.data.state).toBe('paused');
  expect(await store.list('BUDGET#')).toEqual([]);
  await f.auth.revokePairing(f.pairing.pairingId);
  expect((await request(value)).statusCode).toBe(401);
});

it('normal production factory composes the inactive source without secret loads or providers', async () => {
  const {createProductionServices,createProductionHandler}=await import('../src/handler');
  const f=await approvalFixture(); let io=0;
  const boundaries={dynamo:f.options.dynamo,ssm:{send:async()=>{io++;throw new Error('forbidden secrets');}},fetch:(async()=>{io++;throw new Error('forbidden providers');}) as typeof fetch};
  const env={DELEGATED_WORKER_ENABLED:'true',DELEGATED_WORKER_TABLE:'fictional',DELEGATED_WORKSPACE_ID:'ws',DELEGATED_WORKER_HOST:'worker.example.test',AWS_REGION:'us-east-1'};
  const services=await createProductionServices(env,boundaries);
  expect(await services!.source.tick(new AbortController().signal)).toMatchObject({status:'inactive'});
  const event={source:'aws.events','detail-type':'Scheduled Event',resources:['arn:aws:events:us-east-1:000000000000:rule/fictional']};
  expect((await createProductionHandler(env,boundaries)(event)).statusCode).toBe(400);
  expect(io).toBe(0);
});

it('authenticates a real C3 checkpoint separately from event catchup and rejects paused owners',async()=>{
 const f=await configuredManualFixture();
 const proof=await f.coordinator.checkpoint({workspaceId:'ws',accountId:'account'},`Bearer ${f.pairing.credential}`,new AbortController().signal);
 expect(proof).toMatchObject({workspaceId:'ws',accountId:'account',generation:1,version:f.getVersion()});
 expect(proof.validUntil).toBeLessThanOrEqual(Date.parse(f.options.clock.now())+5000);
 await f.execution.applyCommand({...envelope,commandId:'pause',expectedVersion:f.getVersion(),kind:'pause',payload:{reason:'owner pause'}});
 await expect(f.coordinator.checkpoint({workspaceId:'ws',accountId:'account'},`Bearer ${f.pairing.credential}`,new AbortController().signal)).rejects.toThrow();
});

async function startedManual(channel:'call'|'linkedin'='call',mail=true) {
 const f=await configuredManualFixture(channel,mail);
 const version={id:'late-campaign',campaignId:'late-campaign',version:1,audienceHash:'a'.repeat(64),offer:'Fictional offer',objective:'meeting',cohortAccountIds:['account'],approvedAt: null as null,steps:[{id:'step',channel,condition:'initial',delayHours:0}],capScope:'campaign_version_lifetime',channelCaps:{call:1,email:0,linkedin:1},contentPolicyHash:'b'.repeat(64)};
 await f.apply('campaign-command',{kind:'campaign.version',version});await f.apply('campaign-command',{kind:'campaign.approve',campaignVersionId:version.id,snapshotHash:fingerprint(version),approvedAt:f.options.clock.now()});await f.apply('campaign-command',{kind:'campaign.enroll',enrollmentId:'late-enrollment',campaignVersionId:version.id,selectedRouteId:'route',executionContextId:'context',contextRevision:1});
 const payload={actionId:'late-action',channel,routeId:'route',routeVersion:1,targetHash:createHash('sha256').update(f.route.value).digest('hex'),contentHash:'b'.repeat(64),contextRevision:'context',campaign:{campaignId:'late-campaign',campaignRevision:1,enrollmentId:'late-enrollment',enrollmentRevision:1,stepId:'step'}};
 await f.apply('prepare-manual',payload);const event=(await f.store.eventsAfter(null)).events.find(event=>event.kind==='manual.handoff');if(event?.kind!=='manual.handoff')throw Error('handoff missing');
 const report=async(outcome:string,generation=1)=>f.coordinator.apply({...envelope,commandId:randomUUID(),expectedVersion:await f.execution.currentVersion('account'),expectedAuthorityGeneration:generation,kind:'complete-manual',payload:{handoffId:event.payload.handoffId,targetHash:payload.targetHash,outcome:{actionId:payload.actionId,channel,outcome,observedAt:f.options.clock.now(),evidenceRef:randomUUID()}}},`Bearer ${f.pairing.credential}`);
 return {...f,report};
}
it.each(['pause','revoke'] as const)('records immutable started-call results and opt-out after %s without restoring execution',async(kind)=>{
 const f=await startedManual();await f.execution.applyCommand({...envelope,commandId:randomUUID(),expectedVersion:await f.execution.currentVersion('account'),kind,payload:{reason:'explicit stop'}});
 const generation=kind==='revoke'?2:1;await f.report('connected',generation);await f.report('opt_out',generation);
 expect((await f.store.get<{authority:{state:string;generation:number}}>('AUTH#account'))?.data.authority).toMatchObject({state:kind==='revoke'?'revoked':'paused',generation});
 expect((await f.store.eventsAfter(null)).events.at(-1)).toMatchObject({kind:'manual.outcome',authorityGeneration:1,payload:{outcome:'opt_out'}});
 expect(await f.store.get('MAIL_SUPPRESSION#account')).not.toBeNull();
});
it.each(['call','linkedin'] as const)('resolves %s unknown to a definitive human result without second handoff',async(channel)=>{
 const f=await startedManual(channel);await f.report('unknown');await f.report(channel==='call'?'connected':'human_reported_sent');
 expect((await f.store.eventsAfter(null)).events.filter(event=>event.kind==='manual.handoff')).toHaveLength(1);
 expect(f.options.dynamo.inspect(`CAMPAIGN_CAP#late-campaign#${channel}`)).toEqual({reserved:0,sent:1});
 await expect(f.report('unknown')).rejects.toThrow();
});
it.each([['not_called','connected'],['connected','not_called']] as const)('holds contradictory finalized human facts %s -> %s without rewriting capacity or last result',async(first,second)=>{
 const f=await startedManual();await f.report(first);
 const before=f.options.dynamo.inspect('CAMPAIGN_CAP#late-campaign#call');
 const handoff=(await f.store.list('MANUAL_HANDOFF#'))[0]!;const saved=handoff.stored.data as {lastOutcome:unknown};
 await f.report(second);
 expect(f.options.dynamo.inspect('CAMPAIGN_CAP#late-campaign#call')).toEqual(before);
 expect(((await f.store.list('MANUAL_HANDOFF#'))[0]!.stored.data as {lastOutcome:unknown}).lastOutcome).toEqual(saved.lastOutcome);
 expect((await f.store.eventsAfter(null)).events.at(-1)).toMatchObject({kind:'manual.outcome',payload:{outcome:second},campaign:{evidence:{conflict:'contradictory_finalized_outcome'}}});
});
it.each(['pause','revoke'] as const)('replays actual owner HTTP late manual facts into encrypted SQL after %s without restoring rights',async(stop)=>{
 const f=await startedManual();
 const {createPmFixture}=await import('../../../../tests/fixtures/pmAccounts');const local=await createPmFixture();
 const {AccountRepository}=await import('../../../../src/main/domain/accounts/accountRepository');
 const {DelegationRepository}=await import('../../../../src/main/delegation/delegationRepository');
 const {SqlDelegationTransport}=await import('../../../../src/main/delegation/delegationSync');
 const {ExecutionClient}=await import('../../../../src/main/delegation/executionClient');
 const {createWorkerHandler}=await import('../src/handler');const {delegationCommandSchema}=await import('../../../../src/shared/contracts/delegationContract');
 try {
  const accounts=new AccountRepository({database:local.db,clock:f.options.clock,ids:{next:()=> 'account'},sourcePolicy:{attest:source=>source.url==='https://example.invalid/team'}});
  accounts.create({commandId:randomUUID(),name:'Fictional PM',domain: null as null});
  const {version:routeVersion,...route}=f.route;expect(routeVersion).toBe(1);
  accounts.admitEvidence({commandId:randomUUID(),accountId:'account',expectedVersion:1,claims:[],sources:[{id:'source',url:'https://example.invalid/team',fetchedAt:f.options.clock.now(),sha256:'a'.repeat(64),excerpt:'Fictional published phone',permitted:true}],routes:[route]});
  let repository=new DelegationRepository({database:local.db,workspaceId:'ws',clock:f.options.clock});repository.initializeLocalAuthority('account');
  const page=await f.store.eventsAfter(null);
  for(const event of page.events){
   const receipt='receipt' in event?event.receipt:event.kind==='authority.changed'?event.payload.receipt:null;
   if(receipt){const marker=await f.store.get<{command?:unknown}>(`COMMAND#${receipt.commandId}`);const command=marker?.data.command??{...envelope,commandId:'delegate',expectedAuthorityGeneration:0,expectedVersion:0,kind:'delegate',payload:{delegationId:'explicit',approvedAt:f.options.clock.now()}};repository.queueCommand(delegationCommandSchema.parse(command));}
   expect(repository.applyWorkerEvent(event)).toBe('applied');
  }
  const event=page.events.find(event=>event.kind==='manual.handoff');if(event?.kind!=='manual.handoff')throw Error('Missing actual handoff');
  repository.consumeManualHandoff({...event.payload,accountId:'account',authorityGeneration:1},()=>expect(local.db.raw.inTransaction).toBe(true));
  const transport=new SqlDelegationTransport({database:local.db,workspaceId:'ws',pairingId:f.pairing.pairingId,clock:f.options.clock});
  const handler=createWorkerHandler({auth:f.auth,google:f.google,host:'worker.example.test'});
  const http:typeof fetch=async(input,init)=>{const url=new URL(String(input));const response=await handler({version:'2.0',rawPath:url.pathname,rawQueryString:url.search.slice(1),headers:{host:url.host,'x-forwarded-proto':'https',authorization:new Headers(init?.headers).get('authorization')??''},body:init?.body,requestContext:{domainName:url.host,http:{method:init?.method??'GET',sourceIp:'fictional'}}});return new Response(response.body,{status:response.statusCode});};
  let client=new ExecutionClient({repository,transport,pairing:{workspaceId:'ws',endpoint:'https://worker.example.test',credential:f.pairing.credential},fetch:http});
  const send=async(kind:string,payload:unknown)=>{const command=delegationCommandSchema.parse({...envelope,commandId:randomUUID(),expectedVersion:repository.executionVersion('account'),expectedAuthorityGeneration:repository.authority('account')!.generation,kind,payload});await client.submit(command);await client.sync(new AbortController().signal);expect(repository.commandStatus(command.commandId)?.status).toBe('applied');};
  const queued=delegationCommandSchema.parse({...envelope,commandId:randomUUID(),expectedVersion:repository.executionVersion('account'),expectedAuthorityGeneration:1,kind:'complete-manual',payload:{handoffId:event.payload.handoffId,targetHash:event.payload.targetHash,outcome:{actionId:event.payload.actionId,channel:'call',outcome:'unknown',observedAt:f.options.clock.now(),evidenceRef:randomUUID()}}});
  repository.queueCommand(queued); // Device is offline before a remote stop advances AUTH.
  const remoteStop={...envelope,commandId:randomUUID(),expectedVersion:await f.execution.currentVersion('account'),kind:stop,payload:{reason:'Explicit remote stop'}};
  const stopped=await http('https://worker.example.test/commands',{method:'POST',headers:{authorization:`Bearer ${f.pairing.credential}`},body:JSON.stringify(remoteStop)});expect(stopped.status).toBe(200);
  const {openDatabase,closeDatabase}=await import('../../../../src/main/db/database');const {createTestWorkspaceKey}=await import('../../../../tests/fixtures/tempDatabase');
  closeDatabase(local.db);const key=createTestWorkspaceKey();const reopened=openDatabase({path:local.db.path,key});key.bytes.fill(0);local.db.raw=reopened.raw;local.db.kysely=reopened.kysely;
  repository=new DelegationRepository({database:local.db,workspaceId:'ws',clock:f.options.clock});
  client=new ExecutionClient({repository,transport:new SqlDelegationTransport({database:local.db,workspaceId:'ws',pairingId:f.pairing.pairingId,clock:f.options.clock}),pairing:{workspaceId:'ws',endpoint:'https://worker.example.test',credential:f.pairing.credential},fetch:http});
  await client.sync(new AbortController().signal);
  expect(repository.commandStatus(queued.commandId)?.status).toBe('applied');
  expect(repository.getCommand(queued.commandId)).toEqual(queued);
  for(const outcome of ['connected','opt_out'])await send('complete-manual',{handoffId:event.payload.handoffId,targetHash:event.payload.targetHash,outcome:{actionId:event.payload.actionId,channel:'call',outcome,observedAt:f.options.clock.now(),evidenceRef:randomUUID()}});
  expect(repository.authority('account')).toMatchObject({state:stop==='pause'?'paused':'revoked',generation:stop==='pause'?1:2});
  expect(local.db.raw.prepare('SELECT COUNT(*) n FROM delegated_manual_outcomes').get()).toEqual({n:3});
  expect(local.db.raw.prepare("SELECT 1 FROM pm_account_suppression_tombstones WHERE account_id='account'").get()).toBeTruthy();
  expect((await client.sync(new AbortController().signal)).applied).toBe(0);
 }finally{local.close();}
});

async function phoneOnlyFixture(){
 const options={dynamo:new ConditionalCommandHarness(),tableName:'fictional',workspaceId:'ws',clock:{now:()=> '2026-09-08T12:00:00.000Z'}};
 const auth=new WorkerAuth(options);const pairing=await auth.redeemPairing((await auth.issuePairing({scopes:['commands:write','events:read'],expiresInSeconds:300})).code,'fictional');
 const google=new RemoteGoogleAuthorization({auth});const execution=createExecutionRepository(options);await execution.seedLocalAuthority('account');
 await execution.applyCommand({...envelope,commandId:'delegate',expectedAuthorityGeneration:0,expectedVersion:0,kind:'delegate',payload:{delegationId:'explicit',approvedAt:options.clock.now()}});
 return {options,auth,pairing,google,execution,threads:new DynamoThreadIntakeRepository(options)};
}
it.each([true,false])('generic cancelled remains held and resolves on same handoff, mail=%s',async(mail)=>{
 const f=await startedManual('call',mail);await f.report('unknown');await f.report('cancelled');
 expect(f.options.dynamo.inspect('CAMPAIGN_CAP#late-campaign#call')).toEqual({reserved:1,sent:0});
 await expect(f.coordinator.checkpoint({workspaceId:'ws',accountId:'account'},`Bearer ${f.pairing.credential}`,new AbortController().signal)).rejects.toThrow();
 await f.report('not_called');expect(f.options.dynamo.inspect('CAMPAIGN_CAP#late-campaign#call')).toEqual({reserved:0,sent:0});
 expect((await f.store.eventsAfter(null)).events.filter(event=>event.kind==='manual.handoff')).toHaveLength(1);
});
it('registers authenticated sender policy configuration through the normal HTTP handler without provider calls',async()=>{
 const f=await configuredManualFixture();const {createWorkerHandler}=await import('../src/handler');const handler=createWorkerHandler({auth:f.auth,google:f.google,host:'worker.example.test'});
 const body={version:1,requestId:randomUUID(),workspaceId:'ws',pairingId:f.pairing.pairingId,mailboxSubject:'mailbox',expectedRevision:null as null,kind:'sender-caps',policy:{sender:'sender@example.test',dailyLimit:3}};
 const event={version:'2.0',rawPath:'/policies/configure',rawQueryString:'',headers:{host:'worker.example.test','x-forwarded-proto':'https',authorization:`Bearer ${f.pairing.credential}`},body:JSON.stringify(body),requestContext:{domainName:'worker.example.test',http:{method:'POST',sourceIp:'fictional'}}};
 const result=await handler(event);expect(result.statusCode).toBe(200);expect(JSON.parse(result.body)).toMatchObject({requestId:body.requestId,kind:'sender-caps',status:'applied',revision:1});
 expect(await handler(event)).toEqual(result);
});

it.each(['selected-large','ordinary-large','utf8-overlimit','ascii-overlimit','invalid-selected','wrong-endpoint'] as const)('bounds actual HTTP selected bootstrap by UTF-8 bytes: %s',async scenario=>{
 const now='2026-09-08T12:00:00.000Z';const auth=new WorkerAuth({dynamo:new ConditionalCommandHarness(),tableName:'fictional',workspaceId:'ws',clock:{now:()=>now}});
 const pairing=await auth.redeemPairing((await auth.issuePairing({scopes:['commands:write','events:read'],expiresInSeconds:300})).code,'fictional');
 const {createWorkerHandler}=await import('../src/handler');const handler=createWorkerHandler({auth,host:'worker.example.test'});
 const account={id:'selected',name:'Fictional selected PM',domain:null as null,version:1};
 const sources=Array.from({length:scenario==='ascii-overlimit'?21:9},(_,index)=>({id:`source-${index}`,url:`https://fictional.example.test/source-${index}`,fetchedAt:now,sha256:'a'.repeat(64),excerpt:scenario==='utf8-overlimit'?'界'.repeat(8000):'x'.repeat(10000),permitted:true}));
 const selected:Extract<OwnerCommand,{kind:'bootstrap-selected-account'}>={commandId:randomUUID(),workspaceId:'ws',accountId:account.id,expectedAuthorityGeneration:0,expectedVersion:0,kind:'bootstrap-selected-account',payload:{record:{account,history:[{at:now,account,claims:[],routes:[]}],sources,claims:[],routes:[],researchRevision:1},asOf:now,expectedResearchRevision:null as null,suppression:[]}};
 expect(ownerCommandSchema.safeParse(selected).success).toBe(true);
 const ordinary={...envelope,commandId:randomUUID(),kind:'pause',payload:{reason:'explicit'}};
 const body=scenario==='ordinary-large'?JSON.stringify(ordinary)+' '.repeat(66000):JSON.stringify(scenario==='invalid-selected'?{...selected,allowed:true}:selected);
 expect(Buffer.byteLength(body,'utf8')).toBeGreaterThan(65536);
 if(scenario==='utf8-overlimit'){expect(body.length).toBeLessThan(200000);expect(Buffer.byteLength(body,'utf8')).toBeGreaterThan(200000);}
 const result=await handler({version:'2.0',rawPath:scenario==='wrong-endpoint'?'/commands/reconcile':'/commands',rawQueryString:'',headers:{host:'worker.example.test','x-forwarded-proto':'https',authorization:`Bearer ${pairing.credential}`},body,requestContext:{domainName:'worker.example.test',http:{method:'POST',sourceIp:'fictional'}}});
 expect(result.statusCode).toBe(scenario==='selected-large'?200:400);
 expect(await auth.store.list('ACCOUNT#')).toHaveLength(scenario==='selected-large'?1:0);
 if(scenario==='selected-large')expect(JSON.parse(result.body)).toMatchObject({commandId:selected.commandId,status:'applied'});
 else expect(await auth.store.list('COMMAND#')).toEqual([]);
});

import { TransactWriteItemsCommand } from '@aws-sdk/client-dynamodb';
import { createWorkerHandler } from '../src/handler';

async function ordinaryOwnerFixture() {
  const f = await approvalFixture();
  const source: OwnerSourceConfiguration = { version: 1, workspaceId: 'ws', accountId: 'account', pairingId: f.pairing.pairingId, revision: 1, state: 'active', mailboxSubject: 'mailbox', calendarId: null, research: null };
  await f.auth.store.transact([f.auth.store.put(ownerSourceKey('account'), source, null)]);
  const draft = (await f.threads.getReplyDraft('account', 'draft'))!.draft;
  const request = { workspaceId: 'ws', expectedAuthorityGeneration: 1, previousDraft: draft, edit: { subject: 'Edited subject', body: 'Non-approving edit' } };
  const handler = createWorkerHandler({ auth: f.auth, google: f.google, host: 'ordinary.test' });
  const post = (body: unknown = request) => handler({ version: '2.0', rawPath: '/reply/draft', rawQueryString: '', headers: { host: 'ordinary.test', 'x-forwarded-proto': 'https', authorization: `Bearer ${f.pairing.credential}` }, body: JSON.stringify(body), requestContext: { domainName: 'ordinary.test', http: { method: 'POST', sourceIp: 'synthetic' } } });
  return { ...f, source, draft, request, post };
}

it.each(['source', 'authority', 'pairing', 'thread', 'draft'] as const)('ordinary owner transaction rejects a racing %s change without partial draft writes', async changed => {
  const f = await ordinaryOwnerFixture(), store = f.auth.store;
  const key = changed === 'source' ? ownerSourceKey('account') : changed === 'authority' ? executionAuthorityKey('account') : changed === 'pairing' ? pairingKey(f.pairing.pairingId) : changed === 'thread' ? mailThreadKey('account', 'thread') : mailDraftKey('account', 'draft');
  const row = (await store.get<Record<string, unknown>>(key))!;
  const data = changed === 'source' ? { ...row.data, revision: 2, state: 'paused' } : changed === 'pairing' ? { ...row.data, revoked: true, generation: 1 } : row.data;
  const fields = changed === 'authority' ? executionAuthorityFields(authorityRecordSchema.parse(data)) : {};
  let injected = false;
  f.options.dynamo.beforeTransaction = () => {
    f.options.dynamo.beforeTransaction = undefined;
    injected = true;
    // SDK boundary interception applies the competing write before checking the
    // actual production transaction. No owner/repository method is replaced.
    void f.options.dynamo.send(new TransactWriteItemsCommand({ TransactItems: [store.put(key, data, row.rev, fields)] }));
  };
  expect((await f.post()).statusCode).not.toBe(200);
  expect(injected).toBe(true);
  expect((await f.threads.getReplyDraft('account', 'draft'))?.draft).toEqual(f.draft);
  expect(await store.list('DISPATCH_PERMISSION#')).toEqual([]);
  expect(await store.list('DISPATCH_APPROVAL#')).toEqual([]);
  expect(await store.list('DISPATCH_INTENT#')).toEqual([]);
  const editTransaction = f.options.dynamo.transactions.at(-1)!;
  const keys = editTransaction.TransactItems!.map(item => item.ConditionCheck?.Key?.sk?.S ?? item.Put?.Item?.sk?.S);
  for (const required of [ownerSourceKey('account'), executionAuthorityKey('account'), pairingKey(f.pairing.pairingId), mailThreadKey('account', 'thread'), mailDraftKey('account', 'draft')]) expect(keys).toContain(required);
  expect(keys.some(key => key?.startsWith('TOKEN#'))).toBe(true);
});

it('ordinary owner enforces exact saved identities, base fingerprint and expected generation', async () => {
  const f = await ordinaryOwnerFixture();
  for (const patch of [{ id: 'missing' }, { accountId: 'foreign' }, { threadId: 'other' }, { mailboxSubject: 'other' }, { recipient: 'other@example.test' }, { sender: 'other@example.test' }, { evidenceIds: ['invented'] }, { body: 'Unsaved predecessor' }]) {
    expect((await f.post({ ...f.request, previousDraft: { ...f.draft, ...patch } })).statusCode).not.toBe(200);
  }
  expect((await f.post({ ...f.request, expectedAuthorityGeneration: 2 })).statusCode).not.toBe(200);
  expect((await f.post({ ...f.request, edit: { ...f.request.edit, allowed: true } })).statusCode).not.toBe(200);
  expect((await f.threads.getReplyDraft('account', 'draft'))?.draft).toEqual(f.draft);
});

it('ordinary canonical retry preserves the first owner timestamp and conflicts on different text', async () => {
  const f = await ordinaryOwnerFixture();
  const first = await f.post(); expect(first.statusCode).toBe(200);
  const canonical = JSON.parse(first.body);
  f.options.clock.now = () => '2026-09-08T12:00:01.000Z';
  const retry = await f.post(); expect(retry.statusCode).toBe(200); expect(JSON.parse(retry.body)).toEqual(canonical);
  expect((await f.post({ ...f.request, edit: { ...f.request.edit, body: 'Different next text' } })).statusCode).not.toBe(200);
  const writes = f.options.dynamo.transactions.flatMap(tx => tx.TransactItems ?? []).filter(item => item.Put?.Item?.sk?.S === mailDraftKey('account', 'draft'));
  expect(writes).toHaveLength(2); // fixture seed plus one canonical edit
});

// Configure replay uses the existing real auth/coordinator/repositories. Only
// external OAuth HTTP and the exact final Dynamo transaction can be faulted.
async function intakeReplayFixture(mail = true) {
  const { TransactWriteItemsCommand } = await import('@aws-sdk/client-dynamodb');
  const { mailCursorKey } = await import('../src/threadIntakeRepository');
  const harness = new ConditionalCommandHarness();
  const now = '2026-09-16T00:00:00.000Z';
  const accountId = 'fictional-intake-account';
  const commandId = randomUUID();
  let failFinal = false, failedFinal = 0;
  const attemptedCommands: string[] = [];
  const dynamo: import('../src/dynamoStore').DynamoAdapter = { async send(request) {
    if (request instanceof TransactWriteItemsCommand) {
      const items = request.input.TransactItems ?? [];
      const command = items.find(item => item.Put?.Item?.sk?.S === `COMMAND#${commandId}`)?.Put?.Item;
      if (command && items.some(item => item.Put?.Item?.sk?.S === ownerSourceKey(accountId))) {
        attemptedCommands.push(command.data!.S!);
        if (failFinal) { failFinal = false; failedFinal++; throw Error('Synthetic failure before final owner commit'); }
      }
    }
    return harness.send(request);
  } };
  const options = { dynamo, tableName: 'fictional-intake-replay', workspaceId: 'ws', clock: { now: () => now } };
  const auth = new WorkerAuth(options);
  const pairing = await auth.redeemPairing((await auth.issuePairing({ scopes: ['commands:write', 'events:read', 'google:grant'], expiresInSeconds: 300 })).code, 'fictional-intake-device');
  const http: string[] = [];
  const authorization = new RemoteGoogleAuthorization({ auth,
    config: { clientId: 'fictional.apps.googleusercontent.com', clientSecret: 'fictional', redirectUri: 'https://worker.example.test/oauth/callback', encryptionKey: Buffer.alloc(32, 9) },
    fetch: async input => {
      const url = String(input); http.push(url);
      if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'fictional', refresh_token: 'fictional', token_type: 'Bearer', expires_in: 3600, scope: `openid email ${googleScopes.relevant_read}` });
      if (url === 'https://openidconnect.googleapis.com/v1/userinfo') return Response.json({ sub: 'fictional-mailbox', email: 'owner@example.invalid', email_verified: true });
      throw Error('Unrelated external effect forbidden');
    } });
  if (mail) {
    const grant = await authorization.beginGoogleGrant(pairing.pairingId, ['relevant_read']);
    await authorization.completeGoogleGrant(new URL(grant.authorizationUrl).searchParams.get('state')!, 'fictional-code');
    expect((await authorization.status(pairing.pairingId)).grant?.grantedScopes).toContain(googleScopes.relevant_read);
    expect((await authorization.status(pairing.pairingId)).grant?.grantedScopes).not.toContain(googleScopes.send);
  }
  const coordinator = () => new OwnerCommandCoordinator({ auth, authorization });
  const bearer = `Bearer ${pairing.credential}`;
  const account = { id: accountId, name: 'Fictional Intake Company', domain: null, version: 1 };
  const sources = mail ? [{ id: 'intake-source', url: 'https://example.invalid/team', fetchedAt: now, sha256: 'a'.repeat(64), excerpt: 'Published business inbox team@example.invalid', permitted: true }] : [];
  const routes = mail ? [{ id: 'intake-route', accountId, personId: null, channel: 'email', value: 'team@example.invalid', version: 1, purpose: 'business', verification: 'published', evidenceIds: ['intake-source'] }] : [];
  await coordinator().apply({ commandId: randomUUID(), workspaceId: 'ws', accountId, expectedAuthorityGeneration: 0, expectedVersion: 0,
    kind: 'bootstrap-selected-account', payload: { record: { account, sources, routes, claims: [], researchRevision: 1, history: [{ at: now, account, claims: [], routes }] }, asOf: now, expectedResearchRevision: null, suppression: [] } }, bearer);
  const execution = createExecutionRepository(options);
  await execution.applyCommand({ commandId: randomUUID(), workspaceId: 'ws', accountId, expectedAuthorityGeneration: 0, expectedVersion: 1,
    kind: 'delegate', payload: { delegationId: randomUUID(), approvedAt: now } });
  const command = ownerCommandSchema.parse({ commandId, workspaceId: 'ws', accountId, expectedAuthorityGeneration: 1, expectedVersion: 2, kind: 'configure-owner',
    payload: { expectedConfigurationRevision: 0, configuration: { version: 1, workspaceId: 'ws', accountId, pairingId: pairing.pairingId, revision: 1, state: 'active', mailboxSubject: mail ? 'fictional-mailbox' : null, calendarId: null, research: null },
      mailScope: mail ? { expectedEnvelopeRevision: null, since: now } : null } });
  const freeze = (value: object): void => { Object.values(value).forEach(child => { if (child && typeof child === 'object') freeze(child); }); Object.freeze(value); };
  freeze(command);
  return { harness, options, auth, command, coordinator, bearer, accountId, commandId, now, http, attemptedCommands,
    cursorKey: mailCursorKey(accountId, 'fictional-mailbox'), failOnce() { failFinal = true; }, failures: () => failedFinal };
}

async function verifyIntakeReplay(mail: boolean) {
  const f = await intakeReplayFixture(mail);
  const commandJson = JSON.stringify(f.command);
  const authority = f.harness.inspect(executionAuthorityKey(f.accountId));
  const eventsBefore = (await f.auth.store.eventsAfter(null)).events.length;
  const durableBefore = await f.auth.store.list('');
  f.failOnce();
  await expect(f.coordinator().apply(f.command, f.bearer)).rejects.toThrow('Synthetic failure before final owner commit');
  expect(f.failures()).toBe(1);
  // All durable records and storage revisions are unchanged except the claim.
  // This includes cursor, intake/source, AUTH, COMMAND, event head and outbox.
  expect((await f.auth.store.list('')).filter(row => row.key !== `OWNER_COMMAND_CLAIM#${f.commandId}`)).toEqual(durableBefore);
  expect(f.harness.inspect(`COMMAND#${f.commandId}`)).toBeUndefined();
  expect(f.harness.inspect(ownerSourceKey(f.accountId))).toBeUndefined();
  expect(f.harness.inspect(executionAuthorityKey(f.accountId))).toEqual(authority);
  const claim = await f.auth.store.get(`OWNER_COMMAND_CLAIM#${f.commandId}`);
  expect(claim?.data).toMatchObject({ fingerprint: fingerprint(f.command), at: f.now });
  // Diagnostic only: the old split transaction has already admitted cursor v1.
  // The acceptance oracle below must also allow the repaired atomic boundary,
  // which leaves no cursor at this point. Never manufacture that state in setup.
  console.info('configure-owner partial-commit diagnostic', JSON.stringify({ mail,
    cursor: f.harness.inspect(f.cursorKey) ?? null, finalCommand: null, source: null, authority }));
  const restored = new OwnerCommandCoordinator({ auth: new WorkerAuth(f.options), authorization: f.coordinator().input.authorization });
  const receipt = await restored.apply(f.command, f.bearer);
  expect(receipt).toMatchObject({ commandId: f.commandId, status: 'applied', authorityGeneration: 1, aggregateVersion: 3 });
  expect(JSON.stringify(f.command)).toBe(commandJson);
  expect(await f.auth.store.get(`OWNER_COMMAND_CLAIM#${f.commandId}`)).toEqual(claim);
  expect(f.harness.inspect(ownerSourceKey(f.accountId))).toMatchObject({ revision: 1, mailboxSubject: mail ? 'fictional-mailbox' : null });
  expect(f.harness.inspect(executionAuthorityKey(f.accountId))).toMatchObject({ version: 3, authority: { owner: 'worker', state: 'active', generation: 1 } });
  if (mail) {
    const cursor = await new DynamoThreadIntakeRepository(f.options).cursorState(f.accountId, 'fictional-mailbox');
    expect(cursor).toMatchObject({ rev: 1, data: { scope: { revision: 1, participantAddresses: ['team@example.invalid'], knownThreadIds: [], since: f.now, approvedAt: f.now }, checkpoint: null, poll: null } });
  } else expect(f.harness.inspect(f.cursorKey)).toBeUndefined();
  const events = (await f.auth.store.eventsAfter(null)).events;
  expect(events).toHaveLength(eventsBefore + 1);
  expect(events.filter(event => event.kind === 'authority.changed' && event.payload.receipt.commandId === f.commandId)).toHaveLength(1);
  expect(f.harness.transactions.flatMap(transaction => transaction.TransactItems ?? []).filter(item => item.Put?.Item?.sk?.S === `COMMAND#${f.commandId}`)).toHaveLength(1);
  // Exercise completed replay after genuine intake progress, not merely null fields.
  if (mail) {
    const intake = new DynamoThreadIntakeRepository(f.options);
    const scope = (await intake.scope(f.accountId, 'fictional-mailbox'))!;
    const { mailScopeFingerprint } = await import('../../../../src/main/outreach/providers/gmailThreadProvider');
    const attemptId = 'fictional-completed-poll';
    await intake.beginPoll(f.accountId, 'fictional-mailbox', attemptId);
    const nextCursor = { version: 1 as const, accountId: f.accountId, mailboxSubject: 'fictional-mailbox',
      mode: 'history' as const, historyId: '11', pageToken: null, since: f.now,
      scopeRevision: scope.revision, scopeFingerprint: mailScopeFingerprint(scope) };
    expect(await intake.applyPage({ complete: true, nextCursor, threads: [] }, null, attemptId)).toEqual([]);
    expect(await intake.cursorState(f.accountId, 'fictional-mailbox')).toMatchObject({ rev: 3,
      data: { scope, checkpoint: nextCursor, poll: { attemptId, status: 'complete', startedAt: f.now, completedAt: f.now } } });
  }
  const durableCompleted = await f.auth.store.list('');
  const cursor = f.harness.inspect(f.cursorKey);
  const transactions = f.harness.transactions.length;
  expect(await restored.apply(f.command, f.bearer)).toEqual(receipt);
  expect(f.harness.inspect(f.cursorKey)).toEqual(cursor);
  expect(f.harness.transactions).toHaveLength(transactions);
  expect(await f.auth.store.list('')).toEqual(durableCompleted);
  expect((await f.auth.store.eventsAfter(null)).events).toEqual(events);
  for (const transaction of f.harness.transactions) {
    const targets = (transaction.TransactItems ?? []).map(item => {
      const key = item.Put?.Item ?? item.ConditionCheck?.Key;
      return `${key?.pk?.S}|${key?.sk?.S}`;
    });
    expect(new Set(targets).size).toBe(targets.length);
  }
  expect(f.attemptedCommands).toHaveLength(2);
  expect(f.attemptedCommands[0]).toBe(f.attemptedCommands[1]);
  expect(f.http.every(url => ['https://oauth2.googleapis.com/token', 'https://openidconnect.googleapis.com/v1/userinfo'].includes(url))).toBe(true);
}

it('configure-owner scope replay resumes the immutable command after scope admission but before final commit', async () => {
  await verifyIntakeReplay(true);
}, 20_000);

it('configure-owner scope replay keeps the no-mail path replayable after the same final-commit fault', async () => {
  await verifyIntakeReplay(false);
}, 20_000);

// The owner resubmits its saved record through the STANDARD owner path: replay by fingerprint,
// worker-owned active authority, real generation/version, claim, then one atomic receipt/event.
import type { AccountRecord } from '../../../../src/shared/contracts/accountRecordContract';
async function refreshFixture() {
  const f = await configuredManualFixture('call', false);
  // Every real ACCOUNT# writer (bootstrap, create, evidence, settle) stamps the accountId/version item fields the
  // refresh fence checks; the manual fixture seed above skipped them, so restore the real shape without changing data.
  const seeded = (await f.store.get<AccountRecord>('ACCOUNT#account'))!;
  await f.store.transact([f.store.put('ACCOUNT#account', seeded.data, seeded.rev, { accountId: 'account', version: seeded.data.account.version })]);
  const stored = f.options.dynamo.inspect('ACCOUNT#account') as AccountRecord;
  const later = '2026-09-08T12:01:00.000Z';
  const source = { id: 'local-source', url: 'https://example.invalid/team', fetchedAt: later, sha256: 'b'.repeat(64), excerpt: 'Locally admitted second phone', permitted: true };
  const route = { ...f.route, id: 'local-route', value: '+12025550124', evidenceIds: ['local-source'] };
  const account = { ...stored.account, version: stored.account.version + 1 };
  const appended: AccountRecord = { ...stored, account, sources: [...stored.sources, source], routes: [...stored.routes, route],
    history: [...stored.history, { at: later, account, claims: [], routes: [...stored.routes, route] }] };
  f.options.clock.now = () => later;
  const refresh = (record: AccountRecord, expectedResearchRevision = 1, asOf = later) => f.apply('refresh-selected-account-record', { record, asOf, expectedResearchRevision });
  const lastEvent = async () => (await f.store.eventsAfter(null)).events.at(-1);
  return { ...f, stored, appended, later, refresh, lastEvent, bearer: `Bearer ${f.pairing.credential}` };
}
it('binds the resubmitted record to its account and research revision and keeps it out of the public renderer schema', async () => {
  const f = await refreshFixture();
  const command = { ...envelope, commandId: randomUUID(), kind: 'refresh-selected-account-record', payload: { record: f.appended, asOf: f.later, expectedResearchRevision: 1 } };
  expect(ownerCommandSchema.safeParse(command).success).toBe(true);
  expect(ownerCommandSchema.safeParse({ ...command, accountId: 'other' }).success).toBe(false);
  expect(ownerCommandSchema.safeParse({ ...command, payload: { ...command.payload, expectedResearchRevision: 2 } }).success).toBe(false);
  expect(ownerCommandSchema.safeParse({ ...command, payload: { ...command.payload, suppression: [] } }).success).toBe(false);
  expect(ownerCommandSchema.safeParse({ ...command, payload: { ...command.payload, expectedResearchRevision: null } }).success).toBe(false);
  expect(publicDelegationCommandSchema.safeParse(command).success).toBe(false);
});
it('applies the appended record atomically with its receipt and account.refreshed event, replays exactly and treats the equal record as a duplicate', async () => {
  const f = await refreshFixture();
  const before = f.getVersion();
  const { command, receipt } = await f.refresh(f.appended);
  expect(receipt).toEqual({ commandId: command.commandId, status: 'applied', authorityGeneration: 1, aggregateVersion: before + 1, reason: null });
  expect(f.options.dynamo.inspect('ACCOUNT#account')).toEqual(f.appended);
  expect(f.options.dynamo.inspect('AUTH#account')).toEqual({ authority: { accountId: 'account', owner: 'worker', state: 'active', generation: 1 }, version: before + 1 });
  expect(await f.lastEvent()).toMatchObject({ kind: 'account.refreshed', accountId: 'account', authorityGeneration: 1, aggregateVersion: before + 1, receipt,
    payload: { commandId: command.commandId, recordFingerprint: fingerprint(f.appended), researchRevision: 1 } });
  const commit = f.options.dynamo.transactions.at(-1)!.TransactItems!.map(item => item.Put?.Item?.sk?.S ?? item.ConditionCheck?.Key?.sk?.S);
  expect(commit).toEqual(expect.arrayContaining(['ACCOUNT#account', 'AUTH#account', `COMMAND#${command.commandId}`]));
  const transactions = f.options.dynamo.transactions.length;
  expect(await f.coordinator.apply(command, f.bearer)).toEqual(receipt);
  expect(f.options.dynamo.transactions).toHaveLength(transactions);
  // The same record again is applied with duplicate semantics: receipt and event, no ACCOUNT# rewrite.
  const duplicate = await f.refresh(f.appended);
  expect(duplicate.receipt).toMatchObject({ status: 'applied', aggregateVersion: before + 2 });
  const duplicateCommit = f.options.dynamo.transactions.at(-1)!.TransactItems!;
  expect(duplicateCommit.some(item => item.Put?.Item?.sk?.S === 'ACCOUNT#account')).toBe(false);
  expect(duplicateCommit.some(item => item.ConditionCheck?.Key?.sk?.S === 'ACCOUNT#account')).toBe(true);
  expect(f.options.dynamo.inspect('ACCOUNT#account')).toEqual(f.appended);
  expect(await f.lastEvent()).toMatchObject({ kind: 'account.refreshed', payload: { commandId: duplicate.command.commandId, recordFingerprint: fingerprint(f.appended) } });
  // A further local admission is accepted only when it preserves the whole stored history at its head.
  const account = { ...f.appended.account, version: f.appended.account.version + 1 };
  const third = { ...f.appended, account, history: [...f.appended.history, { at: f.later, account, claims: [], routes: f.appended.routes }] };
  expect((await f.refresh(third)).receipt.status).toBe('applied');
  expect(f.options.dynamo.inspect('ACCOUNT#account')).toEqual(third);
});
it.each([
  ['record_identity_mismatch', (f: Awaited<ReturnType<typeof refreshFixture>>) => f.refresh({ ...f.appended, account: { ...f.appended.account, domain: 'other.invalid' }, history: f.appended.history.map(entry => ({ ...entry, account: { ...entry.account, domain: 'other.invalid' } })) })],
  ['record_research_stale', (f: Awaited<ReturnType<typeof refreshFixture>>) => f.refresh({ ...f.appended, researchRevision: 2 }, 2)],
  ['record_history_diverged', (f: Awaited<ReturnType<typeof refreshFixture>>) => f.refresh({ ...f.appended, history: [{ ...f.appended.history[0]!, at: f.later }, ...f.appended.history.slice(1)] })],
  ['route_evidence_missing', (f: Awaited<ReturnType<typeof refreshFixture>>) => f.refresh({ ...f.appended, sources: f.stored.sources })],
] as const)('records %s as a rejected receipt the founder can read and leaves the record untouched', async (code, attempt) => {
  const f = await refreshFixture();
  const before = f.getVersion();
  const { command, receipt } = await attempt(f);
  expect(receipt).toEqual({ commandId: command.commandId, status: 'rejected', authorityGeneration: 1, aggregateVersion: before + 1, reason: code });
  expect(f.options.dynamo.inspect('ACCOUNT#account')).toEqual(f.stored);
  expect(await f.lastEvent()).toMatchObject({ kind: 'authority.changed', aggregateVersion: before + 1, payload: { authority: { owner: 'worker', state: 'active', generation: 1 }, receipt } });
  expect(await f.coordinator.apply(command, f.bearer)).toEqual(receipt);
});
it('records record_not_newer when a resubmission carries an older account version than the worker already holds', async () => {
  const f = await refreshFixture();
  expect((await f.refresh(f.appended)).receipt.status).toBe('applied');
  const before = f.getVersion();
  const { command, receipt } = await f.refresh({ ...f.appended, account: { ...f.appended.account, version: f.stored.account.version } });
  expect(receipt).toEqual({ commandId: command.commandId, status: 'rejected', authorityGeneration: 1, aggregateVersion: before + 1, reason: 'record_not_newer' });
  expect(f.options.dynamo.inspect('ACCOUNT#account')).toEqual(f.appended);
  expect(await f.lastEvent()).toMatchObject({ kind: 'authority.changed', payload: { receipt } });
});
it('never accepts a saved record for a company the worker does not actively own, before any record check', async () => {
  const f = await refreshFixture();
  await f.execution.applyCommand({ ...envelope, commandId: randomUUID(), expectedVersion: f.getVersion(), kind: 'pause', payload: { reason: 'explicit pause' } });
  const paused = { ...envelope, commandId: randomUUID(), expectedVersion: f.getVersion() + 1, kind: 'refresh-selected-account-record', payload: { record: f.appended, asOf: f.later, expectedResearchRevision: 1 } };
  await expect(f.coordinator.apply(paused, f.bearer)).rejects.toThrow('stale_authority');
  const missing = { ...envelope, accountId: 'unowned', commandId: randomUUID(), kind: 'refresh-selected-account-record',
    payload: { record: { ...f.appended, account: { ...f.appended.account, id: 'unowned' }, routes: [], history: [{ at: f.later, account: { ...f.appended.account, id: 'unowned' }, claims: [], routes: [] }] }, asOf: f.later, expectedResearchRevision: 1 } };
  await expect(f.coordinator.apply(missing, f.bearer)).rejects.toThrow('authority_missing');
  expect(f.options.dynamo.inspect('ACCOUNT#account')).toEqual(f.stored);
  expect(await f.store.list('ACCOUNT#')).toHaveLength(1);
});
it('refuses a future or oversized resubmission as a protocol violation rather than a founder-readable rejection', async () => {
  const f = await refreshFixture();
  await expect(f.refresh(f.appended, 1, '2026-09-08T12:02:00.000Z')).rejects.toThrow('refresh_identity_conflict');
  await expect(f.refresh({ ...f.appended, sources: [...f.appended.sources, { ...f.appended.sources[0]!, id: 'future', fetchedAt: '2026-09-08T12:02:00.000Z' }] })).rejects.toThrow('refresh_evidence_conflict');
  expect(f.options.dynamo.inspect('ACCOUNT#account')).toEqual(f.stored);
});
