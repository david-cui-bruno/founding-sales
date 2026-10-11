import {createHash} from 'node:crypto';
import {generateText} from 'ai';
import {createBedrockCrmExtractionAdapter,type CrmBedrockSurface} from '../../src/providers/crmBedrock.ts';
export const MINIMAL_ASK_DIAGNOSTIC_QUESTION='Transport diagnostic only. No CRM sources or business state are supplied. Return JSON {"claims":[],"abstained":true}. Do not request tools.';
/** Native transport diagnosis only: no CRM activation, retrieval, host tools or
 * quality acceptance. The actual caller wraps BOTH transports in the shared cap. */
export async function runMinimalModelDiagnostic(input:{modelVersion:string;model:Parameters<typeof generateText>[0]['model'];surface:CrmBedrockSurface;sourceText:string}){
 let ask:{text:string;usage:{inputTokens:number;outputTokens:number};finishReason:string}|null=null;
 try{
  const result=await generateText({model:input.model,maxRetries:0,maxOutputTokens:64,prompt:MINIMAL_ASK_DIAGNOSTIC_QUESTION,system:'Return the requested JSON diagnostic only. No tools or business inference.',abortSignal:AbortSignal.timeout(30000)});
  if(result.usage.inputTokens===undefined||result.usage.outputTokens===undefined)return {phase:'stopped_unknown_ask',ask:null,extraction:null,businessQualityAccepted:false};
  ask={text:result.text,usage:{inputTokens:result.usage.inputTokens,outputTokens:result.usage.outputTokens},finishReason:result.finishReason};
 }catch{return {phase:'stopped_unknown_ask',ask:null,extraction:null,businessQualityAccepted:false};}
 // These route labels describe only this native synthetic transport. They are
 // never submitted as owner approval, activation evidence or funding proof.
 const adapter=createBedrockCrmExtractionAdapter({
  endpointId:'bedrock-runtime.us-east-1.amazonaws.com',
  modelVersion:input.modelVersion,
  providerKey:'synthetic',
  accessGrantVersion:'synthetic',
  dataHandlingVersion:'synthetic-only',
  fundingVerifiedUntil:new Date(Date.now()+60000).toISOString(),
  surface:input.surface,
 });
 const extraction=await adapter.run({source:{workspaceId:'00000000-0000-4000-8000-000000000001',sourceId:'00000000-0000-4000-8000-000000000002',kind:'selected_note',revision:1,contentHash:createHash('sha256').update(input.sourceText).digest('hex'),locator:null},text:input.sourceText,maxOutputTokens:1024,signal:AbortSignal.timeout(30000)});
 return {phase:extraction.acceptance==='unknown'?'stopped_unknown_extraction':'completed_native_transport_observations',ask,extraction,businessQualityAccepted:false};
}
