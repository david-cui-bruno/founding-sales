import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {z} from 'zod';
import {dispatch} from '../src/server.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {seedFirm} from './support/crmSeed.ts';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {registerHandlers} from '../../worker/src/bootstrap/main.ts';
import {runOnce} from '../../worker/src/runner/jobRunner.ts';
async function scenario(mode:'valid'|'unknown'|'duplicate'|'changed'|'after_changed'|'duplicate_call'|'session'|'cross_request'|'empty_original'|'over_count'|'over_id'){
 const f=await createAuthFixture();try{
 const token=(await issueSessionFor(f,f.alpha,f.alpha.admin)).accessToken;
 const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:f.db,auth:f.deps,supportedClientVersions:f.deps.config.supportedClientVersions,sendingEnabled:false});
 const cmd=(fields:object)=>({commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,...fields});
 expect((await post('/pipeline/stages/create',cmd({key:'contacting',displayName:'Contacting'}))).status).toBe(200);
 const firmId=await seedFirm(f,{name:'Example Sales',assignedUserId:f.alpha.admin.userId});
 const opportunityIds:string[]=[];for(const name of ['North pilot','South pilot']){const opened=await post('/opportunities/v2/open',cmd({firmId,name}));expect(opened.status).toBe(200);opportunityIds.push(z.object({result:z.object({opportunityId:z.uuid()})}).parse(opened.body).result.opportunityId);}
 const selection={text:'The pilot needs a revised proposal. No pilot is named.',subtype:'pasted_text',label:'Proposal conversation',direction:'unknown',participants:[],occurredAt:'2026-10-01T14:00:00Z',attachments:[]};
 const preview=await post('/crm/imports/preview',selection);const committed=await post('/crm/imports/commit',cmd({...selection,personId:null,firmId,importKey:randomUUID(),previewHash:z.object({previewHash:z.string()}).parse(preview.body).previewHash,parserVersion:'selected-v1'}));expect(committed.status).toBe(200);
 const page=await post('/crm/imports/read',{firmId,limit:10});const source=z.object({imports:z.array(z.object({source:z.object({workspaceId:z.uuid(),sourceId:z.uuid(),revision:z.number(),contentHash:z.string()})}))}).parse(page.body).imports[0]!.source;
 await f.db.query(`INSERT INTO crm_ask_purposes(workspace_id,purpose,revision,enabled,endpoint_id,model_version,access_grant_version,data_handling_version,evaluation_fingerprint,processor_version,retrieval_version,answer_version,support_version,chunker_version,daily_ceiling_cents,monthly_ceiling_cents,input_token_price_micros,output_token_price_micros,approved_by) VALUES($1,'answer',1,true,'controlled-answer','literal-v1','fixture-grant','fixture-handling',$2,'ask-answer-v1','lexical-original-v1','literal-v1','exact-original-v1','lexical-original-v1',1000,10000,1,1,$3)`,[f.alpha.workspaceId,'a'.repeat(64),f.alpha.admin.userId]);
 if(mode==='cross_request'){
  const previous=await post('/ask/answers/request',cmd({question:'Read prior exact state',execution:'agent_v1',scope:{sources:[{...source,kind:'selected_note',locator:null}]}}));expect(previous.status).toBe(200);const previousId=z.object({result:z.object({requestId:z.uuid()})}).parse(previous.body).result.requestId;let previousCalls=0;
  const earlier=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmAskAnswers:{agent:{endpointId:'controlled-answer',modelVersion:'literal-v1',providerKey:'fixture.ask.answer',async runStep(){previousCalls++;return {acceptance:'accepted',usage:{inputTokens:20,outputTokens:10},answer:previousCalls===1?null:{claims:[],abstained:true},toolCalls:previousCalls===1?[{id:'foreign-read',name:'read_exact',input:{operation:'opportunities',firmId}}]:[]};}},agentLimits:{maxSteps:3,maxInputBytes:100000,maxOutputTokens:1000,deadlineMs:60000},allowControlledEvaluation:true,verifyPurpose:async proof=>({configFingerprint:proof.configFingerprint,authorizationFingerprint:proof.authorizationFingerprint,validUntil:'2099-01-01T00:00:00Z',evaluationKind:'controlled_fixture'})}});
  await runOnce(f.db,{registry:earlier,owner:'prior-exact-worker',limit:100});expect((await post('/ask/answers/read',{requestId:previousId,includeExactResultCitations:true})).body).toMatchObject({state:'complete',answer:{exactResults:[{toolCallId:'foreign-read'}]}});
 }
 let sessionId:string|undefined;
 if(mode==='session'){const created=await post('/ask/sessions/create',cmd({scope:{kind:'selected',sources:[{...source,kind:'selected_note',locator:null}]}}));expect(created.status).toBe(200);sessionId=z.object({result:z.object({sessionId:z.uuid()})}).parse(created.body).result.sessionId;}
 const request=mode==='session'?await post('/ask/sessions/turn',cmd({sessionId,version:1,question:'Which current pilot needs a revised proposal?'})):await post('/ask/answers/request',cmd({question:'Which current pilot needs a revised proposal?',execution:'agent_v1',scope:{sources:[{...source,kind:'selected_note',locator:null}]}}));expect(request.status).toBe(200);const requestId=z.object({result:z.object({requestId:z.uuid()})}).parse(request.body).result.requestId;
 let calls=0,authority:unknown;
 const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmAskAnswers:{agent:{endpointId:'controlled-answer',modelVersion:'literal-v1',providerKey:'fixture.ask.answer',async runStep(input){calls++;const window=z.object({windows:z.array(z.object({id:z.uuid()}))}).parse(input.transcript[0]).windows[0]!;if(calls===1)return {acceptance:'accepted',usage:{inputTokens:20,outputTokens:10},answer:null,toolCalls:[{id:'read-current',name:'read_exact',input:{operation:'opportunities',firmId}}]};const result=z.object({name:z.literal('read_exact'),result:z.object({evidenceAuthority:z.unknown()})}).parse(input.transcript[1]);authority=result.result.evidenceAuthority;
 if(mode==='duplicate_call')return {acceptance:'accepted',usage:{inputTokens:20,outputTokens:10},answer:null,toolCalls:[{id:'read-current',name:'read_exact',input:{operation:'tasks',firmId}}]};
 if(mode==='changed')expect((await post('/opportunities/stage',cmd({opportunityId:opportunityIds[0],toStageKey:'contacting',expectedStageKey:'new'}))).status).toBe(200);
 return {acceptance:'accepted',usage:{inputTokens:20,outputTokens:10},answer:{claims:[{text:'Two current open pilots are at the new stage, but the original note does not identify which requires the revised proposal.',kind:'conflict',citationWindowIds:mode==='empty_original'?[]:[window.id],exactResultToolCallIds:mode==='unknown'?['another-request-result']:mode==='cross_request'?['foreign-read']:mode==='duplicate'?['read-current','read-current']:mode==='over_count'?Array.from({length:11},(_,index)=>`read-${index}`):mode==='over_id'?['x'.repeat(101)]:['read-current']},{text:'The original note does not identify which pilot it means.',kind:'fact',citationWindowIds:[window.id]}],abstained:false},toolCalls:[]};}},agentLimits:{maxSteps:3,maxInputBytes:100000,maxOutputTokens:1000,deadlineMs:60000},allowControlledEvaluation:true,verifyPurpose:async proof=>({configFingerprint:proof.configFingerprint,authorizationFingerprint:proof.authorizationFingerprint,validUntil:'2099-01-01T00:00:00Z',evaluationKind:'controlled_fixture'})}});
 await runOnce(f.db,{registry,owner:'mixed-proof-worker',limit:100});
 const legacy=await post('/ask/answers/read',{requestId});
 const action=mode==='valid'?await post('/ask/actions/create',cmd({requestId,expectedVersion:1,finding:{kind:'answer_claim',index:0},action:{kind:'task',label:'Discuss pilot proposal',due:null,target:{kind:'firm',firmId}}})):null;
 const originalAction=mode==='valid'?await post('/ask/actions/create',cmd({requestId,expectedVersion:1,finding:{kind:'answer_claim',index:1},action:{kind:'task',label:'Review original pilot ambiguity',due:null,target:{kind:'firm',firmId}}})):null;
 const actions=mode==='valid'?await post('/ask/actions/read',{scope:{kind:'firm',firmId}}):null;
 const sessionViews=sessionId===undefined?null:{rich:await post('/ask/sessions/read',{sessionId,includeExactResultCitations:true}),legacy:await post('/ask/sessions/read',{sessionId}),richList:await post('/ask/sessions/list',{includeExactResultCitations:true}),legacyList:await post('/ask/sessions/list',{})};
 if(mode==='after_changed'){const changed=await post('/opportunities/stage',cmd({opportunityId:opportunityIds[0],toStageKey:'contacting',expectedStageKey:'new'}));expect(changed.status,JSON.stringify(changed.body)).toBe(200);}
 return {calls,authority,legacy,action,originalAction,actions,sessionViews,read:await post('/ask/answers/read',{requestId,includeExactResultCitations:true}),diagnostics:(await post('/ask/answers/diagnostics',{requestId})).body};
 }finally{await f.stop();}
}
it('publishes a mixed interpretation only with its original window and actually executed exact result',async()=>{
 const result=await scenario('valid');expect(result.calls).toBe(2);expect(result.authority).toMatchObject({kind:'current_exact_crm_state',toolCallId:'read-current',citationAuthority:'exact_result_only'});expect(result.read).toMatchObject({status:200,body:{state:'complete',answer:{claims:[{kind:'conflict',exactResultToolCallIds:['read-current'],verification:'cited_unverified'},{kind:'fact',text:'The original note does not identify which pilot it means.'}],exactResults:[{toolCallId:'read-current'}]}}});
});
it.each(['unknown','duplicate','cross_request','empty_original','over_count','over_id'] as const)('refuses %s exact result references without losing known billing',async mode=>{
 const result=await scenario(mode);expect(result.calls).toBe(2);expect(result.read).toMatchObject({status:200,body:{state:'unavailable',reason:'unsupported_answer',answer:null}});expect(result.diagnostics).toMatchObject({usage:{inputTokens:40,outputTokens:20},cost:{unsettledCents:0,estimated:false}});
});
it('refuses stale SQL state changed during the paid generation while conserving its observed usage',async()=>{
 const result=await scenario('changed');expect(result.calls).toBe(2);expect(result.read).toMatchObject({status:200,body:{state:'stale',reason:'source_changed',answer:null}});expect(result.diagnostics).toMatchObject({usage:{inputTokens:40,outputTokens:20},cost:{unsettledCents:0,estimated:false}});
});

