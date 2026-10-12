import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {z} from 'zod';
import {askAnswerReadResultSchema,selectedImportPageSchema} from '@fss/contracts';
import {MockLanguageModelV3} from '../../worker/test/support/controlledAskSdkModel.ts';
import {runOnce} from '../../worker/src/runner/jobRunner.ts';
import {createAuthFixture} from './support/authFixture.ts';
import {configuredAskFixture} from './support/configuredAskFixture.ts';
import {seedFirm} from './support/crmSeed.ts';

// This is SDK guidance and citation plumbing evidence. A scripted external
// model cannot prove that real answers obey semantic citation requirements.
it('gives local final-tool guidance for source/exact claim references and publishes mixed references through the configured SDK journey',async()=>{
 const fixture=await createAuthFixture();try{
  const route={region:'us-east-1' as const,endpointId:'bedrock-runtime.us-east-1.amazonaws.com' as const,modelVersion:'us.anthropic.claude-sonnet-4-6' as const,providerKey:'controlled.ask_sdk',accessGrantVersion:'controlled-access',dataHandlingVersion:'controlled-handling',fundingVerifiedUntil:'2099-01-01T00:00:00Z',agentLimits:{maxSteps:2,maxInputBytes:30000,maxOutputTokens:1000,deadlineMs:60000}};
  const {db,post,command,saveDisabledPurpose,composeWorker}=await configuredAskFixture(fixture,route);
  const firmId=await seedFirm(fixture,{name:'Fir mixed references',assignedUserId:fixture.alpha.admin.userId});
  for(const opportunity of [{name:'East pilot',stageKey:'qualified'},{name:'West pilot',stageKey:'new'}])expect((await post('/opportunities/v2/open',command({firmId,...opportunity}))).status).toBe(200);
  const text='The pilot needs a revised proposal including installation cost.';
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
    return {content:[final?{type:'tool-call' as const,toolCallId:'mixed-final',toolName:'emit_answer',input:JSON.stringify({claims:[{text:'The note requests a revised proposal but does not identify the pilot.',kind:'fact',citationWindowIds:['w1'],exactResultToolCallIds:[]},{text:'CRM records list East pilot at qualified and West pilot at new, but those stages do not resolve the note’s anonymous request.',kind:'inference',citationWindowIds:['w1'],exactResultToolCallIds:['e1']}],abstained:false})}:{type:'tool-call' as const,toolCallId:'current-pilots',toolName:'read_exact',input:JSON.stringify({operation:'opportunities',firmId})}],finishReason:{unified:'tool-calls' as const,raw:'tool_use'},usage:{inputTokens:{total:50,noCache:50,cacheRead:0,cacheWrite:0},outputTokens:{total:10,text:10,reasoning:0}},warnings:[]};
   }catch(error){modelFailure=error;throw error;}
  }});
  const registry=await composeWorker(model);
  const request=await post('/ask/answers/request',command({question:'Which pilot needs the revised proposal?',execution:'agent_v1',agentScope:{kind:'selected',sources:[source]},scope:{sources:[source]}}));expect(request.status).toBe(200);
  const requestId=z.object({result:z.object({requestId:z.uuid()})}).parse(request.body).result.requestId;
  expect((await runOnce(db,{registry,owner:'configured-mixed-references',limit:20})).failed).toBe(0);
  if(modelFailure!==undefined)throw modelFailure;
  const answer=askAnswerReadResultSchema.parse((await post('/ask/answers/read',{requestId,includeExactResultCitations:true})).body);
  expect(answer).toMatchObject({state:'complete',answer:{claims:[{kind:'fact',exactResultToolCallIds:[]},{kind:'inference',exactResultToolCallIds:['current-pilots']}],exactResults:[{toolCallId:'current-pilots',operation:'opportunities'}]}});
  expect(answer.answer!.exactResults![0]!.value).toMatchObject({scope:{firmId},records:expect.arrayContaining([expect.objectContaining({name:'East pilot',stageKey:'qualified'}),expect.objectContaining({name:'West pilot',stageKey:'new'})])});
  const citations=answer.answer!.claims.map(claim=>claim.citationWindowIds[0]!);
  expect(citations[0]).toMatch(/^[a-f0-9-]{36}$/u);expect(citations[1]).toBe(citations[0]);
  expect((await post('/ask/answers/source/read',{requestId,expectedVersion:answer.version,windowId:citations[0]})).body).toMatchObject({source:{passage:{text}}});
  expect((await post('/ask/answers/diagnostics',{requestId})).body).toMatchObject({state:'complete',completedSteps:2,requestedToolNames:['read_exact'],executedToolNames:['read_exact']});
  expect((await post('/crm/imports/delete',command({sourceId:source.sourceId,expectedSourceRevision:source.revision,expectedMetadataRevision:imported.metadata.revision}))).status).toBe(200);
  expect((await post('/ask/answers/read',{requestId,includeExactResultCitations:true})).body).toMatchObject({state:'deleted',question:null,answer:null,fallback:null});
  expect((await post('/ask/answers/source/read',{requestId,expectedVersion:answer.version,windowId:citations[0]})).status).toBe(404);
 }finally{await fixture.stop();}
});
