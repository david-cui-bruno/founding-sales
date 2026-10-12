import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {z} from 'zod';
import {selectedImportPageSchema,askAnswerReadResultSchema} from '@fss/contracts';
import {MockLanguageModelV3} from '../../worker/test/support/controlledAskSdkModel.ts';
import {runOnce} from '../../worker/src/runner/jobRunner.ts';
import {createAuthFixture} from './support/authFixture.ts';
import {configuredAskFixture} from './support/configuredAskFixture.ts';
import {seedFirm} from './support/crmSeed.ts';

async function resolveJourney(kind:'firm'|'person',target:'selected'|'outside'){
 const fixture=await createAuthFixture();try{
  const route={region:'us-east-1' as const,endpointId:'bedrock-runtime.us-east-1.amazonaws.com' as const,modelVersion:'us.anthropic.claude-haiku-4-5-20251001-v1:0' as const,providerKey:'controlled-completion',accessGrantVersion:'controlled-access',dataHandlingVersion:'controlled-handling',fundingVerifiedUntil:'2099-01-01T00:00:00Z',agentLimits:{maxSteps:3,maxInputBytes:50000,maxOutputTokens:1000,deadlineMs:60000}};
  const {db,post,command,saveDisabledPurpose,composeWorker}=await configuredAskFixture(fixture,route);
  const firmId=await seedFirm(fixture,{name:'Completion source firm',assignedUserId:fixture.alpha.admin.userId});
  const selectedPerson=(await post('/crm/people/create',command({fullName:'Selected person'}))).body as {result:{personId:string}};
  const outsidePerson=(await post('/crm/people/create',command({fullName:'Outside person'}))).body as {result:{personId:string}};
  const outsideFirm=await seedFirm(fixture,{name:'Outside firm',assignedUserId:fixture.alpha.admin.userId});
  const query=kind==='firm'?(target==='selected'?'Completion source firm':'Outside firm'):(target==='selected'?'Selected person':'Outside person');
  const text='We need faster repairs.',selection={text,subtype:'pasted_text',label:'Synthetic completion evidence',direction:'unknown',participants:[],occurredAt:null,attachments:[]};
  const preview=await post('/crm/imports/preview',selection);expect(preview.status).toBe(200);
  const previewHash=z.object({previewHash:z.string()}).parse(preview.body).previewHash;
  expect((await post('/crm/imports/commit',command({...selection,personId:kind==='person'?selectedPerson.result.personId:null,firmId:kind==='firm'?firmId:null,importKey:randomUUID(),previewHash,parserVersion:'selected-v1'}))).status).toBe(200);
  const source=selectedImportPageSchema.parse((await post('/crm/imports/read',{personId:kind==='person'?selectedPerson.result.personId:null,firmId:kind==='firm'?firmId:null,limit:10})).body).imports[0]!.source;
  expect((await saveDisabledPurpose('a'.repeat(64))).status).toBe(200);
  expect((await post('/ask/purpose/activate',command({capability:'ask_answer',purpose:'answer',expectedRevision:1,approval:{consentAcknowledged:true,qualityTier:'provisional_owner',criticalControlsPassed:true,modelIntegrationVerified:true,reviewedEvaluationReference:'controlled-completion-not-provider-proof',limitations:['representative_quality_unverified']}}))).body).toMatchObject({status:'accepted'});
  let calls=0;let resolution:unknown=null;
  const model=new MockLanguageModelV3({doGenerate:async input=>{
   calls++;if(calls===2){const tool=input.prompt.find(message=>message.role==='tool');resolution=tool;}const prompt=JSON.stringify(input.prompt),id=/\\"id\\":\\"(w[1-9]\d*)\\"/u.exec(prompt)?.[1];if(!id)throw new Error('controlled_current_window_missing');
   const answer={claims:[{text:'The retained source requests faster repairs.',kind:'fact',citationWindowIds:[id]}],abstained:false};
   return {content:[calls===1?{type:'tool-call' as const,toolCallId:'resolve-selected',toolName:'resolve_records',input:JSON.stringify({query,kind,limit:5})}:{type:'tool-call' as const,toolCallId:'completion-output',toolName:'emit_answer',input:JSON.stringify(answer)}],finishReason:{unified:'tool-calls',raw:'tool_use'},usage:{inputTokens:{total:50,noCache:50,cacheRead:0,cacheWrite:0},outputTokens:{total:10,text:10,reasoning:0}},warnings:[]};
  }});
  const registry=await composeWorker(model);
  const requested=await post('/ask/answers/request',command({question:'What repair need is stated?',execution:'agent_v1',agentScope:{kind:'selected',sources:[{workspaceId:source.workspaceId,sourceId:source.sourceId,revision:source.revision,contentHash:source.contentHash,kind:'selected_note',locator:null}]},scope:{sources:[{workspaceId:source.workspaceId,sourceId:source.sourceId,revision:source.revision,contentHash:source.contentHash,kind:'selected_note',locator:null}]}}));expect(requested.status).toBe(200);
  const requestId=z.object({result:z.object({requestId:z.uuid()})}).parse(requested.body).result.requestId;
  expect((await runOnce(db,{registry,owner:'ordinary-completion',limit:10})).failed).toBe(0);
  const read=askAnswerReadResultSchema.parse((await post('/ask/answers/read',{requestId})).body),diagnostics=(await post('/ask/answers/diagnostics',{requestId})).body;
  let citation:unknown=null;if(read.answer){citation=(await post('/ask/answers/source/read',{requestId,expectedVersion:1,windowId:read.answer.claims[0]!.citationWindowIds[0]})).body;}
  return {calls,read,diagnostics,citation,resolution,selectedId:kind==='firm'?firmId:selectedPerson.result.personId,outsideId:kind==='firm'?outsideFirm:outsidePerson.result.personId};
 }finally{await fixture.stop();}
}

// Haiku v4 case5 resolved the unchanged selected firm then failed admission.
// A firm selected through a note with no person has no extra person restriction.
it.each(['firm','person'] as const)('admits the unchanged selected %s through ordinary SDK resolution and opens the original',async kind=>{
 const result=await resolveJourney(kind,'selected');
 expect(result).toMatchObject({calls:2,read:{state:'complete',answer:{claims:[{text:'The retained source requests faster repairs.'}]}},citation:{source:{passage:{text:'We need faster repairs.'}}},diagnostics:{completedSteps:2,executedToolNames:['resolve_records']}});
 expect(JSON.stringify(result.resolution)).toContain(result.selectedId);
 expect(JSON.stringify(result.resolution)).not.toContain(result.outsideId);
});
it.each(['firm','person'] as const)('keeps an outside %s hidden under the selected-source scope',async kind=>{
 const result=await resolveJourney(kind,'outside');
 expect(result).toMatchObject({calls:2,read:{state:'complete'},diagnostics:{executedToolNames:['resolve_records']}});
 expect(JSON.stringify(result.resolution)).toContain('"records":[]');
 expect(JSON.stringify(result.resolution)).not.toContain(result.outsideId);
});
