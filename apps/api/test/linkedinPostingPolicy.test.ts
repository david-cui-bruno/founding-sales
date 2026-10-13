import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {it,expect} from 'vitest';
import {createAuthFixture,CURRENT_CLIENT_VERSION,type AuthFixture} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {dispatch} from '../src/server.ts';
import type {SessionQueryable} from '@fss/domain/db/queryable.ts';
import {socialDeliveryQueueSchema} from '@fss/contracts';
import {createAuthedClient} from '../../desktop/src/main/authedClient.ts';
import {createSocialDeliveryPorts} from '../../desktop/src/main/social/deliveryApi.ts';
import {submitApprovedSocialPost} from '../../desktop/src/main/social/deliveryLoop.ts';
import type {SocialAdapter} from '../../desktop/src/main/social/adapters.ts';
import {linkedinPostingPolicyOperations} from '../../desktop/src/main/social/linkedinPostingPolicyOperations.ts';

const command=()=>({commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION});
async function approvedPost(call:ReturnType<typeof caller>,accountId:string){
 const answer=await call('/social/posts/save',{accountId,text:'Controlled owner-approved actual work',images:[],publishAt:new Date(Date.now()+86400_000).toISOString(),zone:'America/New_York',...command()});
 expect(answer.status).toBe(200);
 const post=(answer.body as {result:{postId:string;revision:number}}).result;
 expect((await call('/social/posts/approve',{postId:post.postId,expectedRevision:post.revision,...command()})).status).toBe(200);
 return post;
}
async function claimPost(call:ReturnType<typeof caller>,post:{postId:string;revision:number}){
 const answer=await call('/social/delivery/claim',{postId:post.postId,expectedRevision:post.revision,...command()});
 expect(answer.status).toBe(200);
 const {claimId,approvalId,fingerprint}=(answer.body as {result:{claimId:string;approvalId:string;fingerprint:string}}).result;
 return {claimId,approvalId,fingerprint};
}
function caller(f:AuthFixture,token:string,db:SessionQueryable=f.db){
 return (path:string,body:unknown)=>dispatch({method:'POST',path,query:new URLSearchParams(),headers:token?{authorization:`Bearer ${token}`}:{},body},{session:db,auth:{...f.deps,db},supportedClientVersions:f.deps.config.supportedClientVersions,sendingEnabled:false,upgradeUrl:'https://fixture.invalid/update'});
}
async function setup(){
 const f=await createAuthFixture();
 const token=(await issueSessionFor(f,f.alpha,f.alpha.admin)).accessToken;
 const call=caller(f,token,await f.database.appRuntimeSession()),accountId=randomUUID();
 expect((await call('/social/accounts/connect',{accountId,platform:'linkedin',externalId:'david-cui-589a20228',displayName:'David Cui',accountKind:'profile',...command()})).status).toBe(200);
 return {f,call,token,accountId,input:{...command(),expectedRevision:0,accountId,accountRevision:1,approvedRulesVersion:'608-2026-10-13',generation:null}};
}
function client(call:ReturnType<typeof caller>,afterBegin?:()=>Promise<void>){return createAuthedClient({baseUrl:'https://fixture.invalid',clientVersion:CURRENT_CLIENT_VERSION,accessToken:async()=>({token:'transport-controlled',generation:0}),send:async(url,init)=>{const path=new URL(url).pathname,r=await call(path,JSON.parse(init.body??'{}'));if(path==='/social/delivery/begin'&&r.status===200)await afterBegin?.();return {status:r.status,body:r.body};}});}
function barrier(){let release!:()=>void,entered!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve;});const arrived=new Promise<void>(resolve=>{entered=resolve;});return {wait,arrived,release,entered};}
async function pid(db:SessionQueryable){return (await db.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;}
/** SQL here synchronizes locks only. Every policy/binding/delivery mutation is a public owner command. */
async function blocked(observer:SessionQueryable,waiting:number,blocking:number){
 for(let n=0;n<200;n++){
  if((await observer.query<{blocked:boolean}>('SELECT $2=ANY(pg_blocking_pids($1)) AS blocked',[waiting,blocking])).rows[0]?.blocked)return;
  await delay(5);
 }
 throw new Error('Public caller did not reach real PostgreSQL observer barrier');
}
it('owner saves and inspects separate standing posting scope without enabling publication',async()=>{
 const {f,call,input,accountId}=await setup();try{
 expect((await call('/social/linkedin-posting-policy/save',input)).status).toBe(200);
 expect((await call('/social/linkedin-posting-policy/read',{})).body).toMatchObject({revision:1,state:'saved',enabled:false,technicallyReady:false,policy:{accountId,accountExternalId:'david-cui-589a20228',accountRevision:1,generation:null},rules:{version:'608-2026-10-13',platform:'linkedin',format:'text_only',cadence:{days:['Tuesday','Thursday'],hour:10,zone:'America/New_York',weeklyMaximum:2,catchUpBurst:false},spend:{dailyUsd:1,calendarMonthUsd:10,zone:'America/New_York',stricterSharedLimits:true,automaticIncrease:false}},holds:expect.arrayContaining(['generation_not_configured','publication_not_enabled'])});
 expect((await call('/social/linkedin-policy/read',{})).body).toMatchObject({revision:0,policy:null});
 expect((await call('/social/linkedin-posting-policy/enable',{...command(),expectedRevision:1})).status).toBe(404);
 }finally{await f.stop();}
});
it('owner revises, disables and revokes without restoring old revision through command replay',async()=>{
 const {f,call,input,accountId,token}=await setup();try{
 expect((await call('/social/linkedin-posting-policy/save',input)).status).toBe(200);
 expect((await call('/social/linkedin-posting-policy/check-current',{expectedRevision:1,accountId,accountRevision:1})).body).toMatchObject({current:true,allowed:false,reason:'current_policy_not_dispatch_authority'});
 const disable={...command(),expectedRevision:1};
 expect((await call('/social/linkedin-posting-policy/disable',disable)).body).toMatchObject({result:{revision:2,state:'disabled'}});
 expect((await call('/social/linkedin-posting-policy/disable',disable)).body).toMatchObject({replayed:true,result:{revision:2}});
 expect((await call('/social/linkedin-posting-policy/save',input)).body).toMatchObject({replayed:true,result:{revision:1}});
 expect((await call('/social/linkedin-posting-policy/read',{})).body).toMatchObject({revision:2,state:'disabled'});
 expect((await call('/social/linkedin-posting-policy/save',{...input,...command()})).body).toMatchObject({reason:'stale_revision'});
 expect((await call('/social/linkedin-posting-policy/save',{...input,...command(),expectedRevision:2})).body).toMatchObject({result:{revision:3,state:'saved'}});
 expect((await call('/social/linkedin-posting-policy/revoke',{...command(),expectedRevision:3})).body).toMatchObject({result:{revision:4,state:'revoked'}});
 const restarted=caller(f,token,await f.database.appRuntimeSession());
 expect((await restarted('/social/linkedin-posting-policy/read',{})).body).toMatchObject({revision:4,state:'revoked',holds:expect.arrayContaining(['policy_revoked'])});
 expect((await restarted('/social/linkedin-posting-policy/check-current',{expectedRevision:3,accountId,accountRevision:1})).body).toMatchObject({current:false,reason:'policy_revoked'});
 expect((await restarted('/social/linkedin-posting-policy/read',{})).body).toMatchObject({history:[{revision:4,state:'revoked',accountId,accountRevision:1},{revision:3,state:'saved'},{revision:2,state:'disabled'},{revision:1,state:'saved'}]});
 }finally{await f.stop();}
});
it('owner stages an already manually approved candidate with current derived policy and consumes it normally',async()=>{
 const {f,call,input,accountId}=await setup();try{
 expect((await call('/social/linkedin-posting-policy/save',input)).status).toBe(200);
 const post=await approvedPost(call,accountId);
 const bind={postId:post.postId,postRevision:post.revision,expectedRevision:1,...command()};
 expect((await call('/social/linkedin-posting-policy/bind-candidate',bind)).body).toMatchObject({result:{postId:post.postId,postRevision:1,policyRevision:1,current:true,publicationReady:false}});
 expect((await call('/social/linkedin-posting-policy/read',{})).body).toMatchObject({candidates:[{postId:post.postId,postRevision:1,policyRevision:1,current:true,submissionState:'pending'}]});
 expect((await call('/social/delivery/queue',{})).body).toMatchObject({items:[{postId:post.postId,action:'submit'}]});
 const claim=await claimPost(call,post);
 expect((await call('/social/delivery/begin',{...claim,...command()})).status).toBe(200);
 expect((await call('/social/delivery/queue',{})).body).toMatchObject({items:[{postId:post.postId,action:'inspect',submissionId:expect.any(String)}]});
 }finally{await f.stop();}
});
it('revocation during actual controlled preparation prevents further dispatch while unbound manual approval still progresses',async()=>{
 const {f,call,input,accountId}=await setup();const b=barrier();let attempt:Promise<unknown>|undefined;try{
 expect((await call('/social/linkedin-posting-policy/save',input)).status).toBe(200);
 const bound=await approvedPost(call,accountId);
 expect((await call('/social/linkedin-posting-policy/bind-candidate',{postId:bound.postId,postRevision:1,expectedRevision:1,...command()})).status).toBe(200);
 const item=socialDeliveryQueueSchema.parse((await call('/social/delivery/queue',{})).body).items[0]!;
 const post={deliveryId:item.deliveryId,postId:item.postId,revision:item.revision,account:{platform:item.snapshot.account.platform,externalId:item.snapshot.account.externalId,displayName:'David Cui'},text:item.snapshot.text,images:[],publishAt:item.snapshot.publishAt,zone:item.snapshot.zone,fingerprint:item.fingerprint};
 const dispatched:string[]=[];
 const adapter:SocialAdapter={inspectAccount:async()=>post.account,stage:async()=>{b.entered();await b.wait;return {ready:true};},submit:async()=>{dispatched.push('submit');return {kind:'unknown'};},inspect:async()=>({state:'unknown',receiptId:null,permalink:null,observedAt:new Date().toISOString(),accountExternalId:null,observedFingerprint:null,complete:false}),cancel:async()=>{throw new Error('No cancellation authorized');}};
 attempt=submitApprovedSocialPost(post,adapter,createSocialDeliveryPorts({api:client(call),current:()=>true,now:Date.now}));
 await b.arrived;
 expect((await call('/social/linkedin-posting-policy/check-current',{expectedRevision:1,accountId,accountRevision:1})).body).toMatchObject({current:true});
 expect((await call('/social/linkedin-posting-policy/revoke',{expectedRevision:1,...command()})).status).toBe(200);
 b.release();
 expect(await attempt).toEqual({state:'not_submitted',reason:'policy_revoked'});
 expect(dispatched).toEqual([]);
 expect((await call('/social/delivery/queue',{})).body).toEqual({items:[]});
 expect((await call('/social/delivery/claim',{postId:bound.postId,expectedRevision:1,...command()})).body).toMatchObject({reason:'policy_revoked'});
 const manual=await approvedPost(call,accountId),claim=await claimPost(call,manual);
 expect((await call('/social/delivery/begin',{...claim,...command()})).status).toBe(200);
 }finally{b.release();await attempt?.catch(()=>undefined);await f.stop();}
});
it('revoke during a real begin-response wait stops dispatch and preserves the durable marker for restart inspection',async()=>{
 const {f,call,input,accountId,token}=await setup();const b=barrier();let attempt:Promise<unknown>|undefined;try{
 expect((await call('/social/linkedin-posting-policy/save',input)).status).toBe(200);
 const p=await approvedPost(call,accountId);
 expect((await call('/social/linkedin-posting-policy/bind-candidate',{postId:p.postId,postRevision:1,expectedRevision:1,...command()})).status).toBe(200);
 const item=socialDeliveryQueueSchema.parse((await call('/social/delivery/queue',{})).body).items[0]!;
 const post={deliveryId:item.deliveryId,postId:item.postId,revision:item.revision,account:{platform:item.snapshot.account.platform,externalId:item.snapshot.account.externalId,displayName:'David Cui'},text:item.snapshot.text,images:[],publishAt:item.snapshot.publishAt,zone:item.snapshot.zone,fingerprint:item.fingerprint},dispatched:string[]=[];
 const adapter:SocialAdapter={inspectAccount:async()=>post.account,stage:async()=>({ready:true}),submit:async()=>{dispatched.push('submit');return {kind:'unknown'};},inspect:async()=>({state:'unknown',receiptId:null,permalink:null,observedAt:new Date().toISOString(),accountExternalId:null,observedFingerprint:null,complete:false}),cancel:async()=>{throw new Error('No cancellation authorized');}};
 attempt=submitApprovedSocialPost(post,adapter,createSocialDeliveryPorts({api:client(call,async()=>{b.entered();await b.wait;}),current:()=>true,now:Date.now}));
 await b.arrived;
 const before=socialDeliveryQueueSchema.parse((await call('/social/delivery/queue',{})).body).items[0]!;
 expect(before).toMatchObject({postId:p.postId,action:'inspect',submissionId:expect.any(String)});
 expect((await call('/social/linkedin-posting-policy/revoke',{expectedRevision:1,...command()})).status).toBe(200);
 b.release();expect(await attempt).toEqual({state:'unknown'});expect(dispatched).toEqual([]);
 const restarted=caller(f,token,await f.database.appRuntimeSession());
 expect((await restarted('/social/delivery/queue',{})).body).toMatchObject({items:[{postId:p.postId,action:'inspect',submissionId:before.submissionId}]});
 expect((await restarted('/social/delivery/claim',{postId:p.postId,expectedRevision:1,...command()})).body).toMatchObject({reason:'inspect_existing_submission'});
 }finally{b.release();await attempt?.catch(()=>undefined);await f.stop();}
});
it('queue observer waits behind actual revocation and reads no unattempted bound work under the application role',async()=>{
 const {f,call,input,accountId,token}=await setup();const key=`linkedin-posting-policy:${f.alpha.workspaceId}:${f.alpha.admin.userId}`;
 let revoking:Promise<unknown>|undefined,reading:Promise<unknown>|undefined;
 try{
 expect((await call('/social/linkedin-posting-policy/save',input)).status).toBe(200);
 const p=await approvedPost(call,accountId);
 expect((await call('/social/linkedin-posting-policy/bind-candidate',{postId:p.postId,postRevision:1,expectedRevision:1,...command()})).status).toBe(200);
 expect((await call('/social/delivery/queue',{})).body).toMatchObject({items:[{postId:p.postId,action:'submit'}]});
 const revokeDb=await f.database.appRuntimeSession(),queueDb=await f.database.appRuntimeSession();
 const [blockPid,revokePid,queuePid]=await Promise.all([pid(f.db),pid(revokeDb),pid(queueDb)]);
 await f.db.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[key]);
 revoking=caller(f,token,revokeDb)('/social/linkedin-posting-policy/revoke',{expectedRevision:1,...command()});
 await blocked(f.db,revokePid,blockPid);
 reading=caller(f,token,queueDb)('/social/delivery/queue',{});
 await blocked(f.db,queuePid,revokePid);
 await f.db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]);
 expect(await revoking).toMatchObject({status:200,body:{result:{state:'revoked'}}});
 expect(await reading).toMatchObject({status:200,body:{items:[]}});
 }finally{await f.db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]);await Promise.all([revoking,reading]);await f.stop();}
});
it('synchronized bind then revoke then claim serializes account policy post locks without dispatch or deadlock',async()=>{
 const {f,call,input,accountId,token}=await setup();const key=`linkedin-posting-policy:${f.alpha.workspaceId}:${f.alpha.admin.userId}`;
 let binding:Promise<unknown>|undefined,revoking:Promise<unknown>|undefined,claiming:Promise<unknown>|undefined;
 try{
 expect((await call('/social/linkedin-posting-policy/save',input)).status).toBe(200);
 const p=await approvedPost(call,accountId);
 const bindDb=await f.database.appRuntimeSession(),revokeDb=await f.database.appRuntimeSession(),claimDb=await f.database.appRuntimeSession();
 const [blockPid,bindPid,revokePid,claimPid]=await Promise.all([pid(f.db),pid(bindDb),pid(revokeDb),pid(claimDb)]);
 await f.db.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[key]);
 binding=caller(f,token,bindDb)('/social/linkedin-posting-policy/bind-candidate',{postId:p.postId,postRevision:1,expectedRevision:1,...command()});
 await blocked(f.db,bindPid,blockPid);
 revoking=caller(f,token,revokeDb)('/social/linkedin-posting-policy/revoke',{expectedRevision:1,...command()});
 await blocked(f.db,revokePid,bindPid);
 claiming=caller(f,token,claimDb)('/social/delivery/claim',{postId:p.postId,expectedRevision:1,...command()});
 await blocked(f.db,claimPid,revokePid);
 await f.db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]);
 expect(await binding).toMatchObject({status:200,body:{result:{current:true,publicationReady:false}}});
 expect(await revoking).toMatchObject({status:200});
 expect(await claiming).toMatchObject({status:409,body:{reason:'policy_revoked'}});
 expect((await call('/social/delivery/queue',{})).body).toEqual({items:[]});
 }finally{await f.db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]);await Promise.all([binding,revoking,claiming]);await f.stop();}
});
it('normal authenticated desktop operations save read revise revoke and discard a response after owner session switch',async()=>{
 const {f,call,input}=await setup();try{
 let generation=0;const host=linkedinPostingPolicyOperations({api:client(call),generation:()=>generation});
 const {clientVersion:_version,...save}=input;
 expect(await host['social.savePostingPolicy'](save)).toMatchObject({view:{revision:1,state:'saved',enabled:false},reason:null});
 expect(await host['social.postingPolicy']()).toMatchObject({view:{revision:1,state:'saved'},reason:null});
 expect(await host['social.savePostingPolicy']({...save,commandId:randomUUID(),expectedRevision:1})).toMatchObject({view:{revision:2},reason:null});
 expect(await host['social.revokePostingPolicy']({commandId:randomUUID(),expectedRevision:2})).toMatchObject({view:{revision:3,state:'revoked'},reason:null});
 const b=barrier(),delayed=linkedinPostingPolicyOperations({api:createAuthedClient({baseUrl:'https://fixture.invalid',clientVersion:CURRENT_CLIENT_VERSION,accessToken:async()=>({token:'controlled',generation}),send:async(url,init)=>{const response=await call(new URL(url).pathname,JSON.parse(init.body??'{}'));b.entered();await b.wait;return response;}}),generation:()=>generation});
 const reading=delayed['social.postingPolicy']();await b.arrived;generation++;b.release();
 expect(await reading).toEqual({view:null,reason:'session_changed'});
 }finally{await f.stop();}
});
it('binding remains immutable and cannot salvage stale policy or post revisions or attempted work',async()=>{
 const {f,call,input,accountId}=await setup();try{
 expect((await call('/social/linkedin-posting-policy/save',input)).status).toBe(200);
 const p=await approvedPost(call,accountId),bind={postId:p.postId,postRevision:1,expectedRevision:1,...command()};
 expect((await call('/social/linkedin-posting-policy/bind-candidate',bind)).status).toBe(200);
 expect((await call('/social/linkedin-posting-policy/bind-candidate',{...bind,...command()})).body).toMatchObject({reason:'candidate_already_bound'});
 expect((await call('/social/linkedin-posting-policy/save',{...input,...command(),expectedRevision:1})).status).toBe(200);
 expect((await call('/social/linkedin-posting-policy/bind-candidate',{...bind,...command(),expectedRevision:2})).body).toMatchObject({reason:'candidate_already_bound'});
 expect((await call('/social/linkedin-posting-policy/bind-candidate',bind)).body).toMatchObject({replayed:true});
 expect((await call('/social/delivery/queue',{})).body).toEqual({items:[]});
 expect((await call('/social/linkedin-posting-policy/read',{})).body).toMatchObject({candidates:[{current:false,reason:'stale_revision'}]});
 const manual=await approvedPost(call,accountId),claim=await claimPost(call,manual);
 expect((await call('/social/delivery/begin',{...claim,...command()})).status).toBe(200);
 expect((await call('/social/linkedin-posting-policy/bind-candidate',{postId:manual.postId,postRevision:1,expectedRevision:2,...command()})).body).toMatchObject({reason:'manual_approval_required'});
 const draft=(await call('/social/posts/save',{accountId,text:'Draft is not authority',images:[],publishAt:new Date(Date.now()+86400_000).toISOString(),zone:'America/New_York',...command()})).body as {result:{postId:string}};
 expect((await call('/social/linkedin-posting-policy/bind-candidate',{postId:draft.result.postId,postRevision:2,expectedRevision:2,...command()})).body).toMatchObject({reason:'stale_post_revision'});
 expect((await call('/social/linkedin-posting-policy/bind-candidate',{postId:draft.result.postId,postRevision:1,expectedRevision:2,...command()})).body).toMatchObject({reason:'manual_approval_required'});
 }finally{await f.stop();}
});
it('final dispatch freshness is positive before account change, refuses wrong device owner and revised account, and preserves inspectability',async()=>{
 const {f,call,input,accountId}=await setup();try{
 expect((await call('/social/linkedin-posting-policy/save',input)).status).toBe(200);
 const p=await approvedPost(call,accountId);
 expect((await call('/social/linkedin-posting-policy/bind-candidate',{postId:p.postId,postRevision:1,expectedRevision:1,...command()})).status).toBe(200);
 const claim=await claimPost(call,p),answer=await call('/social/delivery/begin',{...claim,...command()});
 const {submissionId}=(answer.body as {result:{submissionId:string}}).result;
 expect(answer.body).toMatchObject({result:{postingPolicyBound:true}});
 expect((await call('/social/linkedin-posting-policy/dispatch-current',{submissionId})).body).toMatchObject({current:true});
 expect((await caller(f,'')('/social/linkedin-posting-policy/dispatch-current',{submissionId})).status).toBe(401);
 const wrongDevice=(await issueSessionFor(f,f.alpha,f.alpha.admin)).accessToken;
 expect((await caller(f,wrongDevice)('/social/linkedin-posting-policy/dispatch-current',{submissionId})).body).toMatchObject({current:false});
 const otherOwner=(await issueSessionFor(f,f.alpha,f.alpha.salesperson)).accessToken;
 expect((await caller(f,otherOwner)('/social/linkedin-posting-policy/dispatch-current',{submissionId})).body).toMatchObject({current:false});
 expect((await call('/social/accounts/connect',{accountId,platform:'linkedin',externalId:'david-cui-589a20228',displayName:'David Cui revised',accountKind:'profile',...command()})).status).toBe(200);
 expect((await call('/social/linkedin-posting-policy/dispatch-current',{submissionId})).body).toMatchObject({current:false,reason:'account_changed'});
 expect((await call('/social/delivery/queue',{})).body).toMatchObject({items:[{postId:p.postId,action:'inspect',submissionId}]});
 }finally{await f.stop();}
});
