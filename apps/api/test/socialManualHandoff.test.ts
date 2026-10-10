import {randomUUID} from 'node:crypto';import {it,expect} from 'vitest';
import {createAuthFixture,CURRENT_CLIENT_VERSION} from './support/authFixture.ts';import {issueSessionFor} from './support/sessionFixture.ts';import {dispatch} from '../src/server.ts';
it('binds exact manual review without supplying provider authority or changing native delivery state',async()=>{
 const f=await createAuthFixture();try{
 const token=(await issueSessionFor(f,f.alpha,f.alpha.admin)).accessToken,accountId=randomUUID();
 await f.db.query("INSERT INTO social_accounts(workspace_id,id,owner_user_id,platform,external_id,display_name,account_kind,state) VALUES($1,$2,$3,'x','fixture-x','Founder','profile','unsupported')",[f.alpha.workspaceId,accountId,f.alpha.admin.userId]);
 const call=(path:string,body:unknown)=>dispatch({method:'POST',path,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`},body},{session:f.db,auth:f.deps,supportedClientVersions:f.deps.config.supportedClientVersions,sendingEnabled:false,upgradeUrl:'https://fixture.invalid/update'});
 const saved=await call('/social/posts/save',{accountId,text:'Exact manual text',images:[],publishAt:new Date(Date.now()+86400000).toISOString(),zone:'America/New_York',commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION});
 const postId=(saved.body as {result:{postId:string}}).result.postId,input={postId,expectedRevision:1};
 const before=await call('/social/manual-handoff/read',input);expect(before.status).toBe(200);const view=(before.body as {view:{fingerprint:string}}).view;
 const command={...input,fingerprint:view.fingerprint,reviewedDestination:true,commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION};
 expect((await call('/social/manual-handoff/confirm',command)).status).toBe(200);expect((await call('/social/manual-handoff/confirm',command)).body).toMatchObject({replayed:true});
 expect((await call('/social/manual-handoff/read',input)).body).toMatchObject({view:{state:'manual_needed',snapshot:{text:'Exact manual text',account:{externalId:'fixture-x'}},approvalId:expect.any(String)}});
 expect((await call('/social',{})).body).toMatchObject({accounts:[{state:'unsupported'}],posts:[{state:'draft'}]});
 expect((await call('/social/delivery/queue',{})).body).toEqual({items:[]});
 expect((await call('/social/manual-handoff/confirm',{...command,commandId:randomUUID(),fingerprint:'0'.repeat(64)})).status).toBe(409);
 }finally{await f.stop();}
});
