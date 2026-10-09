import {createHash,randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {recordingSuppressionJournal} from '@fss/domain/suppression/journal.ts';
import {dispatch} from '../src/server.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {seedFirm} from './support/crmSeed.ts';

it('measures and erases an independently committed human note when its original firm evidence is deleted',async()=>{
 const fixture=await createAuthFixture();
 try{
  const token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.admin)).accessToken;
  const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false,suppressionJournal:recordingSuppressionJournal()});
  const command=(fields:object)=>({commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,...fields});
  const firmId=await seedFirm(fixture,{name:'Manual annotation original context',assignedUserId:fixture.alpha.admin.userId});
  const text='Maintenance coordinator review.';
  const source=await post('/crm/firm-sources/add',command({firmId,sourceKey:'manual-note-erasure',excerpt:text,occurredAt:'2026-10-01T14:00:00Z'}));
  expect(source.status).toBe(200);
  const sourceId=(source.body as {result:{sourceId:string}}).result.sourceId;
  const requested=await post('/ask/answers/request',command({question:'maintenance',scope:{sources:[{workspaceId:fixture.alpha.workspaceId,sourceId,kind:'selected_note',revision:1,contentHash:createHash('sha256').update(text).digest('hex'),locator:null}]}}));
  expect(requested.status).toBe(200);
  const requestId=(requested.body as {result:{requestId:string}}).result.requestId;
  const created=await post('/ask/actions/create',command({requestId,expectedVersion:1,finding:{kind:'keyword_passage',index:0},action:{kind:'note',text:'Discuss the private coordinator workflow.',target:{kind:'firm',firmId}}}));
  expect(created.status).toBe(200);
  const actionId=(created.body as {result:{actionId:string}}).result.actionId;
  const preview=await post('/retention/deletions/preview',command({targetKind:'firm',firmId}));
  expect(preview.status).toBe(200);
  expect(preview.body).toMatchObject({result:{redacts:{crm_ask_actions:1}}});
  const shown=(preview.body as {result:{requestId:string;previewHash:string}}).result;
  const committed=await post('/retention/deletions/commit',command({requestId:shown.requestId,previewHash:shown.previewHash}));
  expect(committed.status).toBe(200);
  expect(committed.body).toMatchObject({result:{redacted:{crm_ask_actions:1}}});
  const history=await post('/ask/actions/read',{scope:{kind:'history'}});
  expect(history.status).toBe(200);
  expect(history.body).toMatchObject({items:[{actionId,supportState:'deleted',text:null,label:null,target:null,sources:[]}]});
 }finally{await fixture.stop();}
});
