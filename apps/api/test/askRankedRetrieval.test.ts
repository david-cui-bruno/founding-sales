import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {dispatch} from '../src/server.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';

it('ranks relevant copied passages by PostgreSQL relevance rather than source identity order',async()=>{
 const fixture=await createAuthFixture();
 try{
  const token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.salesperson)).accessToken;
  const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false});
  const person=await post('/crm/people/create',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,fullName:'Ranked business history'});
  const personId=(person.body as {result:{personId:string}}).result.personId;
  for(const [sourceKey,excerpt] of [['history','repairs '+ 'other '.repeat(332)+'repairs repairs repairs repairs repairs']] ){
   expect((await post('/crm/people/source/add',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,personId,sourceKey,excerpt,occurredAt:'2026-10-01T14:00:00Z'})).status).toBe(200);
  }
  const page=await post('/crm/people/read',{personId});
  const sources=(page.body as {sources:Record<string,unknown>[]}).sources.map(({workspaceId,sourceId,kind,revision,contentHash})=>({workspaceId,sourceId,kind,revision,contentHash,locator:null})).sort((a,b)=>String(a.sourceId).localeCompare(String(b.sourceId)));
  const explicit=await post('/ask/read',{operation:'passages',scope:{sources},query:'repairs',limit:1});
  expect(explicit.status).toBe(200);
  expect(explicit.body).toMatchObject({passages:[{text:'repairs repairs repairs repairs repairs'}],coverage:{semantic:'not_requested'}});
  const personRead=await post('/ask/read',{operation:'passages',scope:{personId},query:'repairs',limit:1});
  expect(personRead.status).toBe(200);
  expect(personRead.body).toMatchObject({passages:[{text:'repairs repairs repairs repairs repairs'}]});
 }finally{await fixture.stop();}
});
