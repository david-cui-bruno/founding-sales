import {createHash, randomUUID} from 'node:crypto';
import {expect, it} from 'vitest';
import {crmProcessingResultSchema} from '@fss/contracts';
import {dispatch} from '../src/server.ts';
import {createAuthFixture, CURRENT_CLIENT_VERSION} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {registerHandlers} from '../../worker/src/bootstrap/main.ts';
import {runOnce} from '../../worker/src/runner/jobRunner.ts';
import type {AskInputWindow,AskPurposeProofInput} from '@fss/domain/crm/askAnswerPorts.ts';
import {seedFirm} from './support/crmSeed.ts';

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
  expect(read.body).toMatchObject({state:'complete',answer:{claims:[{text,kind:'extractive',verification:'supported'}],abstained:false,coverage:{semantic:'unverified',input:'partial'},missingEvidence:['input_partial']}});
  const value=read.body as {version:number;answer:{claims:{citationWindowIds:string[]}[]}};
  const navigation=await post('/ask/answers/source/read',{requestId,expectedVersion:value.version,windowId:value.answer.claims[0]!.citationWindowIds[0]});
  expect(navigation.status).toBe(200);
  expect(navigation.body).toMatchObject({source:{passage:{text,locator:'text:0:23'},source:{sourceId:source.sourceId}}});
  const interrupted=await post('/ask/answers/request',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,question:'repairs',scope:{sources:[source]}});
  expect(interrupted.status).toBe(200);
  const interruptedId=(interrupted.body as {result:{requestId:string}}).result.requestId;
  let release!:()=>void,started!:()=>void,calls=0;
  const wait=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{started=resolve;});
  const interruptedRegistry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmAskAnswers:{allowControlledEvaluation:true,verifyPurpose:async(proof:AskPurposeProofInput)=>({configFingerprint:proof.configFingerprint,authorizationFingerprint:proof.authorizationFingerprint,validUntil:'2099-01-01T00:00:00Z',evaluationKind:'controlled_fixture' as const}),answer:{endpointId:'controlled-answer',modelVersion:'literal-v1',providerKey:'fixture.ask.answer',run:async()=>{calls++;started();await wait;return {acceptance:'unknown' as const,usage:null,answer:null};}}}});
  const first=await fixture.database.appRuntimeSession(),second=await fixture.database.appRuntimeSession();
  const running=runOnce(first,{registry:interruptedRegistry,owner:'ask-interrupted-first',limit:20});
  await entered;
  try{
   const firmId=await seedFirm(fixture,{name:'Conserved Ask spend read',assignedUserId:fixture.alpha.salesperson.userId});
   expect((await post('/research/firm',{firmId})).body).toMatchObject({spend:{monthToDateCents:2}});
   await fixture.db.query("UPDATE jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1 AND payload->>'requestId'=$2 AND state='running'",[fixture.alpha.workspaceId,interruptedId]);
   await runOnce(second,{registry:interruptedRegistry,owner:'ask-interrupted-reclaim',limit:20});
   await fixture.db.query("UPDATE jobs SET not_before=clock_timestamp()-interval '1 second',run_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1 AND payload->>'requestId'=$2 AND state='queued'",[fixture.alpha.workspaceId,interruptedId]);
   await runOnce(second,{registry:interruptedRegistry,owner:'ask-interrupted-second',limit:20});
   expect((await post('/ask/answers/read',{requestId:interruptedId})).body).toMatchObject({state:'unknown_acceptance',reason:'provider_acceptance_unknown',answer:null});
   expect((await post('/research/firm',{firmId})).body).toMatchObject({spend:{monthToDateCents:2}});
   expect(calls).toBe(1);
  }finally{release();await running;}
  const changed=await post('/ask/answers/request',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,question:'repairs',scope:{sources:[source]}});
  const changedId=(changed.body as {result:{requestId:string}}).result.requestId;
  let continueAnswer!:()=>void,answerEntered!:()=>void;
  const blockedAnswer=new Promise<void>(resolve=>{continueAnswer=resolve;}),paidEntered=new Promise<void>(resolve=>{answerEntered=resolve;});
  const changedRegistry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmAskAnswers:{allowControlledEvaluation:true,verifyPurpose:async(proof:AskPurposeProofInput)=>({configFingerprint:proof.configFingerprint,authorizationFingerprint:proof.authorizationFingerprint,validUntil:'2099-01-01T00:00:00Z',evaluationKind:'controlled_fixture' as const}),answer:{endpointId:'controlled-answer',modelVersion:'literal-v1',providerKey:'fixture.ask.answer',run:async(input:{windows:readonly AskInputWindow[]})=>{answerEntered();await blockedAnswer;return {acceptance:'accepted' as const,usage:{inputTokens:20,outputTokens:10},answer:{claims:[{text,kind:'extractive',citationWindowIds:[input.windows[0]!.id]}],abstained:false}};}}}});
  const changedSession=await fixture.database.appRuntimeSession();
  const changedRunning=runOnce(changedSession,{registry:changedRegistry,owner:'ask-purpose-change',limit:20});
  await paidEntered;
  try{await fixture.db.query("UPDATE crm_ask_purposes SET revision=2 WHERE workspace_id=$1 AND purpose='answer'",[fixture.alpha.workspaceId]);}finally{continueAnswer();await changedRunning;}
  expect((await post('/ask/answers/read',{requestId:changedId})).body).toMatchObject({state:'stale',reason:'purpose_changed',question:null,fallback:null,answer:null});
  const spendFirm=await seedFirm(fixture,{name:'Truthful purpose-change spend',assignedUserId:fixture.alpha.salesperson.userId});
  expect((await post('/research/firm',{firmId:spendFirm})).body).toMatchObject({spend:{monthToDateCents:3}});
  const competingText=Array.from({length:10},(_,index)=>{const prefix=`repairs group ${index} `;return prefix+'x'.repeat(2000-prefix.length);}).join('');
  const competitor=await post('/crm/people/source/add',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,personId,sourceKey:'eleven-group-source',excerpt:competingText,occurredAt:'2026-10-01T14:00:00Z'});
  expect(competitor.status).toBe(200);
  const competingPage=await post('/crm/people/read',{personId});
  const competingSource=(competingPage.body as {sources:{workspaceId:string;sourceId:string;revision:number;contentHash:string}[]}).sources.find(value=>value.sourceId!==source.sourceId)!;
  const bounded=await post('/ask/answers/request',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,question:'repairs',scope:{sources:[source,{workspaceId:competingSource.workspaceId,sourceId:competingSource.sourceId,revision:competingSource.revision,contentHash:competingSource.contentHash,kind:'selected_note',locator:null}]}});
  const boundedId=(bounded.body as {result:{requestId:string}}).result.requestId;
  const boundedRegistry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmAskAnswers:{allowControlledEvaluation:true,verifyPurpose:async(proof:AskPurposeProofInput)=>({configFingerprint:proof.configFingerprint,authorizationFingerprint:proof.authorizationFingerprint,validUntil:'2099-01-01T00:00:00Z',evaluationKind:'controlled_fixture' as const}),answer:{endpointId:'controlled-answer',modelVersion:'literal-v1',providerKey:'fixture.ask.answer',run:async(input:{windows:readonly AskInputWindow[]})=>({acceptance:'accepted' as const,usage:{inputTokens:50,outputTokens:10},answer:{claims:[{text:'repairs',kind:'extractive',citationWindowIds:[input.windows[0]!.id]}],abstained:false}})}}});
  await runOnce(fixture.db,{registry:boundedRegistry,owner:'ask-bounded-groups',limit:20});
  expect((await post('/ask/answers/read',{requestId:boundedId})).body).toMatchObject({state:'complete',answer:{coverage:{input:'partial',semantic:'unverified'},missingEvidence:['input_partial']}});
  const rerouted=await post('/ask/answers/request',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,question:'repairs',scope:{sources:[source]}});
  const reroutedId=(rerouted.body as {result:{requestId:string}}).result.requestId;
  let verifications=0,reroutedCalls=0;
  const mutableAdapter={endpointId:'controlled-answer',modelVersion:'literal-v1',providerKey:'fixture.ask.answer',run:async(input:{windows:readonly AskInputWindow[]})=>{reroutedCalls++;return {acceptance:'accepted' as const,usage:{inputTokens:50,outputTokens:10},answer:{claims:[{text,kind:'extractive',citationWindowIds:[input.windows[0]!.id]}],abstained:false}};}};
  const reroutedRegistry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmAskAnswers:{allowControlledEvaluation:true,verifyPurpose:async(proof:AskPurposeProofInput)=>{if(++verifications===2){mutableAdapter.endpointId='different-private-route';mutableAdapter.modelVersion='different-model';mutableAdapter.providerKey='fixture.other-provider';}return {configFingerprint:proof.configFingerprint,authorizationFingerprint:proof.authorizationFingerprint,validUntil:'2099-01-01T00:00:00Z',evaluationKind:'controlled_fixture' as const};},answer:mutableAdapter}});
  await runOnce(fixture.db,{registry:reroutedRegistry,owner:'ask-mutable-route',limit:20});
  expect(reroutedCalls).toBe(0);
  expect((await post('/ask/answers/read',{requestId:reroutedId})).body).toMatchObject({state:'unavailable',reason:'processing_authority_unavailable',answer:null});
  const mutatedOutcomeRequest=await post('/ask/answers/request',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,question:'repairs',scope:{sources:[source]}});
  const mutatedOutcomeId=(mutatedOutcomeRequest.body as {result:{requestId:string}}).result.requestId;
  let outcomeVerifications=0;
  const mutableOutcome={acceptance:'accepted' as const,usage:{inputTokens:50,outputTokens:10},answer:{claims:[{text,kind:'extractive',citationWindowIds:[] as string[]}],abstained:false}};
  const outcomeRegistry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmAskAnswers:{allowControlledEvaluation:true,verifyPurpose:async(proof:AskPurposeProofInput)=>{if(++outcomeVerifications===3){mutableOutcome.answer.claims[0]!.text='repairs';mutableOutcome.usage.inputTokens=99999;}return {configFingerprint:proof.configFingerprint,authorizationFingerprint:proof.authorizationFingerprint,validUntil:'2099-01-01T00:00:00Z',evaluationKind:'controlled_fixture' as const};},answer:{endpointId:'controlled-answer',modelVersion:'literal-v1',providerKey:'fixture.ask.answer',run:async(input:{windows:readonly AskInputWindow[]})=>{mutableOutcome.answer.claims[0]!.citationWindowIds=[input.windows[0]!.id];return mutableOutcome;}}}});
  await runOnce(fixture.db,{registry:outcomeRegistry,owner:'ask-mutable-outcome',limit:20});
  expect((await post('/ask/answers/read',{requestId:mutatedOutcomeId})).body).toMatchObject({state:'complete',answer:{claims:[{text}],coverage:{semantic:'unverified'}}});
  const reservedRequest=await post('/ask/answers/request',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,question:'repairs',scope:{sources:[source]}});
  const reservedId=(reservedRequest.body as {result:{requestId:string}}).result.requestId;
  let reservedVerifications=0,reservedCalls=0,releaseReserved!:()=>void,reservedEntered!:()=>void;
  const reservedWait=new Promise<void>(resolve=>{releaseReserved=resolve;}),reservationReady=new Promise<void>(resolve=>{reservedEntered=resolve;});
  const reservedRegistry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmAskAnswers:{allowControlledEvaluation:true,verifyPurpose:async(proof:AskPurposeProofInput)=>{if(++reservedVerifications===2){reservedEntered();await reservedWait;}return {configFingerprint:proof.configFingerprint,authorizationFingerprint:proof.authorizationFingerprint,validUntil:'2099-01-01T00:00:00Z',evaluationKind:'controlled_fixture' as const};},answer:{endpointId:'controlled-answer',modelVersion:'literal-v1',providerKey:'fixture.ask.answer',run:async(input:{windows:readonly AskInputWindow[]})=>{reservedCalls++;return {acceptance:'accepted' as const,usage:{inputTokens:50,outputTokens:10},answer:{claims:[{text,kind:'extractive',citationWindowIds:[input.windows[0]!.id]}],abstained:false}};}}}});
  const reservedFirst=await fixture.database.appRuntimeSession(),reservedSecond=await fixture.database.appRuntimeSession();
  const reservedRunning=runOnce(reservedFirst,{registry:reservedRegistry,owner:'ask-reserved-first',limit:20});
  await reservationReady;
  try{
   const beforeReservation=(await post('/research/firm',{firmId:spendFirm})).body as {spend:{monthToDateCents:number}};
   await fixture.db.query("UPDATE jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1 AND payload->>'requestId'=$2 AND state='running'",[fixture.alpha.workspaceId,reservedId]);
   await runOnce(reservedSecond,{registry:reservedRegistry,owner:'ask-reserved-reclaim',limit:20});
   await fixture.db.query("UPDATE jobs SET not_before=clock_timestamp()-interval '1 second',run_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1 AND payload->>'requestId'=$2 AND state='queued'",[fixture.alpha.workspaceId,reservedId]);
   await runOnce(reservedSecond,{registry:reservedRegistry,owner:'ask-reserved-second',limit:20});
   expect((await post('/ask/answers/read',{requestId:reservedId})).body).toMatchObject({state:'unavailable',reason:'processing_authority_unavailable',answer:null});
   expect((await post('/research/firm',{firmId:spendFirm})).body).toMatchObject({spend:{monthToDateCents:beforeReservation.spend.monthToDateCents-1}});
   expect(reservedCalls).toBe(0);
  }finally{releaseReserved();await reservedRunning;}
  const beforeDispatchChange=await post('/ask/answers/request',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,question:'repairs',scope:{sources:[source]}});
  const beforeDispatchId=(beforeDispatchChange.body as {result:{requestId:string}}).result.requestId;
  let beforeDispatchProofs=0,beforeDispatchCalls=0;
  const beforeDispatchSpend=(await post('/research/firm',{firmId:spendFirm})).body as {spend:{monthToDateCents:number}};
  const beforeDispatchRegistry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmAskAnswers:{allowControlledEvaluation:true,verifyPurpose:async(proof:AskPurposeProofInput)=>{if(++beforeDispatchProofs===2)await fixture.db.query("UPDATE crm_ask_purposes SET revision=3 WHERE workspace_id=$1 AND purpose='answer'",[fixture.alpha.workspaceId]);return {configFingerprint:proof.configFingerprint,authorizationFingerprint:proof.authorizationFingerprint,validUntil:'2099-01-01T00:00:00Z',evaluationKind:'controlled_fixture' as const};},answer:{endpointId:'controlled-answer',modelVersion:'literal-v1',providerKey:'fixture.ask.answer',run:async()=>{beforeDispatchCalls++;return {acceptance:'unknown' as const,usage:null,answer:null};}}}});
  await runOnce(fixture.db,{registry:beforeDispatchRegistry,owner:'ask-purpose-before-dispatch',limit:20});
  expect((await post('/ask/answers/read',{requestId:beforeDispatchId})).body).toMatchObject({state:'unavailable',reason:'processing_authority_unavailable',answer:null});
  expect((await post('/research/firm',{firmId:spendFirm})).body).toMatchObject({spend:{monthToDateCents:beforeDispatchSpend.spend.monthToDateCents}});
  expect(beforeDispatchCalls).toBe(0);



 }finally{await fixture.stop();}
});

