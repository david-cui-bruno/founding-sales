import {createHash,randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {recordingSuppressionJournal} from '@fss/domain/suppression/journal.ts';
import {dispatch} from '../src/server.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {seedFirm} from './support/crmSeed.ts';

it('withholds private manual action content and refuses completion after original firm access is revoked',async()=>{
 const fixture=await createAuthFixture();
 try{
  const token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.salesperson)).accessToken;
  const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false,suppressionJournal:recordingSuppressionJournal()});
  const command=(fields:object)=>({commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,...fields});
  const firmId=await seedFirm(fixture,{name:'Manual annotation original context',assignedUserId:fixture.alpha.salesperson.userId});
  const text='Maintenance coordinator review.';
  const source=await post('/crm/firm-sources/add',command({firmId,sourceKey:'manual-note-erasure',excerpt:text,occurredAt:'2026-10-01T14:00:00Z'}));
  expect(source.status).toBe(200);
  const sourceId=(source.body as {result:{sourceId:string}}).result.sourceId;
  const requested=await post('/ask/answers/request',command({question:'maintenance',scope:{sources:[{workspaceId:fixture.alpha.workspaceId,sourceId,kind:'selected_note',revision:1,contentHash:createHash('sha256').update(text).digest('hex'),locator:null}]}}));
  expect(requested.status).toBe(200);
  const requestId=(requested.body as {result:{requestId:string}}).result.requestId;
  const created=await post('/ask/actions/create',command({requestId,expectedVersion:1,finding:{kind:'keyword_passage',index:0},action:{kind:'task',label:'Discuss the private coordinator workflow.',due:null,target:{kind:'firm',firmId}}}));
  expect(created.status).toBe(200);
  const actionId=(created.body as {result:{actionId:string}}).result.actionId;
  // Controlled fixture revokes the original firm assignment; assertions remain public API reads.
  await fixture.db.query('UPDATE firms SET assigned_user_id=$3 WHERE workspace_id=$1 AND id=$2',[fixture.alpha.workspaceId,firmId,fixture.alpha.admin.userId]);
  const after=await post('/ask/actions/read',{scope:{kind:'history'}});
  expect(after.status).toBe(200);
  expect(after.body).toMatchObject({items:[{actionId,kind:'task',status:'open',supportState:'unavailable',text:null,label:null,target:null,due:null,sources:[]}]});
  expect(JSON.stringify(after.body)).not.toContain('coordinator workflow');
  const completion=await post('/ask/actions/change',command({actionId,expectedVersion:1,action:'complete_task'}));
  expect(completion.status).toBe(409);
  const cancellation=await post('/ask/actions/change',command({actionId,expectedVersion:1,action:'cancel_task'}));
  expect(cancellation.status).toBe(200);
  expect(cancellation.body).toMatchObject({result:{actionId,version:2,status:'cancelled',completedAt:null}});
 }finally{await fixture.stop();}
});
