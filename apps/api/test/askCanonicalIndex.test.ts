import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {dispatch} from '../src/server.ts';
import {recordingSuppressionJournal} from '@fss/domain/suppression/journal.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
it('keeps canonical indexing unavailable without its separate embedding purpose',async()=>{
 const fixture=await createAuthFixture();try{
 const token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.salesperson)).accessToken;
 const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false,suppressionJournal:recordingSuppressionJournal()});
 const response=await post('/ask/index/request',{scope:{kind:'business'},expectedPurposeRevision:1,commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION});
 expect(response.status).toBe(200);expect(response.body).toMatchObject({result:{state:'unavailable',reason:'purpose_unavailable'}});
 }finally{await fixture.stop();}
});

import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {registerHandlers} from '../../worker/src/bootstrap/main.ts';
import {runOnce} from '../../worker/src/runner/jobRunner.ts';
import type {AskEmbeddingAdapter,AskAnswerComposition} from '@fss/domain/crm/askAnswerPorts.ts';
it('indexes retained business originals under an independent purpose and conserves an unknown dispatch without creating Ask questions',async()=>{
 const fixture=await createAuthFixture();try{
 const token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.salesperson)).accessToken;
 const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false,suppressionJournal:recordingSuppressionJournal()});
 const command=(body:object)=>({...body,commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION});
 const person=await post('/crm/people/create',command({fullName:'Canonical repair context'}));const personId=(person.body as {result:{personId:string}}).result.personId;
 await post('/crm/people/source/add',command({personId,sourceKey:'canonical-original',excerpt:'We need repairs coordinated.',occurredAt:'2026-10-01T14:00:00Z'}));
 await fixture.db.query(`INSERT INTO crm_ask_purposes(workspace_id,purpose,revision,enabled,endpoint_id,model_version,access_grant_version,data_handling_version,evaluation_fingerprint,processor_version,retrieval_version,answer_version,support_version,chunker_version,daily_ceiling_cents,monthly_ceiling_cents,input_token_price_micros,output_token_price_micros,approved_by,embedding_dimensions) VALUES($1,'embedding',1,true,'controlled-embedding','embedding-v1','fixture-grant','fixture-handling',$2,'ask-answer-v1','lexical-original-v1','literal-v1','exact-original-v1','lexical-original-v1',100,1000,1,0,$3,256)`,[fixture.alpha.workspaceId,'a'.repeat(64),fixture.alpha.admin.userId]);
 const requested=await post('/ask/index/request',command({scope:{kind:'person',personId},expectedPurposeRevision:1}));expect(requested.status).toBe(200);const workId=(requested.body as {result:{workId:string}}).result.workId;
 expect((await post('/ask/index/read',{workId})).body).toMatchObject({state:'pending',indexedWindows:0,totalWindows:1});
 let calls=0;const embedding:AskEmbeddingAdapter={endpointId:'controlled-embedding',modelVersion:'embedding-v1',providerKey:'fixture.ask.embedding',dimensions:256,async embed(input){calls++;expect(input.text).toContain('repairs');return {acceptance:'accepted',usage:{inputTokens:8,outputTokens:0},vector:[1,...Array<number>(255).fill(0)]};}};
 const composition={embedding,allowControlledEvaluation:true,verifyPurpose:async(proof:Parameters<NonNullable<AskAnswerComposition['verifyPurpose']>>[0])=>({configFingerprint:proof.configFingerprint,authorizationFingerprint:proof.authorizationFingerprint,validUntil:'2099-01-01T00:00:00Z',evaluationKind:'controlled_fixture' as const})};
 const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmAskIndex:composition});
 const executed=await runOnce(fixture.db,{registry,owner:'canonical-index-worker',limit:20});expect(executed).toMatchObject({failed:0});
 expect((await post('/ask/index/read',{workId})).body).toMatchObject({reason:null,state:'complete',indexedWindows:1,totalWindows:1});expect(calls).toBe(1);
 const reused=await post('/ask/index/request',command({scope:{kind:'person',personId},expectedPurposeRevision:1}));const reusedId=(reused.body as {result:{workId:string}}).result.workId;await runOnce(fixture.db,{registry,owner:'cached-canonical-index',limit:20});expect((await post('/ask/index/read',{workId:reusedId})).body).toMatchObject({state:'complete',indexedWindows:1});expect(calls).toBe(1);
 await fixture.db.query("UPDATE crm_ask_purposes SET revision=2 WHERE workspace_id=$1 AND purpose='embedding'",[fixture.alpha.workspaceId]);
 const second=await post('/ask/index/request',command({scope:{kind:'person',personId},expectedPurposeRevision:2}));const unknownId=(second.body as {result:{workId:string}}).result.workId;
 let unknownCalls=0;const unknownRegistry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmAskIndex:{...composition,embedding:{...embedding,async embed(){unknownCalls++;return {acceptance:'unknown',usage:null,vector:null};}}}});
 await runOnce(fixture.db,{registry:unknownRegistry,owner:'unknown-canonical-index',limit:20});await runOnce(fixture.db,{registry:unknownRegistry,owner:'unknown-canonical-index-retry',limit:20});
 expect((await post('/ask/index/read',{workId:unknownId})).body).toMatchObject({state:'unknown_acceptance',indexedWindows:0});expect(unknownCalls).toBe(1);
 const repeat=await post('/ask/index/request',command({scope:{kind:'person',personId},expectedPurposeRevision:2}));const repeatId=(repeat.body as {result:{workId:string}}).result.workId;await runOnce(fixture.db,{registry:unknownRegistry,owner:'new-work-unknown-canonical-index',limit:20});expect((await post('/ask/index/read',{workId:repeatId})).body).toMatchObject({state:'unknown_acceptance',indexedWindows:0});expect(unknownCalls).toBe(1);
 const page=await post('/crm/people/read',{personId});const source=(page.body as {sources:{sourceId:string}[]}).sources[0]!;
 await post('/crm/people/source/delete',command({personId,sourceId:source.sourceId,expectedRevision:1}));
 expect((await post('/ask/index/read',{workId})).body).toMatchObject({state:'deleted',indexedWindows:0});
 }finally{await fixture.stop();}
});

