import {z} from 'zod';
import {CRM_SUPPORTED_ASK_VERSIONS,type CrmCapabilityRuntime} from './capabilityAuthority.ts';
const route=z.strictObject({region:z.literal('us-east-1'),endpointId:z.literal('bedrock-runtime.us-east-1.amazonaws.com'),modelVersion:z.literal('us.anthropic.claude-haiku-4-5-20251001-v1:0'),providerKey:z.string().min(1).max(100),accessGrantVersion:z.string().min(1).max(200),dataHandlingVersion:z.string().min(1).max(200),fundingVerifiedUntil:z.iso.datetime()});
const configuration=z.strictObject({capture:z.boolean().default(false),extraction:route.optional(),answer:route.optional()});
export type CrmCapabilityStartupConfiguration=z.infer<typeof configuration>;
/** Deployment chooses adapter presence only. This input cannot create consent, grants or enabled controls. */
export function readCrmCapabilityStartup(environment:Record<string,string|undefined>):CrmCapabilityStartupConfiguration{
 const raw=environment['FSS_CRM_CAPABILITY_ADAPTERS'];if(!raw?.trim())return {capture:false};
 try{return configuration.parse(JSON.parse(raw));}catch{throw new Error('crm_capability_adapter_configuration_invalid');}
}
export function createCrmCapabilityRuntime(config:CrmCapabilityStartupConfiguration,input:Omit<CrmCapabilityRuntime,'adapterAvailable'> & {gmailAvailable:boolean}):CrmCapabilityRuntime{
 return {implementationCommit:input.implementationCommit,imageDigest:input.imageDigest,side:input.side,schemaVersion:input.schemaVersion,adapterAvailable:c=>{
  if(c.capability==='metadata_review'||c.capability==='mail_capture'||c.capability==='mail_backfill')return config.capture&&input.gmailAvailable;
  const selected=c.capability==='crm_extraction'?config.extraction:config.answer;if(!selected||c.endpointId!==selected.endpointId||c.modelVersion!==selected.modelVersion||c.accessGrantVersion!==selected.accessGrantVersion||c.dataHandlingVersion!==selected.dataHandlingVersion)return false;
  if(c.capability==='crm_extraction')return c.processorVersion==='crm-extract-v1';
  return Object.entries(CRM_SUPPORTED_ASK_VERSIONS).every(([key,value])=>c[key as keyof typeof CRM_SUPPORTED_ASK_VERSIONS]===value);
 }};
}
