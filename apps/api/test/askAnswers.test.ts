import {createHash, randomUUID} from 'node:crypto';
import {expect, it} from 'vitest';
import {dispatch} from '../src/server.ts';
import {createAuthFixture, CURRENT_CLIENT_VERSION} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';

it('acknowledges a selected-source answer request without exposing its question or source text when answering is disabled', async()=>{
 const fixture=await createAuthFixture();
 try{
  const token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.salesperson)).accessToken;
  const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false});
  const text='Maintenance routing needs a clearer process.';
  const person=await post('/crm/people/create',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,fullName:'Synthetic Ask Person'});
  expect(person.status).toBe(200);
  const personId=(person.body as {result:{personId:string}}).result.personId;
  const selection={text,subtype:'pasted_text',label:'Synthetic Ask note',direction:'unknown',participants:[],occurredAt:null,attachments:[]};
  const preview=await post('/crm/imports/preview',selection);
  expect(preview.status).toBe(200);
  const selected=await post('/crm/imports/commit',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,...selection,personId,firmId:null,importKey:randomUUID(),previewHash:(preview.body as {previewHash:string}).previewHash,parserVersion:'selected-v1'});
  expect(selected.status).toBe(200);
  const sourceId=(selected.body as {result:{sourceId:string}}).result.sourceId;
  const requested=await post('/ask/answers/request',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,question:'What maintenance process is needed?',scope:{sources:[{workspaceId:fixture.alpha.workspaceId,sourceId,kind:'selected_note',revision:1,contentHash:createHash('sha256').update(text).digest('hex'),locator:null}]}});
  expect(requested.status).toBe(200);
  expect(requested.body).toMatchObject({result:{requestId:expect.any(String),version:1,state:'unavailable'}});
  expect(JSON.stringify(requested.body)).not.toContain(text);
  expect(JSON.stringify(requested.body)).not.toContain('What maintenance process is needed?');
 }finally{await fixture.stop();}
});
