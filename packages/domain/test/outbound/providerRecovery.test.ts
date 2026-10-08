import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {dispatchOutboundMessage} from '../../outbound/send.ts';
import {reconcileOutboundMessage} from '../../outbound/reconcile.ts';
import {readFence,resolveUnknownTerminal} from '../../outbound/fence.ts';
import {createGmailHttpClient} from '../../mail/gmailClientHttp.ts';
import {setAdminCap,readRampStanding} from '../../outbound/ramp.ts';
import {prepareFor,seedFirm,openExtraSession,pausingAtTokenRefresh} from './support/dispatchFixtures.ts';
import {readProviderIncidents} from '../../outbound/providerIncidents.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {withTransaction} from '../../db/queryable.ts';
import {setProspectingAuthorization} from '../../outreach/authorization.ts';
import {runMailSync} from '../../mail/sync.ts';
import {completeGmailGrant,signGrantState} from '../../mail/oauth.ts';
import {staticSecretProvider} from '../../mail/secretProvider.ts';
import {randomBytes} from 'node:crypto';
import {recordAuthenticationChecklist,setAutomatedSendingEnabled} from '../../outbound/domainGuard.ts';
import {mailReconcileHandler} from '../../outbound/handlers.ts';
import {mailSyncHandler} from '../../mail/handlers.ts';
import {renewWatch} from '../../mail/watch.ts';
import {startRecovery,runMailRecovery} from '../../mail/recover.ts';
import {readMailbox} from '../../mail/mailboxes.ts';
import {claimJobs,enqueueJob} from '../../jobs/jobStore.ts';
import {readHeartbeats} from '../../jobs/heartbeats.ts';
import {createOutboundWorld,OPEN_INSTANT,type OutboundWorld} from './support/outboundWorld.ts';

