import {randomUUID} from 'node:crypto';
import {it,expect} from 'vitest';
import {createAuthFixture,CURRENT_CLIENT_VERSION} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {dispatch} from '../src/server.ts';
it('creates a replayable owner-scoped request without accepting source text or approvals',async()=>{
 const f=await createAuthFixture();try{
 let token=(await issueSessionFor(f,f.alpha,f.alpha.admin)).accessToken;
 const call=(path:string,body:unknown)=>dispatch({method:'POST',path,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`},body},{session:f.db,auth:f.deps,supportedClientVersions:f.deps.config.supportedClientVersions,sendingEnabled:false,upgradeUrl:'https://fixture.invalid/update'});
 const id=randomUUID();await f.db.query('INSERT INTO sourcing_candidates(workspace_id,id,identity_key,payload) VALUES($1,$2,$3,$4::jsonb)',[f.alpha.workspaceId,id,'d'.repeat(64),JSON.stringify({brief:'After-hours maintenance for PRIVATE CUSTOMER.'})]);
 const input={sourceRefs:[{kind:'public',id,revision:1}],factBlocks:[],commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION};
 expect((await call('/social/drafts/request',{...input,text:'invented content',approved:true})).status).toBe(400);
 const result=await call('/social/drafts/request',input);expect(result.status).toBe(200);
 const requestId=(result.body as {result:{requestId:string}}).result.requestId;
 expect((await call('/social/drafts/request',input)).body).toMatchObject({replayed:true,result:{requestId}});
 const view=await call('/social/drafts/read',{requestId});expect(view.status).toBe(200);expect(view.body).toMatchObject({request:{id:requestId,state:'queued'}});expect(JSON.stringify(view.body)).not.toContain('PRIVATE CUSTOMER');
 expect((await call('/social/drafts/read',{requestId,ownerUserId:f.alpha.admin.userId})).status).toBe(400);
 token=(await issueSessionFor(f,f.beta,f.beta.admin)).accessToken;
 expect((await call('/social/drafts/read',{requestId})).status).toBe(404);
 }finally{await f.stop();}
});