it('keeps old strict readers exact-only and refuses mixed claim actions without borrowing original proof',async()=>{
 const result=await scenario('valid');expect(result.legacy).toMatchObject({status:200,body:{state:'unavailable',reason:'unsupported_answer',answer:null}});expect(result.legacy.body).not.toHaveProperty('supportedWork');expect(result.legacy.body).not.toHaveProperty('execution');expect(result.legacy.body).not.toHaveProperty('progress');expect(result.action?.status).not.toBe(200);expect(result.originalAction?.status).toBe(200);expect(result.actions?.body).toMatchObject({items:[{label:'Review original pilot ambiguity'}]});
});
it('does not retain a mixed narrative when its referenced SQL state changes after completion',async()=>{
 const result=await scenario('after_changed');expect(result.read).toMatchObject({status:200,body:{state:'stale',reason:'source_changed',answer:null}});expect(result.diagnostics).toMatchObject({cost:{unsettledCents:0,estimated:false}});
});
it('refuses an exact tool-call ID reused in a later generation because its evidence identity would be ambiguous',async()=>{
 const result=await scenario('duplicate_call');expect(result.calls).toBe(2);expect(result.read).toMatchObject({status:200,body:{state:'unavailable',reason:'unsupported_answer',answer:null}});expect(result.diagnostics).toMatchObject({cost:{unsettledCents:0,estimated:false}});
});
it('negotiates rich citations and legacy-safe nested turns through ordinary session reads and lists',async()=>{
 const {sessionViews}=await scenario('session');expect(sessionViews?.rich).toMatchObject({status:200,body:{turns:[{state:'complete',answer:{claims:[{exactResultToolCallIds:['read-current']},{kind:'fact'}]}}]}});expect(sessionViews?.legacy).toMatchObject({status:200,body:{turns:[{state:'unavailable',reason:'unsupported_answer',answer:null}]}});expect(sessionViews?.richList).toMatchObject({status:200,body:{sessions:[{turns:[{state:'complete',answer:{claims:[{exactResultToolCallIds:['read-current']},{kind:'fact'}]}}]}]}});expect(sessionViews?.legacyList).toMatchObject({status:200,body:{sessions:[{turns:[{state:'unavailable',reason:'unsupported_answer',answer:null}]}]}});
 expect(JSON.stringify(sessionViews?.legacy.body)).not.toContain('exactResultToolCallIds');expect(JSON.stringify(sessionViews?.legacyList.body)).not.toContain('exactResultToolCallIds');
});