describe('provider incident recovery through outbound callers',()=>{
 let world:OutboundWorld;
 beforeEach(async()=>{world=await createOutboundWorld();});
 afterEach(async()=>{await world.stop();});
 it('persists a Sent-read cooldown and observes the original send after its deadline without resubmission',async()=>{
  const ctx=world.systemContext(world.alpha.workspace.workspaceId);
  const gmail=world.clientWith(world.alpha,{sendBehaviour:'indeterminate_but_delivered'});
  const id=await world.prepare(world.alpha);
  await dispatchOutboundMessage(ctx,world.sendDeps(world.alpha,{gmail}),{outboundMessageId:id});
  const retryAt='2026-09-23T09:05:00.000Z';
  let searches=0;
  const limited={...gmail,searchSentByMessageId:async()=>{searches++;return {ok:false as const,reason:'rate_limited' as const,retryAt};}};
  const first=await reconcileOutboundMessage(ctx,world.reconcileDeps(world.alpha,{gmail:limited,now:()=>new Date(OPEN_INSTANT)}),{outboundMessageId:id});
  expect(first).toMatchObject({outcome:'rate_limited',retryAt});
  const restarted=world.systemContext(world.alpha.workspace.workspaceId);
  const waiting=await reconcileOutboundMessage(restarted,world.reconcileDeps(world.alpha,{gmail:limited,now:()=>new Date('2026-09-23T09:04:59.999Z')}),{outboundMessageId:id});
  expect(waiting).toMatchObject({outcome:'cooldown',retryAt});
  expect(searches).toBe(1);
  expect((await readFence(ctx,id))?.state).toBe('reconciling');
  expect(await reconcileOutboundMessage(restarted,world.reconcileDeps(world.alpha,{gmail,now:()=>new Date(retryAt)}),{outboundMessageId:id})).toMatchObject({outcome:'sent'});
  expect(gmail.sends).toHaveLength(1);
 });
 it('preserves a provider Retry-After instant through the production Sent-read adapter',async()=>{
  const client=createGmailHttpClient({apiBaseUrl:'https://fixture.invalid',fetch:async()=>({status:429,headers:{'retry-after':'Wed, 23 Sep 2026 09:05:00 GMT'},body:'{}'})});
  expect(await client.searchSentByMessageId({accessToken:'ephemeral-fixture',expiresAtEpochSeconds:0},'<fixture-id>')).toEqual({ok:false,reason:'rate_limited',retryAt:'2026-09-23T09:05:00.000Z'});
 });
 it('defers other dispatches while waiting and preserves a lower cap after verified recovery without an inactivity epoch',async()=>{
  const ctx=world.systemContext(world.alpha.workspace.workspaceId),box=world.alpha;
  await setAdminCap(ctx,{mailboxId:box.mailboxId,adminUserId:box.workspace.admin.userId,lowerTo:2});
  const gmail=world.clientWith(box,{sendBehaviour:'indeterminate_but_delivered'}),id=await world.prepare(box);
  await dispatchOutboundMessage(ctx,world.sendDeps(box,{gmail}),{outboundMessageId:id});
  const retryAt='2026-09-23T09:05:00.000Z';
  const limited={...gmail,searchSentByMessageId:async()=>({ok:false as const,reason:'rate_limited' as const,retryAt})};
  await reconcileOutboundMessage(ctx,world.reconcileDeps(box,{gmail:limited,now:()=>new Date(OPEN_INSTANT)}),{outboundMessageId:id});
  const next=await prepareFor(world,box,await seedFirm(world,box,'cooldown-other'));
  expect(await dispatchOutboundMessage(ctx,world.sendDeps(box),{outboundMessageId:next})).toMatchObject({outcome:'held',refusal:'rate_limited',retryAt});
  expect(box.gmail.sends).toHaveLength(0);
  expect(await dispatchOutboundMessage(ctx,world.sendDeps(box,{now:()=>new Date(retryAt)}),{outboundMessageId:next})).toMatchObject({outcome:'held',refusal:'provider_refusal'});
  expect((await readRampStanding(ctx,box.mailboxId))?.effectiveCap).toBe(2);
  await reconcileOutboundMessage(ctx,world.reconcileDeps(box,{gmail,now:()=>new Date(retryAt)}),{outboundMessageId:id});
  expect(await dispatchOutboundMessage(ctx,world.sendDeps(box,{now:()=>new Date(retryAt)}),{outboundMessageId:next})).toMatchObject({outcome:'sent'});
  expect((await readRampStanding(ctx,box.mailboxId))?.effectiveCap).toBe(2);
 });
 it.each([undefined,'malformed'])('holds a rate limit with an unavailable deadline (%s) instead of recovering from a later successful read',async retryAt=>{
  const ctx=world.systemContext(world.alpha.workspace.workspaceId),box=world.alpha;
  const gmail=world.clientWith(box,{sendBehaviour:'indeterminate_but_delivered'}),id=await world.prepare(box);
  await dispatchOutboundMessage(ctx,world.sendDeps(box,{gmail}),{outboundMessageId:id});
  const limited={...gmail,searchSentByMessageId:async()=>({ok:false as const,reason:'rate_limited' as const,retryAt})};
  await reconcileOutboundMessage(ctx,world.reconcileDeps(box,{gmail:limited,now:()=>new Date(OPEN_INSTANT)}),{outboundMessageId:id});
  expect(await reconcileOutboundMessage(ctx,world.reconcileDeps(box,{gmail,now:()=>new Date('2026-09-23T10:00:00Z')}),{outboundMessageId:id})).toMatchObject({outcome:'incident_held'});
  expect((await readProviderIncidents(ctx,box.mailboxId)).filter(i=>i.sourceKind==='sent_search')).toMatchObject([{state:'action_required'}]);
  expect(gmail.sends).toHaveLength(1);
 });
 it.each(['unknown','reputation'] as const)('never treats a %s incident deadline as safe recovery evidence',async classification=>{
  const ctx=world.systemContext(world.alpha.workspace.workspaceId),box=world.alpha;
  const gmail=world.clientWith(box,{sendBehaviour:'indeterminate_but_delivered'}),id=await world.prepare(box);
  await dispatchOutboundMessage(ctx,world.sendDeps(box,{gmail}),{outboundMessageId:id});
  const retryAt='2026-09-23T09:05:00.000Z';
  const refused={...gmail,searchSentByMessageId:async()=>({ok:false as const,reason:'rate_limited' as const,classification,retryAt})};
  await reconcileOutboundMessage(ctx,world.reconcileDeps(box,{gmail:refused,now:()=>new Date(OPEN_INSTANT)}),{outboundMessageId:id});
  expect(await reconcileOutboundMessage(ctx,world.reconcileDeps(box,{gmail,now:()=>new Date(retryAt)}),{outboundMessageId:id})).toMatchObject({outcome:'incident_held'});
  expect((await readProviderIncidents(ctx,box.mailboxId)).filter(i=>i.sourceKind==='sent_search')).toMatchObject([{classification,state:'action_required'}]);
 });
 it('requires explicit permission revalidation after authority changes during cooldown',async()=>{
  const box=world.alpha,ctx=world.systemContext(box.workspace.workspaceId);
  const admin=repositoryContext(workspaceScope(box.workspace.workspaceId,{kind:'user',userId:box.workspace.admin.userId,role:'admin'}),world.database.session);
  const permission=(expectedRevision:number,enabled:boolean)=>withTransaction(world.database.session,()=>setProspectingAuthorization(admin,{mailboxId:box.mailboxId,expectedRevision,enabled,basis:'owner_reported_google_permission'}));
  expect(await permission(0,true)).toMatchObject({ok:true});
  const gmail=world.clientWith(box,{sendBehaviour:'indeterminate_but_delivered'}),id=await world.prepare(box);
  await dispatchOutboundMessage(ctx,world.sendDeps(box,{gmail}),{outboundMessageId:id});
  const retryAt='2026-09-23T09:05:00.000Z';
  const limited={...gmail,searchSentByMessageId:async()=>({ok:false as const,reason:'rate_limited' as const,retryAt})};
  await reconcileOutboundMessage(ctx,world.reconcileDeps(box,{gmail:limited,now:()=>new Date(OPEN_INSTANT)}),{outboundMessageId:id});
  expect(await permission(1,false)).toMatchObject({ok:true});
  expect(await reconcileOutboundMessage(ctx,world.reconcileDeps(box,{gmail,now:()=>new Date(retryAt)}),{outboundMessageId:id})).toMatchObject({outcome:'incident_held'});
  expect(await permission(2,true)).toMatchObject({ok:true});
  expect(await reconcileOutboundMessage(ctx,world.reconcileDeps(box,{gmail,now:()=>new Date(retryAt)}),{outboundMessageId:id})).toMatchObject({outcome:'sent'});
  expect(gmail.sends).toHaveLength(1);
 });
 it('waits on a transient token refresh without revoking the grant, then revalidates through mailbox sync before dispatch',async()=>{
  const box=world.alpha,ctx=world.systemContext(box.workspace.workspaceId);
  const id=await prepareFor(world,box,await seedFirm(world,box,'token-cooldown'));
  const retryAt='2026-09-23T09:05:00.000Z';
  let refreshes=0,limited=true;
  const gmail={...box.gmail,refreshAccessToken:async()=>{refreshes++;return limited?{ok:false as const,reason:'rate_limited' as const,retryAt}:box.gmail.refreshAccessToken(world.sendDeps(box).oauth,'ephemeral-fixture');}};
  expect(await dispatchOutboundMessage(ctx,world.sendDeps(box,{gmail}),{outboundMessageId:id})).toMatchObject({outcome:'held',refusal:'rate_limited',retryAt});
  expect((await readFence(ctx,id))?.dispatchStartedAt).toBeNull();
  expect(await dispatchOutboundMessage(ctx,world.sendDeps(box,{gmail}),{outboundMessageId:id})).toMatchObject({retryAt});
  expect(refreshes).toBe(1);
  limited=false;
  await withTransaction(world.database.session,()=>runMailSync(ctx,world.syncDeps(box,{gmail,now:()=>new Date(retryAt)}),{mailboxId:box.mailboxId}));
  expect(await readProviderIncidents(ctx,box.mailboxId)).toEqual([]);
  expect(await dispatchOutboundMessage(ctx,world.sendDeps(box,{gmail,now:()=>new Date(retryAt)}),{outboundMessageId:id})).toMatchObject({outcome:'sent'});
  expect(box.gmail.sends).toHaveLength(1);
 });
 it.each([true,false])('releases only the authentication incident after the established owner reconnect and retains incomplete coverage (domain enabled%s)',async domainEnabled=>{
  const box=world.alpha,ctx=world.systemContext(box.workspace.workspaceId);
  const revoked=world.clientWith(box,{grantRevoked:true}),id=await world.prepare(box);
  expect(await dispatchOutboundMessage(ctx,world.sendDeps(box,{gmail:revoked}),{outboundMessageId:id})).toMatchObject({refusal:'grant_revoked'});
  expect(await readProviderIncidents(ctx,box.mailboxId)).toMatchObject([{classification:'authentication',state:'action_required'}]);
  if(!domainEnabled){
   const admin=repositoryContext(workspaceScope(box.workspace.workspaceId,{kind:'user',userId:box.workspace.admin.userId,role:'admin'}),world.database.session);
   await withTransaction(world.database.session,()=>setAutomatedSendingEnabled(admin,{domain:'example.test',enabled:false}));
  }
  const key=randomBytes(32),now=new Date();
  const state=signGrantState(key,{workspaceId:box.workspace.workspaceId,userId:box.workspace.salesperson.userId,expiresAtEpochSeconds:Math.floor(now.getTime()/1000)+600});
  expect(await completeGmailGrant(world.userContext(box.workspace.workspaceId),{gmail:box.gmail,config:world.config,secrets:staticSecretProvider({gmail_oauth_client_secret:world.sendDeps(box).oauth.clientSecret}),cipher:world.cipher,stateSigningKey:key,now:()=>now},{state,code:'fixture-reconnect'})).toMatchObject({ok:true});
  expect(await readProviderIncidents(ctx,box.mailboxId)).toEqual([]);
  expect((await readRampStanding(ctx,box.mailboxId))?.readiness).toMatchObject({ready:false,reasons:expect.arrayContaining(['coverage_incomplete'])});
  expect(box.gmail.sends).toHaveLength(0);
 });
 it('preserves a token endpoint cooldown instead of classifying429 as grant revocation',async()=>{
  const client=createGmailHttpClient({apiBaseUrl:'https://fixture.invalid',now:()=>new Date(OPEN_INSTANT),fetch:async()=>({status:429,headers:{'retry-after':'300'},body:'{}'})});
  expect(await client.refreshAccessToken(world.sendDeps(world.alpha).oauth,'ephemeral-fixture')).toEqual({ok:false,reason:'rate_limited',retryAt:'2026-09-23T09:05:00.000Z'});
 });
 it('preserves unknown quota evidence instead of declaring a provider deadline safely transient',async()=>{
  const client=createGmailHttpClient({apiBaseUrl:'https://fixture.invalid',fetch:async()=>({status:403,headers:{'retry-after':'Wed, 23 Sep 2026 09:05:00 GMT'},body:JSON.stringify({error:{errors:[{reason:'quotaExceeded'}]}})})});
  expect(await client.searchSentByMessageId({accessToken:'ephemeral-fixture',expiresAtEpochSeconds:0},'<fixture-id>')).toMatchObject({classification:'unknown',incidentReason:'quota_exceeded'});
 });
 it('blocks another firm until the original uncertain submission is authoritatively reconciled',async()=>{
  const box=world.alpha,ctx=world.systemContext(box.workspace.workspaceId);
  const gmail=world.clientWith(box,{sendBehaviour:'indeterminate_but_delivered'}),id=await world.prepare(box);
  expect(await dispatchOutboundMessage(ctx,world.sendDeps(box,{gmail}),{outboundMessageId:id})).toMatchObject({outcome:'reconciling'});
  const other=await prepareFor(world,box,await seedFirm(world,box,'uncertain-other'));
  expect(await dispatchOutboundMessage(ctx,world.sendDeps(box),{outboundMessageId:other})).toMatchObject({outcome:'held',refusal:'provider_refusal'});
  expect(box.gmail.sends).toHaveLength(0);
  expect(await readProviderIncidents(ctx,box.mailboxId)).toMatchObject([{id,classification:'unknown',reason:'unresolved_submission',sourceKind:'provider_send',sourceId:id,state:'revalidation_due'}]);
  expect(await reconcileOutboundMessage(ctx,world.reconcileDeps(box,{gmail}),{outboundMessageId:id})).toMatchObject({outcome:'sent'});
  expect(await readProviderIncidents(ctx,box.mailboxId)).toEqual([]);
  expect(await dispatchOutboundMessage(ctx,world.sendDeps(box),{outboundMessageId:other})).toMatchObject({outcome:'sent'});
  expect(gmail.sends).toHaveLength(1);
  expect(box.gmail.sends).toHaveLength(1);
 });
 it('persists an unclassified Sent-read failure without copying its text or retrying it automatically',async()=>{
  const box=world.alpha,ctx=world.systemContext(box.workspace.workspaceId);
  const gmail=world.clientWith(box,{sendBehaviour:'indeterminate_but_delivered'}),id=await world.prepare(box);
  await dispatchOutboundMessage(ctx,world.sendDeps(box,{gmail}),{outboundMessageId:id});
  let searches=0;
  const failing={...gmail,searchSentByMessageId:async()=>{searches++;throw new Error('unclassified provider body');}};
  expect(await reconcileOutboundMessage(ctx,world.reconcileDeps(box,{gmail:failing}),{outboundMessageId:id})).toMatchObject({outcome:'incident_held'});
  expect(await reconcileOutboundMessage(ctx,world.reconcileDeps(box,{gmail:failing}),{outboundMessageId:id})).toMatchObject({outcome:'incident_held'});
  expect(searches).toBe(1);
  expect((await readProviderIncidents(ctx,box.mailboxId)).filter(i=>i.sourceKind==='sent_search')).toMatchObject([{classification:'unknown',reason:'unknown_provider_failure',state:'action_required'}]);
 });
 it('requires established auth-check and enable commands after authentication changes, retaining the cooldown until fresh observation',async()=>{
  const box=world.alpha,ctx=world.systemContext(box.workspace.workspaceId);
  const admin=repositoryContext(workspaceScope(box.workspace.workspaceId,{kind:'user',userId:box.workspace.admin.userId,role:'admin'}),world.database.session);
  const checklist=(spfPass:boolean)=>withTransaction(world.database.session,()=>recordAuthenticationChecklist(admin,{domain:'example.test',adminUserId:box.workspace.admin.userId,spfPass,dkimPass:true,dmarcPass:true,postmasterReviewed:true}));
  const gmail=world.clientWith(box,{sendBehaviour:'indeterminate_but_delivered'}),id=await world.prepare(box),retryAt='2026-09-23T09:05:00.000Z';
  await dispatchOutboundMessage(ctx,world.sendDeps(box,{gmail}),{outboundMessageId:id});
  await reconcileOutboundMessage(ctx,world.reconcileDeps(box,{gmail:{...gmail,searchSentByMessageId:async()=>({ok:false as const,reason:'rate_limited' as const,retryAt})},now:()=>new Date(OPEN_INSTANT)}),{outboundMessageId:id});
  await checklist(false);
  expect(await reconcileOutboundMessage(ctx,world.reconcileDeps(box,{gmail,now:()=>new Date(retryAt)}),{outboundMessageId:id})).toMatchObject({outcome:'incident_held'});
  await checklist(true);
  expect(await reconcileOutboundMessage(ctx,world.reconcileDeps(box,{gmail,now:()=>new Date(retryAt)}),{outboundMessageId:id})).toMatchObject({outcome:'incident_held'});
  expect(await withTransaction(world.database.session,()=>setAutomatedSendingEnabled(admin,{domain:'example.test',enabled:true}))).toMatchObject({ok:true});
  expect(await reconcileOutboundMessage(ctx,world.reconcileDeps(box,{gmail,now:()=>new Date(retryAt)}),{outboundMessageId:id})).toMatchObject({outcome:'sent'});
  expect(gmail.sends).toHaveLength(1);
 });
 it('holds when a renewed provider refusal loses its valid deadline instead of repeatedly reading after the old deadline',async()=>{
  const box=world.alpha,ctx=world.systemContext(box.workspace.workspaceId);
  const gmail=world.clientWith(box,{sendBehaviour:'indeterminate_but_delivered'}),id=await world.prepare(box),retryAt='2026-09-23T09:05:00.000Z';
  await dispatchOutboundMessage(ctx,world.sendDeps(box,{gmail}),{outboundMessageId:id});
  let searches=0;
  const limited={...gmail,searchSentByMessageId:async()=>{searches++;return {ok:false as const,reason:'rate_limited' as const,...(searches===1?{retryAt}:{})};}};
  await reconcileOutboundMessage(ctx,world.reconcileDeps(box,{gmail:limited,now:()=>new Date(OPEN_INSTANT)}),{outboundMessageId:id});
  await reconcileOutboundMessage(ctx,world.reconcileDeps(box,{gmail:limited,now:()=>new Date(retryAt)}),{outboundMessageId:id});
  expect(await reconcileOutboundMessage(ctx,world.reconcileDeps(box,{gmail:limited,now:()=>new Date('2026-09-23T09:06:00Z')}),{outboundMessageId:id})).toMatchObject({outcome:'incident_held'});
  expect(searches).toBe(2);
  expect((await readProviderIncidents(ctx,box.mailboxId)).filter(i=>i.sourceKind==='sent_search')).toMatchObject([{retryAt:null,state:'action_required'}]);
 });
 it('persists history-read cooldowns across worker-style transactions and revalidates only after the deadline',async()=>{
  const box=world.alpha,ctx=world.systemContext(box.workspace.workspaceId),retryAt='2026-09-23T09:05:00.000Z';
  let histories=0,limited=true;
  const gmail={...box.gmail,listHistory:async(...args:Parameters<typeof box.gmail.listHistory>)=>{histories++;return limited?{ok:false as const,reason:'rate_limited' as const,retryAt}:box.gmail.listHistory(...args);}};
  const sync=(instant:string)=>withTransaction(world.database.session,()=>runMailSync(ctx,world.syncDeps(box,{gmail,now:()=>new Date(instant)}),{mailboxId:box.mailboxId}));
  expect(await sync(OPEN_INSTANT)).toMatchObject({outcome:'rate_limited'});
  expect(await readProviderIncidents(ctx,box.mailboxId,new Date(OPEN_INSTANT))).toMatchObject([{sourceKind:'mail_read',state:'waiting',retryAt}]);
  expect(await sync('2026-09-23T09:04:59.999Z')).toMatchObject({outcome:'read_stopped'});
  expect(histories).toBe(1);
  limited=false;
  expect(await sync(retryAt)).toMatchObject({outcome:'synced'});
  expect(histories).toBe(2);
  expect(await readProviderIncidents(ctx,box.mailboxId)).toEqual([]);
 });
 it('commits a worker cooldown without claiming a successful mailbox read or throwing a generic retry',async()=>{
  const box=world.alpha,ctx=world.systemContext(box.workspace.workspaceId),retryAt='2026-09-23T09:05:00.000Z';
  const gmail=world.clientWith(box,{sendBehaviour:'indeterminate_but_delivered'}),id=await world.prepare(box);
  await dispatchOutboundMessage(ctx,world.sendDeps(box,{gmail}),{outboundMessageId:id});
  const limited={...gmail,searchSentByMessageId:async()=>({ok:false as const,reason:'rate_limited' as const,retryAt})};
  const enqueued=await enqueueJob(world.database.session,{workspaceId:box.workspace.workspaceId,kind:'mail.reconcile',idempotencyKey:'incident-worker',payload:{mailboxId:box.mailboxId}});
  const job=(await claimJobs(world.database.session,{owner:'incident-test',kinds:['mail.reconcile'],limit:20,leaseSeconds:120})).find(j=>j.id===enqueued.jobId)!;
  expect(job).toBeDefined();
  await expect(mailReconcileHandler(world.reconcileDeps(box,{gmail:limited,now:()=>new Date(OPEN_INSTANT)})).handle({session:world.database.session,scope:ctx.scope,job})).resolves.toBeUndefined();
  expect((await readProviderIncidents(ctx,box.mailboxId,new Date(OPEN_INSTANT))).filter(i=>i.sourceKind==='sent_search')).toMatchObject([{state:'waiting'}]);
  expect((await readHeartbeats(world.database.session)).filter(h=>h.instanceKey===box.mailboxId)).toEqual([]);
 });
 it('retains a send refusal deadline and reconciles its already-claimed fence before other work can dispatch',async()=>{
  const box=world.alpha,ctx=world.systemContext(box.workspace.workspaceId),retryAt='2026-09-23T09:05:00.000Z';
  const gmail=world.clientWith(box,{sendBehaviour:'indeterminate_but_delivered'}),id=await world.prepare(box);
  const limited={...gmail,sendMessage:async(...args:Parameters<typeof gmail.sendMessage>)=>{await gmail.sendMessage(...args);return {ok:false as const,outcome:'refused' as const,reason:'rate_limited' as const,retryAt};}};
  expect(await dispatchOutboundMessage(ctx,world.sendDeps(box,{gmail:limited,now:()=>new Date(OPEN_INSTANT)}),{outboundMessageId:id})).toMatchObject({outcome:'reconciling',retryAt});
  expect((await readProviderIncidents(ctx,box.mailboxId,new Date(OPEN_INSTANT))).filter(i=>i.reason!=='unresolved_submission')).toMatchObject([{sourceKind:'provider_send',state:'waiting',retryAt}]);
  expect(await reconcileOutboundMessage(ctx,world.reconcileDeps(box,{gmail,now:()=>new Date('2026-09-23T09:04:59Z')}),{outboundMessageId:id})).toMatchObject({outcome:'cooldown'});
  expect(await reconcileOutboundMessage(ctx,world.reconcileDeps(box,{gmail,now:()=>new Date(retryAt)}),{outboundMessageId:id})).toMatchObject({outcome:'sent'});
  expect(await readProviderIncidents(ctx,box.mailboxId)).toEqual([]);
  expect(gmail.sends).toHaveLength(1);
 });
 it('rechecks a cooldown committed on another PostgreSQL session after eligibility and before the final claim',async()=>{
  const box=world.alpha,ctx=world.systemContext(box.workspace.workspaceId),retryAt='2026-09-23T09:05:00.000Z';
  const other=await openExtraSession(world);
  try {
   const paused=pausingAtTokenRefresh(box.gmail,async()=>{
    const limited={...box.gmail,refreshAccessToken:async()=>({ok:false as const,reason:'rate_limited' as const,retryAt})};
    await withTransaction(other.session,()=>runMailSync(other.context(box.workspace.workspaceId),world.syncDeps(box,{gmail:limited,now:()=>new Date(OPEN_INSTANT)}),{mailboxId:box.mailboxId}));
   });
   const id=await world.prepare(box);
   expect(await dispatchOutboundMessage(ctx,world.sendDeps(box,{gmail:paused.client,now:()=>new Date(OPEN_INSTANT)}),{outboundMessageId:id})).toMatchObject({outcome:'held',refusal:'rate_limited'});
   expect(paused.refreshes()).toBe(1);
   expect(box.gmail.sends).toHaveLength(0);
   expect((await readFence(ctx,id))?.dispatchStartedAt).toBeNull();
  } finally {await other.close();}
 });
 it('keeps unknown-terminal uncertainty held until the original established terminal resolution and never resubmits it',async()=>{
  const box=world.alpha,ctx=world.systemContext(box.workspace.workspaceId);
  const gmail=world.clientWith(box,{sendBehaviour:'indeterminate'}),id=await world.prepare(box);
  await dispatchOutboundMessage(ctx,world.sendDeps(box,{gmail}),{outboundMessageId:id});
  // The terminal transition uses database time. This fixture represents the same
  // already-claimed fence after its observation window has elapsed.
  await world.database.session.query("UPDATE outbound_messages SET reconcile_started_at=now()-interval '25 hours',reconcile_deadline_at=now()-interval '1 hour' WHERE id=$1",[id]);
  expect(await reconcileOutboundMessage(ctx,world.reconcileDeps(box,{gmail,now:()=>new Date()}),{outboundMessageId:id})).toMatchObject({outcome:'unknown_terminal'});
  expect(await readProviderIncidents(ctx,box.mailboxId)).toMatchObject([{id,reason:'unresolved_submission',state:'action_required'}]);
  const admin=repositoryContext(workspaceScope(box.workspace.workspaceId,{kind:'user',userId:box.workspace.admin.userId,role:'admin'}),world.database.session);
  expect(await resolveUnknownTerminal(admin,{outboundMessageId:id,resolution:'skipped',adminUserId:box.workspace.admin.userId})).toMatchObject({ok:true});
  expect(await readProviderIncidents(ctx,box.mailboxId)).toEqual([]);
  expect(await dispatchOutboundMessage(ctx,world.sendDeps(box,{gmail}),{outboundMessageId:id})).toMatchObject({outcome:'already_terminal'});
  expect(gmail.sends).toHaveLength(1);
 });
 it('persists a watch-registration cooldown and makes no renewal call before its deadline',async()=>{
  const box=world.alpha,ctx=world.systemContext(box.workspace.workspaceId),retryAt='2026-09-23T09:05:00.000Z';
  let watches=0,limited=true;
  const gmail={...box.gmail,watch:async(...args:Parameters<typeof box.gmail.watch>)=>{watches++;return limited?{ok:false as const,reason:'provider_refusal' as const,classification:'transient' as const,incidentReason:'rate_limited' as const,retryAt}:box.gmail.watch(...args);}};
  const renew=(instant:string)=>withTransaction(world.database.session,()=>renewWatch(ctx,{gmail,oauth:world.sendDeps(box).oauth,cipher:world.cipher,topicName:'projects/fixture/topics/mail',now:()=>new Date(instant)},{mailboxId:box.mailboxId,generation:1}));
  expect(await renew(OPEN_INSTANT)).toMatchObject({outcome:'incident_held'});
  expect((await readProviderIncidents(ctx,box.mailboxId,new Date(OPEN_INSTANT))).filter(i=>i.sourceKind==='mail_read')).toMatchObject([{state:'waiting',retryAt}]);
  expect(await renew('2026-09-23T09:04:59Z')).toMatchObject({outcome:'incident_held'});
  expect(watches).toBe(1);limited=false;
  expect(await renew(retryAt)).toMatchObject({outcome:'renewed'});
  expect(await readProviderIncidents(ctx,box.mailboxId)).toEqual([]);
  expect(watches).toBe(2);
 });
 it('persists a bounded recovery-list cooldown and retries its safe read only after the deadline',async()=>{
  const box=world.alpha,ctx=world.systemContext(box.workspace.workspaceId),retryAt='2026-09-23T09:05:00.000Z';
  const mailbox=(await readMailbox(ctx,box.mailboxId))!;
  await withTransaction(world.database.session,()=>startRecovery(ctx,{mailbox,reason:'baseline',startHistoryId:mailbox.historyId!,fromAt:'2026-09-23T08:00:00Z',toAt:OPEN_INSTANT}));
  let listings=0,limited=true;
  const gmail={...box.gmail,listMessageIds:async(...args:Parameters<typeof box.gmail.listMessageIds>)=>{listings++;return limited?{ok:false as const,reason:'rate_limited' as const,retryAt}:box.gmail.listMessageIds(...args);}};
  const recover=(instant:string)=>withTransaction(world.database.session,()=>runMailRecovery(ctx,{...world.syncDeps(box,{gmail}),now:()=>new Date(instant)},{mailboxId:box.mailboxId,generation:mailbox.generation}));
  expect(await recover(OPEN_INSTANT)).toMatchObject({outcome:'rate_limited'});
  expect((await readProviderIncidents(ctx,box.mailboxId,new Date(OPEN_INSTANT))).filter(i=>i.sourceKind==='mail_read')).toMatchObject([{state:'waiting',retryAt}]);
  expect(await recover('2026-09-23T09:04:59Z')).toMatchObject({outcome:'incident_held'});
  expect(listings).toBe(1);limited=false;
  expect(await recover(retryAt)).toMatchObject({outcome:'completed'});
  expect(await readProviderIncidents(ctx,box.mailboxId)).toEqual([]);
 });
 it('preserves sync incident state when the worker completes its transaction and leaves mailbox heartbeat unchanged',async()=>{
  const box=world.alpha,ctx=world.systemContext(box.workspace.workspaceId),retryAt='2026-09-23T09:05:00.000Z';
  const gmail={...box.gmail,listHistory:async()=>({ok:false as const,reason:'rate_limited' as const,retryAt})};
  const enqueued=await enqueueJob(world.database.session,{workspaceId:box.workspace.workspaceId,kind:'mail.sync',idempotencyKey:'incident-sync-worker',payload:{mailboxId:box.mailboxId}});
  const job=(await claimJobs(world.database.session,{owner:'incident-test',kinds:['mail.sync'],limit:20,leaseSeconds:300})).find(j=>j.id===enqueued.jobId)!;
  await withTransaction(world.database.session,()=>mailSyncHandler(world.syncDeps(box,{gmail,now:()=>new Date(OPEN_INSTANT)})).handle({session:world.database.session,scope:ctx.scope,job}));
  expect((await readProviderIncidents(ctx,box.mailboxId,new Date(OPEN_INSTANT))).filter(i=>i.sourceKind==='mail_read')).toMatchObject([{state:'waiting',retryAt}]);
  expect((await readHeartbeats(world.database.session)).filter(h=>h.instanceKey===box.mailboxId)).toEqual([]);
 });
});
