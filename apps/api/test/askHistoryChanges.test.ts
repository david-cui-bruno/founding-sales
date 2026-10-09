import {createHash,randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {dispatch} from '../src/server.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';

it('explicitly renames a current private investigation with revision-bound metadata-only acknowledgment',async()=>{
 const fixture=await createAuthFixture();
 try{
  const token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.salesperson)).accessToken;
  const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false});
  const created=await post('/crm/people/create',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,fullName:'Renamed history context'});
  expect(created.status).toBe(200);
  const personId=(created.body as {result:{personId:string}}).result.personId;
  const text='Maintenance routing review.';
  const added=await post('/crm/people/source/add',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,personId,sourceKey:'history-change-source',excerpt:text,occurredAt:'2026-10-01T14:00:00Z'});
  expect(added.status).toBe(200);
  const sourceId=(added.body as {result:{sourceId:string}}).result.sourceId;
  const request=await post('/ask/answers/request',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,question:'maintenance',scope:{sources:[{workspaceId:fixture.alpha.workspaceId,sourceId,kind:'selected_note',revision:1,contentHash:createHash('sha256').update(text).digest('hex'),locator:null}]}});
  expect(request.status).toBe(200);
  const requestId=(request.body as {result:{requestId:string}}).result.requestId;
  const changed=await post('/ask/history/change',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,requestId,expectedRevision:1,action:{kind:'rename',title:'Maintenance investigation'}});
  expect(changed.status).toBe(200);
  expect(changed.body).toMatchObject({result:{requestId,historyRevision:2,requestVersion:1,state:'unavailable'}});
  expect(JSON.stringify(changed.body)).not.toContain('Maintenance investigation');
  const history=await post('/ask/history/list',{});
  expect(history.body).toMatchObject({items:[{requestId,title:'Maintenance investigation',historyRevision:2}]});
  const pinCommand={commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,requestId,expectedRevision:2,action:{kind:'pin',pinned:true}};
  const pinned=await post('/ask/history/change',pinCommand);
  expect(pinned.status).toBe(200);
  expect(pinned.body).toMatchObject({result:{requestId,historyRevision:3,requestVersion:1,state:'unavailable'}});
  expect((await post('/ask/history/change',pinCommand)).body).toMatchObject({replayed:true,result:{requestId,historyRevision:3,requestVersion:1,state:'unavailable'}});
  expect((await post('/ask/history/list',{})).body).toMatchObject({items:[{requestId,title:'Maintenance investigation',pinned:true,historyRevision:3}]});
  expect((await post('/ask/history/change',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,requestId,expectedRevision:2,action:{kind:'rename',title:'Stale overwrite'}})).status).toBe(409);
  const deleteCommand={commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,requestId,expectedRevision:3,action:{kind:'delete'}};
  const deleted=await post('/ask/history/change',deleteCommand);
  expect(deleted.status).toBe(200);
  expect(deleted.body).toMatchObject({result:{requestId,historyRevision:4,requestVersion:2,state:'deleted'}});
  expect((await post('/ask/history/list',{})).body).toMatchObject({items:[],nextCursor:null});
  expect((await post('/ask/answers/read',{requestId})).body).toMatchObject({state:'deleted',reason:'deleted',question:null,fallback:null,answer:null});
  expect((await post('/ask/history/change',pinCommand)).body).toMatchObject({replayed:true,result:{historyRevision:3}});
  const sourcePage=await post('/crm/people/read',{personId});
  expect(sourcePage.body).toMatchObject({sources:[{sourceId}]});
  expect((await post('/ask/history/change',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,requestId,expectedRevision:4,action:{kind:'rename',title:'Restore copied title'}})).status).toBe(409);


 }finally{await fixture.stop();}
});
