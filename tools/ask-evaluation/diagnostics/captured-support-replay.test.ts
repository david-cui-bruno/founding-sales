import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {z} from 'zod';
import {askAnswerReadResultSchema,selectedImportPageSchema} from '@fss/contracts';
import {MockLanguageModelV3} from '../../../apps/worker/test/support/controlledAskSdkModel.ts';
import {runOnce} from '../../../apps/worker/src/runner/jobRunner.ts';
import {createAuthFixture} from '../../../apps/api/test/support/authFixture.ts';
import {configuredAskFixture} from '../../../apps/api/test/support/configuredAskFixture.ts';
import {seedFirm} from '../../../apps/api/test/support/crmSeed.ts';

// Diagnostic intentionally expects rejection of captured semantic defects. No hosted calls.
const captureSchema=z.object({record:z.object({navigation:z.array(z.object({body:z.object({source:z.object({passage:z.object({text:z.string()})})})})),answer:z.object({answer:z.object({claims:z.array(z.object({text:z.string(),kind:z.enum(['fact','inference','conflict']),citationWindowIds:z.array(z.string()),exactResultToolCallIds:z.array(z.string())}))})})})});
const captured=captureSchema.parse(JSON.parse(readFileSync('.context/synthetic-acceptance-3c62105b-0e6e-43dc-a4f8-979a0fdbe969/history_02-answer.json','utf8')));