import {seedFirm} from './support/crmSeed.ts';
it.each(['delete','revoke'] as const)('settles a dispatched canonical embedding but prevents publication after %s while waiting',async action=>{
 const fixture=await createAuthFixture();try{
 const token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.salesperson)).accessToken;
 const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false,suppressionJournal:recordingSuppressionJournal()});
 const command=(body:object)=>({...body,commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION});
 const firmId=await seedFirm(fixture,{name:'Original canonical access',assignedUserId:fixture.alpha.salesperson.userId});
 const original=await post('/crm/firm-sources/add',command({firmId,sourceKey:'index-access',excerpt:'Repairs are private.',occurredAt:'2026-10-01T14:00:00Z'}));const sourceId=(original.body as {result:{sourceId:string}}).result.sourceId;
 await fixture.db.query(`INSERT INTO crm_ask_purposes(workspace_id,purpose,revision,enabled,endpoint_id,model_version,access_grant_version,data_handling_version,evaluation_fingerprint,processor_version,retrieval_version,answer_version,support_version,chunker_version,daily_ceiling_cents,monthly_ceiling_cents,input_token_price_micros,output_token_price_micros,approved_by,embedding_dimensions) VALUES($1,'embedding',1,true,'controlled-embedding','embedding-v1','fixture-grant','fixture-handling',$2,'ask-answer-v1','lexical-original-v1','literal-v1','exact-original-v1','lexical-original-v1',100,1000,1000,0,$3,256)`,[fixture.alpha.workspaceId,'a'.repeat(64),fixture.alpha.admin.userId]);
 const requested=await post('/ask/index/request',command({scope:{kind:'firm',firmId},expectedPurposeRevision:1}));const workId=(requested.body as {result:{workId:string}}).result.workId;
 let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(resolve=>{enter=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});let calls=0;
 const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmAskIndex:{embedding:{endpointId:'controlled-embedding',modelVersion:'embedding-v1',providerKey:'fixture.ask.embedding',dimensions:256,async embed(){calls++;enter();await held;return {acceptance:'accepted',usage:{inputTokens:10,outputTokens:0},vector:[1,...Array<number>(255).fill(0)]};}},allowControlledEvaluation:true,verifyPurpose:async proof=>({configFingerprint:proof.configFingerprint,authorizationFingerprint:proof.authorizationFingerprint,validUntil:'2099-01-01T00:00:00Z',evaluationKind:'controlled_fixture'})}});
 const session=await fixture.database.appRuntimeSession();const running=runOnce(session,{registry,owner:'held-index-worker',limit:20});
 try{await entered;if(action==='delete')expect((await post('/crm/firm-sources/delete',command({firmId,sourceId,expectedRevision:1}))).status).toBe(200);else await fixture.db.query('UPDATE firms SET assigned_user_id=$3 WHERE workspace_id=$1 AND id=$2',[fixture.alpha.workspaceId,firmId,fixture.alpha.admin.userId]);}finally{release();await running;}
 expect((await post('/ask/index/read',{workId})).body).toMatchObject({state:action==='delete'?'deleted':'stale',indexedWindows:0});expect(calls).toBe(1);
 const adminToken=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.admin)).accessToken;
 const spend=await dispatch({method:'POST',path:'/research/settings',body:command({}),query:new URLSearchParams(),headers:{authorization:`Bearer ${adminToken}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false,suppressionJournal:recordingSuppressionJournal()});
 expect(spend.body).toMatchObject({result:{spend:{todayCents:1,monthToDateCents:1}}});
 }finally{await fixture.stop();}
});
