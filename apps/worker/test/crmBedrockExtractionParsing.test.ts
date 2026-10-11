import {expect,it} from 'vitest';
import {createBedrockCrmExtractionAdapter,type CrmBedrockRequest} from '../src/providers/crmBedrock.ts';
const claim={kind:'commitment',interpretation:'Proposal promise',status:'stated',locator:'text:0:12',quote:'send proposal'};
const request={source:{workspaceId:'00000000-0000-4000-8000-000000000001',sourceId:'00000000-0000-4000-8000-000000000002',kind:'selected_note' as const,revision:1,contentHash:'a'.repeat(64),locator:null},text:'send proposal',maxOutputTokens:1000};
const tool={toolUse:{toolUseId:'controlled-output',name:'emit_crm_extraction',input:{claims:[claim]}}};
const adapterFor=(content:unknown,stopReason='tool_use')=>createBedrockCrmExtractionAdapter({endpointId:'bedrock-runtime.us-east-1.amazonaws.com',modelVersion:'controlled',providerKey:'controlled',accessGrantVersion:'controlled',dataHandlingVersion:'controlled',fundingVerifiedUntil:'2099-01-01T00:00:00Z',surface:{converse:async()=>({stopReason,usage:{inputTokens:10,outputTokens:5},output:{message:{role:'assistant',content}}})}});
it('consumes a single strict extraction output tool as data without another provider call',async()=>{
 let sent:CrmBedrockRequest|undefined,calls=0;
 const adapter=createBedrockCrmExtractionAdapter({endpointId:'bedrock-runtime.us-east-1.amazonaws.com',modelVersion:'controlled',providerKey:'controlled',accessGrantVersion:'controlled',dataHandlingVersion:'controlled',fundingVerifiedUntil:'2099-01-01T00:00:00Z',surface:{converse:async input=>{calls++;sent=input;return {stopReason:'tool_use',usage:{inputTokens:10,outputTokens:5},output:{message:{role:'assistant',content:[tool]}}};}}});
 expect(await adapter.run(request)).toMatchObject({acceptance:'accepted',claims:[claim]});
 expect(calls).toBe(1);
 expect(sent).toMatchObject({messages:[{role:'user',content:[{text:request.text}]}],inferenceConfig:{maxTokens:1000,temperature:0},toolConfig:{toolChoice:{any:{}},tools:[{toolSpec:{name:'emit_crm_extraction',strict:true,inputSchema:{json:{type:'object',required:['claims'],additionalProperties:false}}}}]}});
 expect(sent?.toolConfig?.tools).toHaveLength(1);
 expect(adapter.inputBound?.(request)?.maxInputTokens).toBeGreaterThan(Buffer.byteLength(request.text)+2048);
});
it('refuses text, unexpected and multiple output tools while retaining known billed usage',async()=>{
 for(const content of [[{text:'```json\n[]\n``` explanation'}],[{toolUse:{...tool.toolUse,name:'other'}}],[tool,tool],[{toolUse:{...tool.toolUse,input:{claims:[],extra:true}}}],[{image:{}}]]){
  expect(await adapterFor(content).run(request)).toMatchObject({acceptance:'accepted',usage:{inputTokens:10,outputTokens:5},claims:null});
 }
 expect(await adapterFor([tool],'max_tokens').run(request)).toMatchObject({acceptance:'accepted',claims:null});
});
it('keeps current authored intent and original locator guidance without permitting action tools',async()=>{
 let sent:CrmBedrockRequest|undefined;
 const adapter=createBedrockCrmExtractionAdapter({endpointId:'bedrock-runtime.us-east-1.amazonaws.com',modelVersion:'controlled',providerKey:'controlled',accessGrantVersion:'controlled',dataHandlingVersion:'controlled',fundingVerifiedUntil:'2099-01-01T00:00:00Z',surface:{converse:async input=>{sent=input;return {stopReason:'tool_use',usage:{inputTokens:10,outputTokens:5},output:{message:{role:'assistant',content:[{toolUse:{...tool.toolUse,input:{claims:[]}}}]}}};}}});
 for(const kind of ['selected_note','call_transcript','meeting_transcript'] as const){
  expect(await adapter.run({...request,source:{...request.source,kind}})).toMatchObject({claims:[]});
  const prompt=sent?.system[0]?.text??'';
  expect(prompt).toContain('current author/speaker');
  expect(prompt).toContain('Conditional offers, invitations and questions are not commitments; never infer acceptance.');
  expect(prompt).toContain('Quoted/forwarded historical intent is not a current commitment unless explicitly reaffirmed.');
 }
});
