import {expect,it} from 'vitest';
import {createBedrockCrmExtractionAdapter} from '../src/providers/crmBedrock.ts';
const claim={kind:'commitment',interpretation:'Proposal promise',status:'stated',locator:'text:0:12',quote:'send proposal'};
it('accepts a single JSON code fence but refuses prose, duplicate JSON and malformed claim envelopes',async()=>{
 const adapterFor=(text:string)=>createBedrockCrmExtractionAdapter({endpointId:'bedrock-runtime.us-east-1.amazonaws.com',modelVersion:'controlled',providerKey:'controlled',accessGrantVersion:'controlled',dataHandlingVersion:'controlled',fundingVerifiedUntil:'2099-01-01T00:00:00Z',surface:{converse:async()=>({stopReason:'end_turn',usage:{inputTokens:10,outputTokens:5},output:{message:{role:'assistant',content:[{text}]}}})}});
 const request={source:{workspaceId:'00000000-0000-4000-8000-000000000001',sourceId:'00000000-0000-4000-8000-000000000002',kind:'selected_note' as const,revision:1,contentHash:'a'.repeat(64),locator:null},text:'send proposal',maxOutputTokens:1000};
 expect(await adapterFor('```json\n'+JSON.stringify([claim])+'\n```').run(request)).toMatchObject({acceptance:'accepted',claims:[claim]});
 for(const text of ['Here is JSON: '+JSON.stringify([claim]),'[] []','```json\n[]\n``` trailing'])expect(await adapterFor(text).run(request)).toMatchObject({acceptance:'accepted',usage:{inputTokens:10,outputTokens:5},claims:null});
});
