import {randomUUID} from 'node:crypto';
import {it,expect} from 'vitest';
import {createAuthFixture,CURRENT_CLIENT_VERSION,type AuthFixture} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {dispatch} from '../src/server.ts';
import type {SessionQueryable} from '@fss/domain/db/queryable.ts';

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
 const call=caller(f,token),accountId=randomUUID();
 expect((await call('/social/accounts/connect',{accountId,platform:'linkedin',externalId:'david-cui-589a20228',displayName:'David Cui',accountKind:'profile',...command()})).status).toBe(200);
 return {f,call,token,accountId,input:{...command(),expectedRevision:0,accountId,accountRevision:1,approvedRulesVersion:'608-2026-10-13',generation:null}};
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
 }finally{await f.stop();}
});
it('owner stages an already manually approved candidate with current derived policy and consumes it normally',async()=>{
 const {f,call,input,accountId}=await setup();try{
 expect((await call('/social/linkedin-posting-policy/save',input)).status).toBe(200);
 const post=await approvedPost(call,accountId);
 const bind={postId:post.postId,postRevision:post.revision,expectedRevision:1,...command()};
 expect((await call('/social/linkedin-posting-policy/bind-candidate',bind)).body).toMatchObject({result:{postId:post.postId,postRevision:1,policyRevision:1,current:true,publicationReady:false}});
 expect((await call('/social/delivery/queue',{})).body).toMatchObject({items:[{postId:post.postId,action:'submit'}]});
 const claim=await claimPost(call,post);
 expect((await call('/social/delivery/begin',{...claim,...command()})).status).toBe(200);
 expect((await call('/social/delivery/queue',{})).body).toMatchObject({items:[{postId:post.postId,action:'inspect',submissionId:expect.any(String)}]});
 }finally{await f.stop();}
});
