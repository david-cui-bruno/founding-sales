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

import { workerEventSchema } from '../../../../src/shared/contracts/delegationContract';
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