it('admits an uncached retained meeting original without inventing historical extraction authority',async()=>{
 const fixture=await createAuthFixture();
 try{
  const token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.salesperson)).accessToken;
  const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false});
  const firmId=await seedFirm(fixture,{name:'Uncached retained meeting',assignedUserId:fixture.alpha.salesperson.userId});
  const meetingId=randomUUID(),recordingId=randomUUID(),sourceId=randomUUID();
  await fixture.db.query("INSERT INTO meetings(workspace_id,id,firm_id,booking_uid,current_booking_uid,state,starts_at,ends_at,last_event_at) VALUES($1,$2,$3,'ask-uncached','ask-uncached','booked','2026-10-01T14:00:00Z','2026-10-01T14:20:00Z',now())",[fixture.alpha.workspaceId,meetingId,firmId]);
  await fixture.db.query("INSERT INTO meeting_recordings(workspace_id,id,meeting_id,segment,participant_label,sha256,size_bytes,s3_key,processing_status) VALUES($1,$2,$3,1,'Selected transcript',$4,100,$5,'ready')",[fixture.alpha.workspaceId,recordingId,meetingId,'a'.repeat(64),`meetings/${meetingId}/${'a'.repeat(64)}.m4a`]);
  const utterances=[{startMs:0,endMs:5000,text:'We need help coordinating repairs.',speaker:'Correspondent',attribution:'source_label'}];
  await fixture.db.query("INSERT INTO meeting_transcripts(workspace_id,id,recording_id,original_recording_id,version,duration_ms,language,utterances) VALUES($1,$2,$3,$3,1,5000,'en-US',$4::jsonb)",[fixture.alpha.workspaceId,sourceId,recordingId,JSON.stringify(utterances)]);
  const source={workspaceId:fixture.alpha.workspaceId,sourceId,kind:'meeting_transcript',revision:1,contentHash:createHash('sha256').update(JSON.stringify(utterances)).digest('hex'),locator:null};
  expect((await post('/ask/read',{operation:'passages',scope:{sources:[source]},query:'repairs',limit:10})).status).toBe(200);
  const requested=await post('/ask/answers/request',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,question:'repairs',scope:{sources:[source]}});
  expect(requested.status).toBe(200);
  expect(requested.body).toMatchObject({result:{state:'unavailable',version:1}});
  const requestId=(requested.body as {result:{requestId:string}}).result.requestId;
  expect((await post('/ask/answers/read',{requestId})).body).toMatchObject({state:'unavailable',reason:'purpose_unavailable',fallback:{passages:[{text:utterances[0]!.text}]}});
  // Controlled legacy unavailable receipt: it cannot become a new native authority grant.
  await fixture.db.query("INSERT INTO crm_extraction_generations(workspace_id,source_id,source_kind,source_revision,source_hash,requested_by,processor_version,state,original_firm_id) VALUES($1,$2,'meeting_transcript',1,$3,$4,'legacy-unavailable','unavailable',NULL)",[fixture.alpha.workspaceId,sourceId,source.contentHash,fixture.alpha.salesperson.userId]);
  const historical=await post('/ask/answers/request',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,question:'repairs',scope:{sources:[source]}});
  expect(historical.status).toBe(409);

 }finally{await fixture.stop();}
});

