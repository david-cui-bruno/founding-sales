import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {dispatch} from '../src/server.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {admitAskSources,readAskExecutionEvidence} from '@fss/domain/crm/askExecutionEvidence.ts';
it('erases dynamically admitted originals and retained identity context when the canonical source changes',async()=>{
 const fixture=await createAuthFixture();try{
 const actor={kind:'user' as const,userId:fixture.alpha.salesperson.userId,role:'salesperson' as const};const context={db:fixture.db,scope:workspaceScope(fixture.alpha.workspaceId,actor)};
 const token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.salesperson)).accessToken;
 const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false});
 const command=(body:object)=>({...body,commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION});
 const person=await post('/crm/people/create',command({fullName:'Admission evidence person'}));const personId=(person.body as {result:{personId:string}}).result.personId;
 const added=await post('/crm/people/source/add',command({personId,sourceKey:'admitted',excerpt:'Evidence admitted after the first model step.',occurredAt:'2026-10-01T14:00:00Z'}));expect(added.status).toBe(200);
 const read=await post('/ask/read',{operation:'sources',scope:{personId},limit:50});const source=(read.body as {sources:{workspaceId:string;kind:'selected_note';sourceId:string;revision:number;contentHash:string}[]}).sources[0]!;
 await fixture.db.query(`INSERT INTO crm_ask_purposes(workspace_id,purpose,revision,enabled,endpoint_id,model_version,access_grant_version,data_handling_version,evaluation_fingerprint,processor_version,retrieval_version,answer_version,support_version,chunker_version,daily_ceiling_cents,monthly_ceiling_cents,input_token_price_micros,output_token_price_micros,approved_by) VALUES($1,'answer',1,true,'controlled-answer','literal-v1','fixture-grant','fixture-handling',$2,'ask-answer-v1','lexical-original-v1','literal-v1','exact-original-v1','lexical-original-v1',100,1000,1,1,$3)`,[fixture.alpha.workspaceId,'a'.repeat(64),fixture.alpha.admin.userId]);
 const created=await post('/ask/answers/request',command({question:'What evidence?',execution:'agent_v1',agentScope:{kind:'business'},scope:{sources:[]}}));expect(created.status).toBe(200);const requestId=(created.body as {result:{requestId:string}}).result.requestId;const key={requestId,version:1,epoch:1};
 expect(await withTransaction(fixture.db,()=>admitAskSources(context,key,[{workspaceId:source.workspaceId,kind:source.kind,sourceId:source.sourceId,revision:source.revision,contentHash:source.contentHash,locator:null}]))).toBe(true);
 expect((await withTransaction(fixture.db,()=>readAskExecutionEvidence(context,key)))?.scope.sources).toHaveLength(1);
 expect((await fixture.db.query('SELECT scope FROM crm_ask_requests WHERE id=$1',[requestId])).rows[0]).toEqual({scope:{sources:[]}});
 const erased=await post('/crm/people/source/delete',command({personId,sourceId:source.sourceId,expectedRevision:source.revision}));expect(erased.status).toBe(200);
 expect((await post('/ask/answers/read',{requestId})).body).toMatchObject({state:'stale',question:null,answer:null,fallback:null});
 expect((await fixture.db.query('SELECT * FROM crm_ask_admitted_sources WHERE request_id=$1',[requestId])).rows).toHaveLength(0);
 expect(await withTransaction(fixture.db,()=>readAskExecutionEvidence(context,key))).toBeNull();
 }finally{await fixture.stop();}
});
