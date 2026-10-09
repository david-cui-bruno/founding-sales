import {createHash,randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {dispatch} from '../src/server.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';

it('explicitly commits a human note from current keyword evidence without enabling answering or copying content into its command receipt',async()=>{
 const fixture=await createAuthFixture();
 try{
  const token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.salesperson)).accessToken;
  const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false});
  const person=await post('/crm/people/create',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,fullName:'Manual note context'});
  expect(person.status).toBe(200);
  const personId=(person.body as {result:{personId:string}}).result.personId;
  const text='Repairs need clearer routing.';
  const added=await post('/crm/people/source/add',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,personId,sourceKey:'manual-note-source',excerpt:text,occurredAt:'2026-10-01T14:00:00Z'});
  expect(added.status).toBe(200);
  const sourceId=(added.body as {result:{sourceId:string}}).result.sourceId;
  const requested=await post('/ask/answers/request',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,question:'repairs',scope:{sources:[{workspaceId:fixture.alpha.workspaceId,sourceId,kind:'selected_note',revision:1,contentHash:createHash('sha256').update(text).digest('hex'),locator:null}]}});
  expect(requested.status).toBe(200);
  const requestId=(requested.body as {result:{requestId:string}}).result.requestId;
  const committed=await post('/ask/actions/create',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,requestId,expectedVersion:1,finding:{kind:'keyword_passage',index:0},action:{kind:'note',text:'Ask about the repair routing process.',target:{kind:'person',personId}}});
  expect(committed.status).toBe(200);
  expect(committed.body).toMatchObject({result:{actionId:expect.any(String),version:1,kind:'note'}});
  expect(JSON.stringify(committed.body)).not.toContain('repair routing');
  const actionId=(committed.body as {result:{actionId:string}}).result.actionId;
  const notes=await post('/ask/actions/read',{scope:{kind:'person',personId}});
  expect(notes.status).toBe(200);
  expect(notes.body).toMatchObject({items:[{actionId,version:1,kind:'note',status:'active',text:'Ask about the repair routing process.',provenance:'human',supportState:'current'}],nextAfterId:null});
 }finally{await fixture.stop();}
});
