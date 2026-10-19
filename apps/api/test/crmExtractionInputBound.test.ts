import {expect,it} from 'vitest';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {runOnce} from '../../worker/src/runner/jobRunner.ts';
import {crmExtractJobHandler,type CrmExtractionAdapter} from '../../worker/src/handlers/crmExtract.ts';
import {createBedrockCrmExtractionAdapter} from '../../worker/src/providers/crmBedrock.ts';
import {createAuthFixture} from './support/authFixture.ts';
import {activateForwardFixture} from './support/crmForwardScopeFixture.ts';

for(const mode of ['full','invalid','negative','fractional','oversized','overusage','before_mutation','after_mutation','before_run_mutation','after_run_mutation'] as const)it(`preserves extraction reservation and publication guards: ${mode}`,async()=>{
 const f=await createAuthFixture();
 try{
  const h=await activateForwardFixture(f),route=await h.extraction();
  const source=await h.original('Original '.repeat(200));
  let calls=0,checks=0;
  const native=createBedrockCrmExtractionAdapter({...route,surface:{converse:async input=>{calls++;expect(input.toolConfig?.tools).toHaveLength(1);if(mode==='after_mutation')adapter.inputBound=()=>({maxInputTokens:1});if(mode==='after_run_mutation')adapter.run=async()=>({acceptance:'accepted',usage:{inputTokens:0,outputTokens:0},claims:[]});return {stopReason:'tool_use',usage:{inputTokens:mode==='overusage'?100000:4000,outputTokens:5},output:{message:{role:'assistant',content:[{toolUse:{toolUseId:'controlled',name:'emit_crm_extraction',input:{claims:[]}}}]}}};}}});
  const adapter:CrmExtractionAdapter={...native};
  const invalid=['invalid','negative','fractional','oversized'].includes(mode);
  if(invalid)adapter.inputBound=()=>({maxInputTokens:mode==='negative'?-1:mode==='fractional'?1.5:mode==='oversized'?1000001:Number.NaN});
  const registry=new HandlerRegistry();registry.register(crmExtractJobHandler({mailEvidence:h.mailEvidence,revalidatePurpose:h.verifiers.revalidateExtraction,verifyPurpose:async input=>{checks++;if(mode==='before_mutation'&&checks===2)adapter.inputBound=()=>({maxInputTokens:1});if(mode==='before_run_mutation'&&checks===2)adapter.run=async()=>({acceptance:'accepted',usage:{inputTokens:0,outputTokens:0},claims:[]});return h.verifiers.verifyExtraction(input);},adapter}));
  expect((await h.post('/crm/processing/request',h.command({source}))).body).toMatchObject({status:'accepted'});
  await runOnce(h.db,{registry,owner:'controlled-bound',limit:20});
  const result=await h.post('/crm/processing/read',{source});
  if(mode==='full')expect(result.body).toMatchObject({state:'complete',claims:[],financial:{dispatchState:'settled'}});
  if(mode==='overusage')expect(result.body).toMatchObject({state:'failed',reason:'provider_usage_exceeded'});
  if(invalid)expect(result.body).toMatchObject({state:'unavailable',reason:'input_unavailable',financial:null});
  if(mode==='before_mutation'||mode==='before_run_mutation')expect(result.body).toMatchObject({state:'unavailable',reason:'reservation_authority_changed'});
  if(mode==='after_mutation'||mode==='after_run_mutation')expect(result.body).toMatchObject({state:'stale',reason:'source_or_authority_changed'});
  expect(calls).toBe(invalid||mode==='before_mutation'||mode==='before_run_mutation'?0:1);
 }finally{await f.stop();}
});
