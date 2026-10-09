import {createHash,randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {dispatch} from '../src/server.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';

it('automatically retains dated source investigations in their owner private history',async()=>{
 const fixture=await createAuthFixture();
 try{
  const token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.salesperson)).accessToken;
  const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false});
  const person=await post('/crm/people/create',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,fullName:'History source owner'});
  expect(person.status).toBe(200);
  const personId=(person.body as {result:{personId:string}}).result.personId;
  const text='We need faster repairs.';
  const added=await post('/crm/people/source/add',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,personId,sourceKey:'history-source',excerpt:text,occurredAt:'2026-10-01T14:00:00Z'});
  expect(added.status).toBe(200);
  const sourceId=(added.body as {result:{sourceId:string}}).result.sourceId;
  const request=await post('/ask/answers/request',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,question:'repairs',scope:{sources:[{workspaceId:fixture.alpha.workspaceId,sourceId,kind:'selected_note',revision:1,contentHash:createHash('sha256').update(text).digest('hex'),locator:null}]}});
  expect(request.status).toBe(200);
  const requestId=(request.body as {result:{requestId:string}}).result.requestId;
  const history=await post('/ask/history/list',{});
  expect(history.status).toBe(200);
  expect(history.body).toMatchObject({items:[{requestId,historyRevision:1,requestVersion:1,createdAt:expect.any(String),updatedAt:expect.any(String),title:null,pinned:false,question:'repairs',state:'unavailable',reason:'purpose_unavailable'}],nextCursor:null});
 }finally{await fixture.stop();}
});
