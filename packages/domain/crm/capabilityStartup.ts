import {z} from 'zod';
import type {CrmCapabilityRuntime} from './capabilityAuthority.ts';
const route=z.strictObject({region:z.literal('us-east-1'),endpointId:z.literal('bedrock-runtime.us-east-1.amazonaws.com'),modelVersion:z.enum(['us.anthropic.claude-haiku-4-5-20251001-v1:0','us.anthropic.claude-haiku-5-5','us.anthropic.claude-sonnet-5-5','us.anthropic.claude-sonnet-4-6']),providerKey:z.string().min(1).max(100),accessGrantVersion:z.string().min(1).max(200),dataHandlingVersion:z.string().min(1).max(200),fundingVerifiedUntil:z.iso.datetime()});
// Old deployment JSON may still carry removed Ask keys. Accept and discard them,
// never construct adapters or treat their presence as runtime availability.
const configuration=z.strictObject({capture:z.boolean().default(false),extraction:route.optional(),answer:z.unknown().optional(),embedding:z.unknown().optional()}).transform(({capture,extraction})=>({capture,...extraction?{extraction}:{}}));
export type CrmCapabilityStartupConfiguration=z.infer<typeof configuration>;
export function readCrmCapabilityStartup(environment:Record<string,string|undefined>):CrmCapabilityStartupConfiguration{
 const raw=environment['FSS_CRM_CAPABILITY_ADAPTERS'];if(!raw?.trim())return {capture:false};
 try{return configuration.parse(JSON.parse(raw));}catch{throw new Error('crm_capability_adapter_configuration_invalid');}
}
export function createCrmCapabilityRuntime(config:CrmCapabilityStartupConfiguration,input:Omit<CrmCapabilityRuntime,'adapterAvailable'> & {gmailAvailable:boolean}):CrmCapabilityRuntime{
 return {implementationCommit:input.implementationCommit,imageDigest:input.imageDigest,side:input.side,schemaVersion:input.schemaVersion,adapterAvailable:c=>{
  if(c.capability==='metadata_review'||c.capability==='mail_capture'||c.capability==='mail_backfill')return config.capture&&input.gmailAvailable;
  if(c.capability!=='crm_extraction')return false;
  const selected=config.extraction;
  return !!selected&&Date.parse(selected.fundingVerifiedUntil)>Date.now()&&c.endpointId===selected.endpointId&&c.modelVersion===selected.modelVersion&&c.accessGrantVersion===selected.accessGrantVersion&&c.dataHandlingVersion===selected.dataHandlingVersion&&c.processorVersion==='crm-extract-v1';
 }};
}
