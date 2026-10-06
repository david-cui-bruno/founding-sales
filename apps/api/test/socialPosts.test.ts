import {randomUUID} from 'node:crypto';import {it,expect} from 'vitest';import {createAuthFixture,CURRENT_CLIENT_VERSION} from './support/authFixture.ts';import {issueSessionFor} from './support/sessionFixture.ts';import {dispatch} from '../src/server.ts';
it('replays a post edit once, isolates the owner, and derives the delivery device from authentication',async()=>{
 const f=await createAuthFixture();try{
 let token=(await issueSessionFor(f,f.alpha,f.alpha.admin)).accessToken;const accountId=randomUUID();await f.db.query("INSERT INTO social_accounts(workspace_id,id,owner_user_id,platform,external_id,display_name,account_kind,state,adapter_version,verified_at,max_schedule_days) VALUES($1,$2,$3,'linkedin','fixture','David','profile','connected','fixture-v1',now(),30)",[f.alpha.workspaceId,accountId,f.alpha.admin.userId]);
 const call=(path:string,body:unknown)=>dispatch({method:'POST',path,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`},body},{session:f.db,auth:f.deps,supportedClientVersions:f.deps.config.supportedClientVersions,sendingEnabled:false,upgradeUrl:'https://fixture.invalid/update'});
 const body={accountId,text:'Fixture draft',images:[],publishAt:new Date(Date.now()+86400_000).toISOString(),zone:'America/New_York',commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION};
 const saved=await call('/social/posts/save',body);expect(saved.status).toBe(200);expect((await call('/social/posts/save',body)).body).toMatchObject({replayed:true});const p=(saved.body as {result:{postId:string;revision:number}}).result;
 const action={postId:p.postId,expectedRevision:1,commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION};expect((await call('/social/posts/approve',action)).status).toBe(200);
 expect((await call('/social/delivery/queue',{})).body).toMatchObject({items:[{postId:p.postId,action:'submit'}]});
 expect((await call('/social/delivery/queue',{deviceId:randomUUID()})).status).toBe(400);
 expect((await call('/social/delivery/claim',{...action,deviceId:randomUUID()})).status).toBe(400);
 const claimed=await call('/social/delivery/claim',{...action,commandId:randomUUID()});expect(claimed.status).toBe(200);
 const claim=(claimed.body as {result:{claimId:string;approvalId:string;fingerprint:string}}).result;
 const begin={claimId:claim.claimId,approvalId:claim.approvalId,fingerprint:claim.fingerprint,commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION};
 expect((await call('/social/delivery/begin',begin)).status).toBe(200);
 expect((await call('/social/delivery/begin',begin)).status).toBe(409);
 expect((await call('/social/delivery/queue',{})).body).toMatchObject({items:[{postId:p.postId,action:'inspect'}]});
 token=(await issueSessionFor(f,f.beta,f.beta.admin)).accessToken;expect((await call('/social/delivery/queue',{})).body).toEqual({items:[]});expect((await call('/social',{})).body).toEqual({accounts:[],posts:[]});expect((await call('/social/posts/cancel',{...action,commandId:randomUUID()})).status).toBe(409);
 }finally{await f.stop();}
});
