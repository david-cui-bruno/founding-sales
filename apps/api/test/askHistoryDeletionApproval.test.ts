import {createHash,randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {recordingSuppressionJournal} from '@fss/domain/suppression/journal.ts';
import {dispatch} from '../src/server.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {seedFirm} from './support/crmSeed.ts';

it('requires a fresh deletion approval after copied private history metadata changes',async()=>{
 const fixture=await createAuthFixture();
 try{
  const token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.admin)).accessToken;
  const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false,suppressionJournal:recordingSuppressionJournal()});
  const command=(fields:object)=>({commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,...fields});
  const firmId=await seedFirm(fixture,{name:'Private title deletion',assignedUserId:fixture.alpha.admin.userId});
  const text='Maintenance coordinator review.';
  const source=await post('/crm/firm-sources/add',command({firmId,sourceKey:'private-title-source',excerpt:text,occurredAt:'2026-10-01T14:00:00Z'}));
  expect(source.status).toBe(200);
  const sourceId=(source.body as {result:{sourceId:string}}).result.sourceId;
  const request=await post('/ask/answers/request',command({question:'maintenance',scope:{sources:[{workspaceId:fixture.alpha.workspaceId,sourceId,kind:'selected_note',revision:1,contentHash:createHash('sha256').update(text).digest('hex'),locator:null}]}}));
  expect(request.status).toBe(200);
  const requestId=(request.body as {result:{requestId:string}}).result.requestId;
  const preview=await post('/retention/deletions/preview',command({targetKind:'firm',firmId}));
  expect(preview.status).toBe(200);
  const shown=(preview.body as {result:{requestId:string;previewHash:string}}).result;
  expect((await post('/ask/history/change',command({requestId,expectedRevision:1,action:{kind:'rename',title:'New private source detail'}}))).status).toBe(200);
  const stale=await post('/retention/deletions/commit',command({requestId:shown.requestId,previewHash:shown.previewHash}));
  expect(stale.status).toBe(409);
 }finally{await fixture.stop();}
});