it('rejects the captured unsupported anonymous speaker attribution',async()=>{
 const fixture=await createAuthFixture();
 try{
  const route={region:'us-east-1' as const,endpointId:'bedrock-runtime.us-east-1.amazonaws.com' as const,modelVersion:'us.anthropic.claude-sonnet-4-6' as const,providerKey:'controlled.precision',accessGrantVersion:'controlled-access',dataHandlingVersion:'controlled-handling',fundingVerifiedUntil:'2099-01-01T00:00:00Z',agentLimits:{maxSteps:3,maxInputBytes:50000,maxOutputTokens:1000,deadlineMs:60000}};
  const {db,post,command,saveDisabledPurpose,composeWorker}=await configuredAskFixture(fixture,route);
  const firmId=await seedFirm(fixture,{name:'Harbor precision',assignedUserId:fixture.alpha.admin.userId});
  const text=captured.record.navigation[0].body.source.passage.text;
  const selection={text,subtype:'pasted_text',label:'Anonymous conditional offer',direction:'unknown',participants:[],occurredAt:null,attachments:[]};
  const preview=await post('/crm/imports/preview',selection);expect(preview.status).toBe(200);
  expect((await post('/crm/imports/commit',command({...selection,personId:null,firmId,importKey:randomUUID(),previewHash:z.object({previewHash:z.string()}).parse(preview.body).previewHash,parserVersion:'selected-v1'}))).status).toBe(200);
  const imported=selectedImportPageSchema.parse((await post('/crm/imports/read',{firmId,limit:10})).body).imports[0]!;
  const source={workspaceId:imported.source.workspaceId,sourceId:imported.source.sourceId,revision:imported.source.revision,contentHash:imported.source.contentHash,kind:'selected_note',locator:null};
  expect((await saveDisabledPurpose('d'.repeat(64))).status).toBe(200);
  expect((await post('/ask/purpose/activate',command({capability:'ask_answer',purpose:'answer',expectedRevision:1,approval:{consentAcknowledged:true,qualityTier:'provisional_owner',criticalControlsPassed:true,modelIntegrationVerified:true,reviewedEvaluationReference:'controlled-precision-not-actual-quality',limitations:['representative_quality_unverified']}}))).status).toBe(200);
  let modelFailure:unknown;
  const model=new MockLanguageModelV3({doGenerate:async input=>{
   try{
    const user=input.prompt.find(message=>message.role==='user');
    const context=z.object({context:z.array(z.object({windows:z.array(z.object({id:z.string(),text:z.string(),source:z.object({speaker:z.null()}),interpretationLimits:z.object({speakerIdentity:z.string()})}))}).passthrough())}).parse(user?.role==='user'?JSON.parse(user.content.flatMap(part=>part.type==='text'?[part.text]:[]).join('')):null);
    const window=context.context[0]!.windows[0]!;
    expect(window.text).toBe(text);
    expect(window.interpretationLimits.speakerIdentity).toContain('A firm association does not identify the speaker');
    expect(window.interpretationLimits.speakerIdentity).toContain('the note says');
    return {content:[{type:'tool-call' as const,toolCallId:'finish',toolName:'emit_answer',input:JSON.stringify({claims:[{text:captured.record.answer.answer.claims[0].text,kind:'fact',citationWindowIds:[process.env['CAPTURED_SUPPORT_INVALID_REF']==='1'?'missing':window.id],exactResultToolCallIds:[]}],abstained:false})}],finishReason:{unified:'tool-calls' as const,raw:'tool_use'},usage:{inputTokens:{total:50,noCache:50,cacheRead:0,cacheWrite:0},outputTokens:{total:20,text:20,reasoning:0}},warnings:[]};
   }catch(error){modelFailure=error;throw error;}
  }});
  const registry=await composeWorker(model);
  const requested=await post('/ask/answers/request',command({question:'What help was offered?',execution:'agent_v1',agentScope:{kind:'selected',sources:[source]},scope:{sources:[source]}}));expect(requested.status).toBe(200);
  const requestId=z.object({result:z.object({requestId:z.uuid()})}).parse(requested.body).result.requestId;
  await runOnce(db,{registry,owner:'controlled-anonymous-precision',limit:20});
  expect(modelFailure).toBeUndefined();
  const answer=askAnswerReadResultSchema.parse((await post('/ask/answers/read',{requestId,includeExactResultCitations:true})).body);
  expect(answer.state, 'Captured anonymous I became the team and must not publish as supported').toBe('unavailable');
 }finally{await fixture.stop();}
});
it('rejects the captured mixed inference with missing SQL references',async()=>{
 const fixture=await createAuthFixture();try{
  const route={region:'us-east-1' as const,endpointId:'bedrock-runtime.us-east-1.amazonaws.com' as const,modelVersion:'us.anthropic.claude-sonnet-4-6' as const,providerKey:'controlled.ask_sdk',accessGrantVersion:'controlled-access',dataHandlingVersion:'controlled-handling',fundingVerifiedUntil:'2099-01-01T00:00:00Z',agentLimits:{maxSteps:2,maxInputBytes:30000,maxOutputTokens:1000,deadlineMs:60000}};
  const {db,post,command,saveDisabledPurpose,composeWorker}=await configuredAskFixture(fixture,route);
  const firmId=await seedFirm(fixture,{name:'Fir mixed references',assignedUserId:fixture.alpha.admin.userId});
  for(const opportunity of [{name:'East pilot',stageKey:'qualified'},{name:'West pilot',stageKey:'new'}])expect((await post('/opportunities/v2/open',command({firmId,...opportunity}))).status).toBe(200);
  const mixed=captureSchema.parse(JSON.parse(readFileSync('.context/synthetic-acceptance-3c62105b-0e6e-43dc-a4f8-979a0fdbe969/history_03-answer.json','utf8')));
  const text=mixed.record.navigation[0].body.source.passage.text;
  const selection={text,subtype:'pasted_text',label:'Synthetic anonymous pilot note',direction:'unknown',participants:[],occurredAt:null,attachments:[]};
  const preview=await post('/crm/imports/preview',selection);expect(preview.status).toBe(200);
  expect((await post('/crm/imports/commit',command({...selection,personId:null,firmId,importKey:randomUUID(),previewHash:z.object({previewHash:z.string()}).parse(preview.body).previewHash,parserVersion:'selected-v1'}))).status).toBe(200);
  const imported=selectedImportPageSchema.parse((await post('/crm/imports/read',{firmId,limit:10})).body).imports[0]!;
  const source={workspaceId:imported.source.workspaceId,sourceId:imported.source.sourceId,revision:imported.source.revision,contentHash:imported.source.contentHash,kind:'selected_note' as const,locator:null};
  expect((await saveDisabledPurpose('f'.repeat(64))).status).toBe(200);
  expect((await post('/ask/purpose/activate',command({capability:'ask_answer',purpose:'answer',expectedRevision:1,approval:{consentAcknowledged:true,qualityTier:'provisional_owner',criticalControlsPassed:true,modelIntegrationVerified:true,reviewedEvaluationReference:'controlled-claim-references-not-hosted-quality',limitations:['representative_quality_unverified']}}))).body).toMatchObject({status:'accepted'});
  let calls=0;let modelFailure:unknown;
  const model=new MockLanguageModelV3({doGenerate:async input=>{
   try{
    calls++;
    const output=input.tools?.find(tool=>tool.type==='function'&&tool.name==='emit_answer');
    if(!output||output.type!=='function')throw new Error('final_output_tool_missing');
    const schema=z.object({properties:z.object({claims:z.object({items:z.object({properties:z.object({text:z.object({description:z.string()})})})})})}).parse(output.inputSchema);
    const guidance=schema.properties.claims.items.properties.text.description;
    expect(guidance).toContain("the note leaves the initiative unnamed");
    expect(guidance).toContain('both references on their mixed claim');
    expect(guidance).toContain('neighboring claim does not support this claim');
    const final=calls===2;
    if(final){const observed=JSON.stringify(input.prompt.filter(message=>message.role==='tool'));expect(observed).toContain('East pilot');expect(observed).toContain('qualified');expect(observed).toContain('West pilot');expect(observed).toContain('new');}

    return {content:[final?{type:'tool-call' as const,toolCallId:'mixed-final',toolName:'emit_answer',input:JSON.stringify({claims:(process.env['CAPTURED_SUPPORT_MINIMAL']==='1'?mixed.record.answer.answer.claims.slice(2):mixed.record.answer.answer.claims).map(claim=>({text:claim.text,kind:claim.kind,citationWindowIds:claim.citationWindowIds.length?[process.env['CAPTURED_SUPPORT_INVALID_REF']==='1'?'missing':'w1']:[],exactResultToolCallIds:claim.exactResultToolCallIds.length?['e1']:[]})),abstained:false})}:{type:'tool-call' as const,toolCallId:'current-pilots',toolName:'read_exact',input:JSON.stringify({operation:'opportunities',firmId})}],finishReason:{unified:'tool-calls' as const,raw:'tool_use'},usage:{inputTokens:{total:50,noCache:50,cacheRead:0,cacheWrite:0},outputTokens:{total:10,text:10,reasoning:0}},warnings:[]};
   }catch(error){modelFailure=error;throw error;}
  }});
  const registry=await composeWorker(model);
  const request=await post('/ask/answers/request',command({question:'Which pilot needs the revised proposal?',execution:'agent_v1',agentScope:{kind:'selected',sources:[source]},scope:{sources:[source]}}));expect(request.status).toBe(200);
  const requestId=z.object({result:z.object({requestId:z.uuid()})}).parse(request.body).result.requestId;
  expect((await runOnce(db,{registry,owner:'configured-mixed-references',limit:20})).failed).toBe(0);
  if(modelFailure!==undefined)throw modelFailure;
  const answer=askAnswerReadResultSchema.parse((await post('/ask/answers/read',{requestId,includeExactResultCitations:true})).body);
  expect(answer.state, 'Captured mixed inference omitted its SQL references and must not publish as supported').toBe('unavailable');
 }finally{await fixture.stop();}
});