it('publishes only current server conflict receipts for fully selected originals and invalidates changed conflict status',async()=>{
 const fixture=await createAuthFixture();
 try{
  const token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.admin)).accessToken;
  const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false});
  const command=(fields:object)=>({commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,...fields});
  const firmId=await seedFirm(fixture,{name:'Conflicting retained originals',assignedUserId:fixture.alpha.admin.userId});
  const text='We need help coordinating repairs.';
  expect((await post('/crm/firm-sources/add',command({firmId,sourceKey:'ask-conflicts',excerpt:text,occurredAt:'2026-10-01T14:00:00Z'}))).status).toBe(200);
  const sourceRow=((await post('/crm/firm-sources/read',{firmId})).body as {sources:{workspaceId:string;sourceId:string;revision:number;contentHash:string}[]}).sources[0]!;
  const source={workspaceId:sourceRow.workspaceId,sourceId:sourceRow.sourceId,revision:sourceRow.revision,contentHash:sourceRow.contentHash,kind:'selected_note' as const,locator:null};
  async function process(modelVersion:string,expectedRevision:number,interpretation:string){
   expect((await post('/crm/processing/purpose/save',command({expectedRevision,enabled:false,endpointId:'review-evaluation',modelVersion,accessGrantVersion:'fixture-review-grant',dataHandlingVersion:'fixture-review-policy',dailyCeilingCents:100,monthlyCeilingCents:1000,inputTokenPriceMicros:1,outputTokenPriceMicros:1}))).status).toBe(200);
   await fixture.db.query('UPDATE crm_extraction_purposes SET enabled=true WHERE workspace_id=$1',[fixture.alpha.workspaceId]);
   expect((await post('/crm/processing/request',command({source}))).status).toBe(200);
   const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmExtraction:{ allowControlledEvaluation:true,adapter:{endpointId:'review-evaluation',modelVersion,accessGrantVersion:'fixture-review-grant',dataHandlingVersion:'fixture-review-policy',providerKey:'fixture.crm_review',fundingVerifiedUntil:'2099-01-01T00:00:00Z',run:async()=>({acceptance:'accepted',usage:{inputTokens:1,outputTokens:1},claims:[{kind:'need',status:'stated',interpretation,locator:'text:0:12',quote:'We need help'}]})}}});
   await runOnce(fixture.db,{registry,owner:`ask-conflict-${modelVersion}`,limit:20});
   const result=crmProcessingResultSchema.parse((await post('/crm/processing/read',{source})).body);
   if(!('generationId' in result)||result.claims[0]===undefined)throw new Error('Controlled conflict extraction unavailable');
   return {source,claimId:result.claims[0].claimId,claimRevision:1,claimHash:result.claims[0].claimHash,contextHash:result.contextHash,expectedDecisionRevision:0};
  }
  const first=await process('conflict-v1',0,'Needs regular repair help'),second=await process('conflict-v2',1,'Needs annual repair help');
  const conflict=await post('/crm/evidence/conflict/save',command({expectedConflictRevision:0,members:[first,second]}));
  expect(conflict.status).toBe(200);
  const conflictId=(conflict.body as {result:{conflictId:string}}).result.conflictId;
  await fixture.db.query(`INSERT INTO crm_ask_purposes(workspace_id,purpose,revision,enabled,endpoint_id,model_version,access_grant_version,data_handling_version,evaluation_fingerprint,processor_version,retrieval_version,answer_version,support_version,chunker_version,daily_ceiling_cents,monthly_ceiling_cents,input_token_price_micros,output_token_price_micros,approved_by) VALUES($1,'answer',1,true,'controlled-answer','literal-v1','ask-only-fixture-grant','fixture-no-retention',$2,'ask-answer-v1','lexical-original-v1','literal-v1','exact-original-v1','lexical-original-v1',10,100,1,1,$3)`,[fixture.alpha.workspaceId,'a'.repeat(64),fixture.alpha.admin.userId]);
  const requested=await post('/ask/answers/request',command({question:'repairs',scope:{sources:[source]}}));
  expect(requested.status).toBe(200);
  const requestId=(requested.body as {result:{requestId:string}}).result.requestId;
  const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmAskAnswers:{allowControlledEvaluation:true,verifyPurpose:async(proof:AskPurposeProofInput)=>({configFingerprint:proof.configFingerprint,authorizationFingerprint:proof.authorizationFingerprint,validUntil:'2099-01-01T00:00:00Z',evaluationKind:'controlled_fixture' as const}),answer:{endpointId:'controlled-answer',modelVersion:'literal-v1',providerKey:'fixture.ask.answer',run:async(input:{windows:readonly AskInputWindow[]})=>({acceptance:'accepted' as const,usage:{inputTokens:50,outputTokens:10},answer:{claims:[{text,kind:'extractive',citationWindowIds:[input.windows[0]!.id]}],abstained:false}})}}});
  await runOnce(fixture.db,{registry,owner:'ask-current-conflict',limit:20});
  expect((await post('/ask/answers/read',{requestId})).body).toMatchObject({state:'complete',answer:{conflicts:[{conflictId,revision:1,state:'open',resolution:null}],missingEvidence:expect.arrayContaining(['conflict_unresolved'])}});
  expect((await post('/crm/evidence/conflict/resolve',command({conflictId,expectedConflictRevision:1,resolution:'keep_both'}))).status).toBe(200);
  expect((await post('/ask/answers/read',{requestId})).body).toMatchObject({state:'stale',reason:'source_changed',question:null,fallback:null,answer:null});
 }finally{await fixture.stop();}
});

