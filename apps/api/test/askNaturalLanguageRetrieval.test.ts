import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {dispatch} from '../src/server.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {registerHandlers} from '../../worker/src/bootstrap/main.ts';
import {runOnce} from '../../worker/src/runner/jobRunner.ts';
it('finds ordinary partial keyword overlap while preserving explicit phrases, alternatives and exclusions',async()=>{
 const f=await createAuthFixture();try{
 const token=(await issueSessionFor(f,f.alpha,f.alpha.salesperson)).accessToken;
 const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:f.db,auth:f.deps,supportedClientVersions:f.deps.config.supportedClientVersions,sendingEnabled:false});
 const cmd=(fields:object)=>({commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,...fields});
 const created=await post('/crm/people/create',cmd({fullName:'Search person'}));const personId=(created.body as {result:{personId:string}}).result.personId;
 for(const [index,excerpt]of ['Coordinating plumbers for repairs.','Maintenance coordination for tenants.','Repairs cancelled yesterday.','For everyone there.'].entries())expect((await post('/crm/people/source/add',cmd({personId,sourceKey:`search-${index}`,excerpt,occurredAt:'2026-10-01T14:00:00Z'}))).status).toBe(200);
 await f.db.query(`INSERT INTO crm_ask_purposes(workspace_id,purpose,revision,enabled,endpoint_id,model_version,access_grant_version,data_handling_version,evaluation_fingerprint,processor_version,retrieval_version,answer_version,support_version,chunker_version,daily_ceiling_cents,monthly_ceiling_cents,input_token_price_micros,output_token_price_micros,approved_by) VALUES($1,'answer',1,true,'controlled-answer','literal-v1','fixture-grant','fixture-handling',$2,'ask-answer-v1','lexical-original-v1','literal-v1','exact-original-v1','lexical-original-v1',1000,10000,1,1,$3)`,[f.alpha.workspaceId,'a'.repeat(64),f.alpha.admin.userId]);
 await f.db.query(`INSERT INTO crm_ask_purposes(workspace_id,purpose,revision,enabled,endpoint_id,model_version,access_grant_version,data_handling_version,evaluation_fingerprint,processor_version,retrieval_version,answer_version,support_version,chunker_version,daily_ceiling_cents,monthly_ceiling_cents,input_token_price_micros,output_token_price_micros,approved_by) SELECT workspace_id,'embedding',1,true,'controlled-embedding','embedding-v1',access_grant_version,data_handling_version,evaluation_fingerprint,processor_version,retrieval_version,answer_version,support_version,chunker_version,daily_ceiling_cents,monthly_ceiling_cents,input_token_price_micros,output_token_price_micros,approved_by FROM crm_ask_purposes WHERE workspace_id=$1 AND purpose='answer'`,[f.alpha.workspaceId]);
 for(const [query,expected]of [
 ['What is maintenance repairs for',['Coordinating plumbers for repairs.','Maintenance coordination for tenants.','Repairs cancelled yesterday.']],
 ['What maintenance or repairs are needed?',['Coordinating plumbers for repairs.','Maintenance coordination for tenants.','Repairs cancelled yesterday.']],
 ['"maintenance coordination"',['Maintenance coordination for tenants.']],
 ['plumbers OR tenants',['Coordinating plumbers for repairs.','Maintenance coordination for tenants.']],
 ['repairs -cancelled',['Coordinating plumbers for repairs.']],
 ] as const){
 const request=await post('/ask/answers/request',cmd({question:query,execution:'agent_v1',agentScope:{kind:'business'},scope:{sources:[]}}));expect(request.status).toBe(200);let calls=0,embeddingCalls=0,observed:string[]=[];
 const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmAskAnswers:{agent:{endpointId:'controlled-answer',modelVersion:'literal-v1',providerKey:'fixture.ask.answer',async runStep(input){calls++;if(calls===1)return {acceptance:'accepted',usage:{inputTokens:20,outputTokens:10},answer:null,toolCalls:[{id:'search',name:'search_history',input:{query,limit:5}}]};const result=input.transcript.find((entry):entry is {name:string;result:{windows:{text:string}[]}}=>typeof entry==='object'&&entry!==null&&'name'in entry&&entry.name==='search_history');observed=result?.result.windows.map(window=>window.text)??[];return {acceptance:'accepted',usage:{inputTokens:20,outputTokens:10},answer:{claims:[],abstained:true},toolCalls:[]};}},...query==='What is maintenance repairs for'?{}:{embedding:{endpointId:'controlled-embedding',modelVersion:'embedding-v1',providerKey:'fixture.ask.embedding',dimensions:256,async embed(){embeddingCalls++;return {acceptance:'accepted' as const,usage:{inputTokens:10,outputTokens:0},vector:[1,...Array<number>(255).fill(0)]};}}},agentLimits:{maxSteps:2,maxInputBytes:100000,maxOutputTokens:1000,deadlineMs:60000},allowControlledEvaluation:true,verifyPurpose:async proof=>({configFingerprint:proof.configFingerprint,authorizationFingerprint:proof.authorizationFingerprint,validUntil:'2099-01-01T00:00:00Z',evaluationKind:'controlled_fixture'})}});
 await runOnce(f.db,{registry,owner:'natural-language-search-worker',limit:100});expect(observed.sort()).toEqual([...expected].sort());expect(calls).toBe(2);expect(embeddingCalls).toBe(query==='What maintenance or repairs are needed?'?1:0);
 }
 }finally{await f.stop();}
});
