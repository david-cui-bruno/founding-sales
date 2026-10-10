import {z} from 'zod';
import {pilotAnswerRequest} from './pilotAnswerRequest.ts';
import type {AskAnswerAdapter} from '@fss/domain/crm/askAnswerPorts.ts';
import type {PilotPorts} from './realPilot.ts';
const candidate=z.strictObject({claims:z.array(z.strictObject({text:z.string().min(1).max(1000),kind:z.literal('extractive'),citationWindowIds:z.array(z.string().min(1).max(80)).min(1).max(12)})).max(20),abstained:z.boolean()}).refine(row=>!row.abstained||row.claims.length===0);
/** Existing bounded Bedrock answer seam, without product publication or purpose mutation. */
export function createPilotAnswerTransport(adapter:AskAnswerAdapter,kind:'controlled'|'real'):PilotPorts['answer'] {return {kind,modelId:adapter.modelVersion,async run(question,windows,maxOutputTokens,signal){const outcome=await adapter.run({...pilotAnswerRequest(question,windows),maxOutputTokens,signal});const parsed=candidate.safeParse(outcome.answer);return {acceptance:outcome.acceptance,usage:outcome.usage,claims:parsed.success?parsed.data.claims.map(claim=>({text:claim.text,windowIds:claim.citationWindowIds})):null,abstained:parsed.success?parsed.data.abstained:null};}};}