it('refuses unverified purposes and conserves timeout or excessive observed usage without publishing answers',async()=>{
 const fixture=await createAuthFixture();
 try{
  const token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.salesperson)).accessToken;
  const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false});
  const person=(await post('/crm/people/create',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,fullName:'Controlled output guard owner'})).body as {result:{personId:string}};
  const text='We need faster repairs.';
  expect((await post('/crm/people/source/add',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,personId:person.result.personId,sourceKey:'guard-source',excerpt:text,occurredAt:'2026-10-01T14:00:00Z'})).status).toBe(200);
  const original=((await post('/crm/people/read',{personId:person.result.personId})).body as {sources:{workspaceId:string;sourceId:string;revision:number;contentHash:string}[]}).sources[0]!;
  const source={workspaceId:original.workspaceId,sourceId:original.sourceId,revision:original.revision,contentHash:original.contentHash,kind:'selected_note',locator:null};
  await fixture.db.query(`INSERT INTO crm_ask_purposes(workspace_id,purpose,revision,enabled,endpoint_id,model_version,access_grant_version,data_handling_version,evaluation_fingerprint,processor_version,retrieval_version,answer_version,support_version,chunker_version,daily_ceiling_cents,monthly_ceiling_cents,input_token_price_micros,output_token_price_micros,approved_by) VALUES($1,'answer',1,true,'controlled-answer','literal-v1','ask-only-fixture-grant','fixture-no-retention',$2,'ask-answer-v1','lexical-original-v1','literal-v1','exact-original-v1','lexical-original-v1',100,1000,1,1,$3)`,[fixture.alpha.workspaceId,'a'.repeat(64),fixture.alpha.admin.userId]);
  const proof=async(input:AskPurposeProofInput)=>({configFingerprint:input.configFingerprint,authorizationFingerprint:input.authorizationFingerprint,validUntil:'2099-01-01T00:00:00Z',evaluationKind:'controlled_fixture' as const});
  let calls=0;
  const request=async()=>{const response=await post('/ask/answers/request',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,question:'repairs',scope:{sources:[source]}});expect(response.status).toBe(200);return (response.body as {result:{requestId:string}}).result.requestId;};
  const disabledId=await request();
  const unapproved=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmAskAnswers:{verifyPurpose:proof,answer:{endpointId:'controlled-answer',modelVersion:'literal-v1',providerKey:'fixture.ask.answer',run:async()=>{calls++;return {acceptance:'unknown',usage:null,answer:null};}}}});
  await runOnce(fixture.db,{registry:unapproved,owner:'ask-control-flag-off',limit:20});
  expect(calls).toBe(0);
  expect((await post('/ask/answers/read',{requestId:disabledId})).body).toMatchObject({state:'unavailable',reason:'processing_authority_unavailable',answer:null});

  for(const mismatch of ['config','authorization','expired'] as const){
   const requestId=await request();let rejectedCalls=0;
   const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmAskAnswers:{allowControlledEvaluation:true,verifyPurpose:async(input:AskPurposeProofInput)=>({configFingerprint:mismatch==='config'?'b'.repeat(64):input.configFingerprint,authorizationFingerprint:mismatch==='authorization'?'b'.repeat(64):input.authorizationFingerprint,validUntil:mismatch==='expired'?'2000-01-01T00:00:00Z':'2099-01-01T00:00:00Z',evaluationKind:'actual'}),answer:{endpointId:'controlled-answer',modelVersion:'literal-v1',providerKey:'fixture.ask.answer',run:async()=>{rejectedCalls++;return {acceptance:'unknown',usage:null,answer:null};}}}});
   await runOnce(fixture.db,{registry,owner:`ask-misbound-${mismatch}`,limit:20});
   expect(rejectedCalls).toBe(0);
   expect((await post('/ask/answers/read',{requestId})).body).toMatchObject({state:'unavailable',reason:'processing_authority_unavailable',answer:null});
  }
  const timeoutId=await request();let timeoutCalls=0;
  const timeoutRegistry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmAskAnswers:{allowControlledEvaluation:true,providerTimeoutMs:1,verifyPurpose:proof,answer:{endpointId:'controlled-answer',modelVersion:'literal-v1',providerKey:'fixture.ask.answer',run:async()=>{timeoutCalls++;return new Promise<never>(()=>{});}}}});
  await runOnce(fixture.db,{registry:timeoutRegistry,owner:'ask-timeout',limit:20});
  expect((await post('/ask/answers/read',{requestId:timeoutId})).body).toMatchObject({state:'unknown_acceptance',reason:'provider_acceptance_unknown',answer:null});
  await runOnce(fixture.db,{registry:timeoutRegistry,owner:'ask-timeout-again',limit:20});expect(timeoutCalls).toBe(1);
  const overshootId=await request();
  const overshootRegistry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmAskAnswers:{allowControlledEvaluation:true,verifyPurpose:proof,answer:{endpointId:'controlled-answer',modelVersion:'literal-v1',providerKey:'fixture.ask.answer',run:async(input:{windows:readonly AskInputWindow[]})=>({acceptance:'accepted',usage:{inputTokens:100000,outputTokens:10},answer:{claims:[{text,kind:'extractive',citationWindowIds:[input.windows[0]!.id]}],abstained:false}})}}});
  await runOnce(fixture.db,{registry:overshootRegistry,owner:'ask-usage-overshoot',limit:20});
  expect((await post('/ask/answers/read',{requestId:overshootId})).body).toMatchObject({state:'unavailable',reason:'processing_failed',answer:null});
  const firmId=await seedFirm(fixture,{name:'Controlled truthful usage',assignedUserId:fixture.alpha.salesperson.userId});
  // One conserved timeout (1), truthful observed overshoot (11).
  expect((await post('/research/firm',{firmId})).body).toMatchObject({spend:{monthToDateCents:12}});
 }finally{await fixture.stop();}
});

