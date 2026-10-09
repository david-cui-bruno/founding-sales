import {createHash, randomUUID} from 'node:crypto';
import {expect, it} from 'vitest';
import {dispatch} from '../src/server.ts';
import {createAuthFixture, CURRENT_CLIENT_VERSION} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {registerHandlers} from '../../worker/src/bootstrap/main.ts';
import {runOnce} from '../../worker/src/runner/jobRunner.ts';
import type {AskInputWindow,AskPurposeProofInput} from '@fss/domain/crm/askAnswerPorts.ts';

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
  const requested=await post('/ask/answers/request',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,question:'maintenance process',scope:{sources:[{workspaceId:fixture.alpha.workspaceId,sourceId,kind:'selected_note',revision:1,contentHash:createHash('sha256').update(text).digest('hex'),locator:null}]}});
  expect(requested.status).toBe(200);
  expect(requested.body).toMatchObject({result:{requestId:expect.any(String),version:1,state:'unavailable'}});
  expect(JSON.stringify(requested.body)).not.toContain(text);
  expect(JSON.stringify(requested.body)).not.toContain('maintenance process');
  const requestId=(requested.body as {result:{requestId:string}}).result.requestId;
  const read=await post('/ask/answers/read',{requestId});
  expect(read.status).toBe(200);
  expect(read.body).toMatchObject({requestId,state:'unavailable',reason:'purpose_unavailable',question:'maintenance process',answer:null,fallback:{operation:'passages',passages:[{text,sources:[{sourceId}]}]}});
 }finally{await fixture.stop();}
});

it('answers through the registered controlled-purpose worker and navigates a current original quote',async()=>{
 const fixture=await createAuthFixture();
 try{
  const token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.salesperson)).accessToken;
  const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false});
  const person=await post('/crm/people/create',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,fullName:'Controlled answer source owner'});
  const personId=(person.body as {result:{personId:string}}).result.personId;
  const text='We need faster repairs.';
  expect((await post('/crm/people/source/add',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,personId,sourceKey:'controlled-answer-source',excerpt:text,occurredAt:'2026-10-01T14:00:00Z'})).status).toBe(200);
  const page=await post('/crm/people/read',{personId});
  const original=(page.body as {sources:{workspaceId:string;sourceId:string;revision:number;contentHash:string}[]}).sources[0]!;
  const source={workspaceId:original.workspaceId,sourceId:original.sourceId,revision:original.revision,contentHash:original.contentHash,kind:'selected_note',locator:null};
  // Controlled setup only: no public purpose activation exists.
  await fixture.db.query(`INSERT INTO crm_ask_purposes(workspace_id,purpose,revision,enabled,endpoint_id,model_version,access_grant_version,data_handling_version,evaluation_fingerprint,processor_version,retrieval_version,answer_version,support_version,chunker_version,daily_ceiling_cents,monthly_ceiling_cents,input_token_price_micros,output_token_price_micros,approved_by) VALUES($1,'answer',1,true,'controlled-answer','literal-v1','ask-only-fixture-grant','fixture-no-retention',$2,'ask-answer-v1','lexical-original-v1','literal-v1','exact-original-v1','lexical-original-v1',10,100,1,1,$3)`,[fixture.alpha.workspaceId,'a'.repeat(64),fixture.alpha.admin.userId]);
  const requested=await post('/ask/answers/request',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,question:'repairs',scope:{sources:[source]}});
  expect(requested.status).toBe(200);
  expect(requested.body).toMatchObject({result:{state:'pending'}});
  const requestId=(requested.body as {result:{requestId:string}}).result.requestId;
  const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmAskAnswers:{allowControlledEvaluation:true,verifyPurpose:async(proof:AskPurposeProofInput)=>({configFingerprint:proof.configFingerprint,authorizationFingerprint:proof.authorizationFingerprint,validUntil:'2099-01-01T00:00:00Z',evaluationKind:'controlled_fixture' as const}),answer:{endpointId:'controlled-answer',modelVersion:'literal-v1',providerKey:'fixture.ask.answer',run:async(input:{windows:readonly AskInputWindow[]})=>({acceptance:'accepted' as const,usage:{inputTokens:50,outputTokens:10},answer:{claims:[{text,kind:'extractive',citationWindowIds:[input.windows[0]!.id]}],abstained:false}})}}});
  expect((await runOnce(fixture.db,{registry,owner:'controlled-ask-worker',limit:20})).claimed).toBeGreaterThan(0);
  const read=await post('/ask/answers/read',{requestId});
  expect(read.status).toBe(200);
  expect(read.body).toMatchObject({state:'complete',answer:{claims:[{text,kind:'extractive',verification:'supported'}],abstained:false,coverage:{semantic:'unverified'}}});
  const value=read.body as {version:number;answer:{claims:{citationWindowIds:string[]}[]}};
  const navigation=await post('/ask/answers/source/read',{requestId,expectedVersion:value.version,windowId:value.answer.claims[0]!.citationWindowIds[0]});
  expect(navigation.status).toBe(200);
  expect(navigation.body).toMatchObject({source:{passage:{text,locator:'text:0:23'},source:{sourceId:source.sourceId}}});
 }finally{await fixture.stop();}
});
