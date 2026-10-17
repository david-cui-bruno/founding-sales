import {randomUUID} from 'node:crypto';
import {it,expect} from 'vitest';
import {createAuthFixture,CURRENT_CLIENT_VERSION} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {dispatch} from '../src/server.ts';
import {registerHandlers,workerDueWorkSources} from '../../worker/src/bootstrap/main.ts';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {enqueueJob,claimJobs} from '@fss/domain/jobs/jobStore.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {runClaimedJob} from '../../worker/src/runner/jobRunner.ts';
import {createAuthedClient} from '../../desktop/src/main/authedClient.ts';
import {createSocialDeliveryPorts} from '../../desktop/src/main/social/deliveryApi.ts';
import {submitApprovedSocialPost} from '../../desktop/src/main/social/deliveryLoop.ts';
import {socialDeliveryQueueSchema} from '@fss/contracts';
import type {SocialAdapter} from '../../desktop/src/main/social/adapters.ts';
import {createLinkedinRecurringComposition} from '../../worker/src/social/linkedinRecurringJobs.ts';
import type {LinkedinRecurringComposition} from '@fss/domain/social/linkedinRecurringAuthority.ts';
import {linkedinRecurringDay} from '@fss/domain/social/linkedinRecurringCalendar.ts';

const fact='I am planning a bounded worker for maintenance intake.';
const text=fact+'\n\nThe scope matters here. Keeping the input bounded makes the work easier to inspect.\n\nThis is a plan, not shipped behavior.';
const generation={provider:'bedrock' as const,providerKey:'aws_bedrock.social_draft' as const,model:'claude-haiku-4-5' as const,routeVersion:'controlled-bedrock-v1',accessGrantVersion:'controlled-access-v1',dataHandlingVersion:'sanitized-v1',dailyUsd:1 as const,calendarMonthUsd:10 as const,budgetZone:'America/New_York' as const};
const command=(input:object)=>({...input,commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION});

