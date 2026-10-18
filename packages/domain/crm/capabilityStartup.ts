import {z} from 'zod';
import {CRM_EXTRACTION_ENDPOINT,CRM_EXTRACTION_MODELS} from '@fss/contracts';
import {CRM_SUPPORTED_ASK_VERSIONS,CRM_SUPPORTED_AGENT_ASK_VERSIONS,type CrmCapabilityRuntime} from './capabilityAuthority.ts';
const route=z.strictObject({region:z.literal('us-east-1'),endpointId:z.literal(CRM_EXTRACTION_ENDPOINT),modelVersion:z.enum(CRM_EXTRACTION_MODELS),providerKey:z.string().min(1).max(100),accessGrantVersion:z.string().min(1).max(200),dataHandlingVersion:z.string().min(1).max(200),fundingVerifiedUntil:z.iso.datetime()});
const embedding=route.extend({modelVersion:z.literal('amazon.titan-embed-text-v2:0'),dimensions:z.union([z.literal(256),z.literal(512),z.literal(1024)])});
const agentLimits=z.strictObject({maxSteps:z.number().int().min(1).max(32),maxInputBytes:z.number().int().min(1).max(1000000),maxOutputTokens:z.number().int().min(1).max(4096),deadlineMs:z.number().int().min(1).max(60000)});
const bedrockAnswer=route.extend({provider:z.literal('bedrock').optional(),agentLimits:agentLimits.optional()});
const vertexAnswer=z.strictObject({provider:z.literal('google_vertex'),region:z.literal('us'),projectId:z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u),endpointId:z.string().max(100),modelVersion:z.literal('gemini-3.8-flash'),providerKey:route.shape.providerKey,accessGrantVersion:route.shape.accessGrantVersion,dataHandlingVersion:route.shape.dataHandlingVersion,fundingVerifiedUntil:route.shape.fundingVerifiedUntil,agentLimits}).refine(value=>value.endpointId===`vertex.us/${value.projectId}`);
const configuration=z.strictObject({capture:z.boolean().default(false),embedding:embedding.optional(),extraction:route.optional(),answer:z.union([bedrockAnswer,vertexAnswer]).optional()});
export type CrmCapabilityStartupConfiguration=z.infer<typeof configuration>;
/** Deployment chooses adapter presence only. This input cannot create consent, grants or enabled controls. */
export function readCrmCapabilityStartup(environment:Record<string,string|undefined>):CrmCapabilityStartupConfiguration{
 const raw=environment['FSS_CRM_CAPABILITY_ADAPTERS'];if(!raw?.trim())return {capture:false};
 try{return configuration.parse(JSON.parse(raw));}catch{throw new Error('crm_capability_adapter_configuration_invalid');}
}
export function createCrmCapabilityRuntime(config:CrmCapabilityStartupConfiguration,input:Omit<CrmCapabilityRuntime,'adapterAvailable'> & {gmailAvailable:boolean}):CrmCapabilityRuntime{
 return {implementationCommit:input.implementationCommit,imageDigest:input.imageDigest,side:input.side,schemaVersion:input.schemaVersion,adapterAvailable:c=>{
  if(c.capability==='metadata_review'||c.capability==='mail_capture'||c.capability==='mail_backfill')return config.capture&&input.gmailAvailable;
  const selected=c.capability==='crm_extraction'?config.extraction:c.purpose==='embedding'?config.embedding:config.answer;if(!selected||Date.parse(selected.fundingVerifiedUntil)<=Date.now()||c.endpointId!==selected.endpointId||c.modelVersion!==selected.modelVersion||c.accessGrantVersion!==selected.accessGrantVersion||c.dataHandlingVersion!==selected.dataHandlingVersion)return false;
  if(c.capability==='crm_extraction')return c.processorVersion==='crm-extract-v1';
  if(c.purpose==='embedding'&&config.embedding?.dimensions!==c.embeddingDimensions)return false;
  if(c.purpose==='answer'&&config.answer?.agentLimits&&JSON.stringify(c.agentLimits)!==JSON.stringify(config.answer.agentLimits))return false;
  return Object.entries(c.purpose==='embedding'||config.answer?.agentLimits?CRM_SUPPORTED_AGENT_ASK_VERSIONS:CRM_SUPPORTED_ASK_VERSIONS).every(([key,value])=>c[key as keyof typeof CRM_SUPPORTED_ASK_VERSIONS]===value);
 }};
}
