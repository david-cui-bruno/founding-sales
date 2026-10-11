import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {dispatch} from '../src/server.ts';
import {recordingSuppressionJournal} from '@fss/domain/suppression/journal.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {registerHandlers} from '../../worker/src/bootstrap/main.ts';
import {runOnce} from '../../worker/src/runner/jobRunner.ts';
it.each(['zero_vector','over_input'] as const)('settles reported embedding usage but refuses an invalid %s projection',async scenario=>{
 const fixture=await createAuthFixture();try{
 const token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.salesperson)).accessToken;
 const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false,suppressionJournal:recordingSuppressionJournal()});
 const command=(body:object)=>({...body,commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION});
 const person=await post('/crm/people/create',command({fullName:'Projection contract'}));const personId=(person.body as {result:{personId:string}}).result.personId;
 await post('/crm/people/source/add',command({personId,sourceKey:'projection-contract',excerpt:'Repair coordination.',occurredAt:'2026-10-01T14:00:00Z'}));
 await fixture.db.query(`INSERT INTO crm_ask_purposes(workspace_id,purpose,revision,enabled,endpoint_id,model_version,access_grant_version,data_handling_version,evaluation_fingerprint,processor_version,retrieval_version,answer_version,support_version,chunker_version,daily_ceiling_cents,monthly_ceiling_cents,input_token_price_micros,output_token_price_micros,approved_by,embedding_dimensions) VALUES($1,'embedding',1,true,'controlled-embedding','embedding-v1','fixture-grant','fixture-handling',$2,'ask-answer-v1','lexical-original-v1','literal-v1','exact-original-v1','lexical-original-v1',100,1000,1,0,$3,256)`,[fixture.alpha.workspaceId,'a'.repeat(64),fixture.alpha.admin.userId]);
 const requested=await post('/ask/index/request',command({scope:{kind:'person',personId},expectedPurposeRevision:1}));const workId=(requested.body as {result:{workId:string}}).result.workId;let calls=0;
 const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmAskIndex:{embedding:{endpointId:'controlled-embedding',modelVersion:'embedding-v1',providerKey:'fixture.ask.embedding',dimensions:256,async embed(){calls++;return {acceptance:'accepted',usage:{inputTokens:scenario==='over_input'?100000:10,outputTokens:0},vector:scenario==='zero_vector'?Array<number>(256).fill(0):[1,...Array<number>(255).fill(0)]};}},allowControlledEvaluation:true,verifyPurpose:async proof=>({configFingerprint:proof.configFingerprint,authorizationFingerprint:proof.authorizationFingerprint,validUntil:'2099-01-01T00:00:00Z',evaluationKind:'controlled_fixture'})}});
 await runOnce(fixture.db,{registry,owner:'invalid-projection-index',limit:20});expect(calls).toBe(1);expect((await post('/ask/index/read',{workId})).body).toMatchObject({state:'unavailable',reason:'embedding_failed',indexedWindows:0});
 const adminToken=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.admin)).accessToken;
 const spend=await dispatch({method:'POST',path:'/research/settings',body:command({}),query:new URLSearchParams(),headers:{authorization:`Bearer ${adminToken}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false,suppressionJournal:recordingSuppressionJournal()});
 expect(spend.body).toMatchObject({result:{spend:{todayCents:scenario==='over_input'?10:1,monthToDateCents:scenario==='over_input'?10:1}}});
 }finally{await fixture.stop();}
});