it('normal governed intake and registered preparation worker schedule exactly one exact 10AM LinkedIn text target without human post approval',async()=>{
 const f=await createAuthFixture();try{
 const token=(await issueSessionFor(f,f.alpha,f.alpha.admin)).accessToken;
 const api=await f.database.appRuntimeSession(),worker=await f.database.appRuntimeSession();
 const accountId=randomUUID();let runtime:LinkedinRecurringComposition|null=null;
 const call=(path:string,body:unknown)=>dispatch({method:'POST',path,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`},body},Object.assign({session:api,auth:{...f.deps,db:api},supportedClientVersions:f.deps.config.supportedClientVersions,sendingEnabled:false,upgradeUrl:'https://fixture.invalid/update'},{linkedinRecurring:runtime}));
 expect((await call('/social/accounts/connect',command({accountId,platform:'linkedin',externalId:'david-cui-589a20228',displayName:'David Cui',accountKind:'profile'}))).status).toBe(200);
 const saved=await call('/outreach/answer-blocks/save',command({kind:'product',text:fact,socialInput:{topic:'build',status:'planned',sanitized:true}}));expect(saved.status).toBe(200);
 const ref=(saved.body as {result:{id:string;version:number}}).result;
 expect((await call('/outreach/answer-blocks/approve',command(ref))).status).toBe(200);
 expect((await call('/research/settings',command({enabled:true,dailyCostCeilingCents:50,monthlyCostCeilingCents:1000}))).status).toBe(200);
 expect((await call('/social/linkedin-posting-policy/save',command({expectedRevision:0,accountId,accountRevision:1,approvedRulesVersion:'608-2026-10-13',generation}))).status).toBe(200);
 // First RED must be an observed public capability failure, not an import/compiler error.
 expect((await call('/social/linkedin-recurring/read',{})).status).toBe(200);
 // Only scheduler time is controlled. Database cost time, native time and Date.now are real.
 const next=Array.from({length:8},(_,i)=>linkedinRecurringDay(new Date(Date.now()+(i+1)*86400000).toISOString())).find(d=>d&&Date.parse(d.targetAt)>Date.now());
 if(!next)throw new Error('future_fixture_target_missing');
 const target=next.targetAt,controlledTime=new Date(Date.parse(target)-1800000).toISOString();
 let submissions=0,generations=0;let fingerprint='';
 const adapter:SocialAdapter={inspectAccount:async()=>({platform:'linkedin',externalId:'david-cui-589a20228',displayName:'David Cui'}),stage:async()=>({ready:true}),submit:async p=>{expect(p.publishAt).toBe(target);expect(p.images).toEqual([]);expect(p.account.platform).toBe('linkedin');submissions++;fingerprint=p.fingerprint;return {kind:'scheduled',receiptId:'controlled-receipt'};},inspect:async()=>({state:'scheduled',receiptId:'controlled-receipt',permalink:null,observedAt:new Date().toISOString(),accountExternalId:'david-cui-589a20228',observedFingerprint:fingerprint,complete:true}),cancel:async()=>{throw new Error('unused');}};
 runtime=await createLinkedinRecurringComposition({session:worker,workspaceId:f.alpha.workspaceId,ownerUserId:f.alpha.admin.userId,accountId,policyRevision:1,generation,expiresAt:new Date(Date.now()+300000).toISOString(),clock:{now:()=>controlledTime},inspectAccount:adapter.inspectAccount,model:{providerKey:'aws_bedrock.social_draft',countInputTokens:async()=>100,generate:async()=>{generations++;return {raw:JSON.stringify({concepts:[{theme:'build',factRefs:[ref],variants:[{platform:'linkedin',text}]}]}),costCents:1,costEstimated:false};}}});
 expect(runtime).not.toBeNull();
 const registry=registerHandlers(new HandlerRegistry(),Object.assign({classifier:undefined,mail:undefined,send:undefined,research:undefined},{linkedinRecurring:runtime}));
 const sources=workerDueWorkSources(Object.assign({},{linkedinRecurring:runtime}));
 const source=sources.find(s=>s.name==='linkedin-recurring');expect(source).toBeDefined();
 await withTransaction(worker,async()=>{for(const job of await source!.find(worker,controlledTime))await enqueueJob(worker,job);});
 const [job]=await claimJobs(worker,{owner:'recurring-controlled',kinds:['social.linkedin_recurring'],limit:1,leaseSeconds:180});expect(job).toBeDefined();
 expect(await runClaimedJob(worker,{registry,job:job!})).toBe('completed');
 expect(generations).toBe(1);
 const queued=socialDeliveryQueueSchema.parse((await call('/social/delivery/queue',{})).body);expect(queued.items).toHaveLength(1);
 const item=queued.items[0]!;
 const client=createAuthedClient({baseUrl:'https://fixture.invalid',clientVersion:CURRENT_CLIENT_VERSION,accessToken:async()=>({token:'controlled',generation:0}),send:async(url,init)=>{const r=await call(new URL(url).pathname,JSON.parse(init.body??'{}'));return {status:r.status,body:r.body};}});
 const ports=createSocialDeliveryPorts({api:client,current:()=>true,now:()=>Date.now()});
 expect(await submitApprovedSocialPost({deliveryId:item.deliveryId,postId:item.postId,revision:item.revision,account:{platform:item.snapshot.account.platform,externalId:item.snapshot.account.externalId,displayName:'David Cui'},text:item.snapshot.text,images:[],publishAt:item.snapshot.publishAt,zone:item.snapshot.zone,fingerprint:item.fingerprint},adapter,ports)).toEqual({state:'scheduled'});
 expect(submissions).toBe(1);
 expect((await call('/social/linkedin-recurring/read',{})).body).toMatchObject({items:[{state:'receipt',targetAt:target,policyRevision:1,accountRevision:1,approvalKind:'standing_policy',receiptId:'controlled-receipt',spendCents:1}]});
 await withTransaction(worker,async()=>{for(const repeated of await source!.find(worker,controlledTime))await enqueueJob(worker,repeated);});
 expect(await claimJobs(worker,{owner:'restarted-worker',kinds:['social.linkedin_recurring'],limit:1,leaseSeconds:180})).toEqual([]);
 expect(submissions).toBe(1);
 }finally{await f.stop();}
});