it('admits an uncached retained call original with honest partial source coverage',async()=>{
 const fixture=await createAuthFixture();
 try{
  const token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.salesperson)).accessToken;
  const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false});
    const ws = fixture.alpha.workspaceId,
      user = fixture.alpha.salesperson.userId;
    const firmId = await seedFirm(fixture, {
      name: "Native call source",
      regionCode: "RI",
      assignedUserId: user,
    });
    const callId = randomUUID();
    const route = (
      await fixture.db.query<{ id: string }>(
        "INSERT INTO phone_routes(workspace_id,firm_id,e164,source,retrieved_at,association_confidence,technical_validation,eligibility,eligibility_policy_version) VALUES($1,$2,'+14015550123','research_provider',now(),0.9,'passed','usable','route.1') RETURNING id",
        [ws, firmId],
      )
    ).rows[0]!.id;
    const identity = (
      await fixture.db.query<{ id: string }>(
        "INSERT INTO calling_identities(workspace_id,owner_user_id,e164,verification_status,enabled,verified_at,verified_by_user_id,verification_method) VALUES($1,$2,'+14015550124','verified',false,now(),$2,'owner_attestation') RETURNING id",
        [ws, user],
      )
    ).rows[0]!.id;
    const posture = (
      await fixture.db.query<{ id: string }>(
        "INSERT INTO state_postures(workspace_id,state,revision,effective_from,review_at,rules_revision,confirmed_statements,confirmed_by_user_id) VALUES($1,'RI',1,'2026-01-01','2027-01-01',2,ARRAY['businessToBusiness'],$2) RETURNING id",
        [ws, fixture.alpha.admin.userId],
      )
    ).rows[0]!.id;
    const device = (
      await fixture.db.query<{ id: string }>(
        "SELECT id FROM devices WHERE workspace_id=$1 AND user_id=$2 LIMIT 1",
        [ws, user],
      )
    ).rows[0]!.id;
    const ticket = (
      await fixture.db.query<{ id: string }>(
        "INSERT INTO dial_tickets(workspace_id,command_id,firm_id,phone_route_id,route_version,posture_id,posture_revision,calling_identity_id,actor_user_id,device_id,assigned_user_id,e164,firm_time_zone,expires_at) VALUES($1,'crm-call-fixture',$2,$3,1,$4,1,$5,$6,$7,$6,'+14015550123','America/New_York',now()+interval '30 seconds') RETURNING id",
        [ws, firmId, route, posture, identity, user, device],
      )
    ).rows[0]!.id;
    const reservation = (
      await fixture.db.query<{ id: string }>(
        "INSERT INTO provider_reservations(workspace_id,provider_key,subject_kind,subject_id,attempt,business_date,business_time_zone,cents,model_name,max_input_tokens,max_output_tokens,priced_unit,max_units,unit_price_micros,state,settled_at) VALUES($1,'twilio.voice','call_session',$2,1,current_date,'America/New_York',0,NULL,NULL,NULL,'minute',1,0,'released',now()) RETURNING id",
        [ws, callId],
      )
    ).rows[0]!.id;
    await fixture.db.query(
      "INSERT INTO call_sessions(workspace_id,id,ticket_id,firm_id,actor_user_id,reservation_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '30 seconds')",
      [ws, callId, ticket, firmId, user, reservation],
    );
    const utterances = [
      {
        speaker: 1,
        start: 0,
        end: 5,
        text: "Drainage coordination is needed.",
      },
    ];
    await fixture.db.query(
      "INSERT INTO call_transcripts(workspace_id,call_session_id,provider,model,language,duration_seconds,utterances) VALUES($1,$2,'aws_transcribe','standard','en-US',5,$3::jsonb)",
      [ws, callId, JSON.stringify(utterances)],
    );
    const source = {
      workspaceId: ws,
      sourceId: callId,
      kind: "call_transcript",
      revision: 1,
      contentHash: createHash("sha256")
        .update(JSON.stringify(utterances))
        .digest("hex"),
      locator: null,
    };


  const requested=await post('/ask/answers/request',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,question:'drainage',scope:{sources:[source]}});
  expect(requested.status).toBe(200);
  expect(requested.body).toMatchObject({result:{state:'unavailable'}});
  const requestId=(requested.body as {result:{requestId:string}}).result.requestId;
  expect((await post('/ask/answers/read',{requestId})).body).toMatchObject({state:'unavailable',reason:'purpose_unavailable',fallback:{passages:[{text:'Drainage coordination is needed.',sources:[{kind:'call_transcript',sourceId:callId,completeness:'partial',speaker:'channel:1'}]}]}});
 }finally{await fixture.stop();}
});
