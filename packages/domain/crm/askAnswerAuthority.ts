import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import type {AskPurposeSnapshot,AskPurposeProof,AskPurposeProofInput,AskAnswerComposition} from './askAnswerPorts.ts';

export function askFingerprint(value:unknown){return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
export async function readAskPurpose(context:RepositoryContext,purpose:'answer'|'embedding'|'support'):Promise<AskPurposeSnapshot|null>{
 const row=(await context.db.query<Record<string,unknown>>('SELECT * FROM crm_ask_purposes WHERE workspace_id=$1 AND purpose=$2 AND enabled FOR SHARE',[context.scope.workspaceId,purpose])).rows[0];
 if(row===undefined)return null;
 const snapshot:AskPurposeSnapshot={purpose,revision:Number(row['revision']),endpointId:String(row['endpoint_id']),modelVersion:String(row['model_version']),accessGrantVersion:String(row['access_grant_version']),dataHandlingVersion:String(row['data_handling_version']),evaluationFingerprint:String(row['evaluation_fingerprint']),processorVersion:String(row['processor_version']),retrievalVersion:String(row['retrieval_version']),answerVersion:String(row['answer_version']),supportVersion:String(row['support_version']),chunkerVersion:String(row['chunker_version']),inputTokenPriceMicros:Number(row['input_token_price_micros']),outputTokenPriceMicros:Number(row['output_token_price_micros']),dailyCeilingCents:Number(row['daily_ceiling_cents']),monthlyCeilingCents:Number(row['monthly_ceiling_cents'])};
 return snapshot;
}
const proofSchema=z.strictObject({configFingerprint:z.string().regex(/^[a-f0-9]{64}$/u),authorizationFingerprint:z.string().regex(/^[a-f0-9]{64}$/u),validUntil:z.iso.datetime(),evaluationKind:z.enum(['actual','controlled_fixture'])});
/** No text is transferred by this body-free external verification stage. */
export async function verifyAskPurpose(composition:AskAnswerComposition,input:AskPurposeProofInput):Promise<AskPurposeProof|null>{
 if(composition.verifyPurpose===undefined)return null;
 const expected=structuredClone(input);
 try{
  const parsed=proofSchema.safeParse(await composition.verifyPurpose(structuredClone(expected)));
  if(!parsed.success||parsed.data.configFingerprint!==expected.configFingerprint||parsed.data.authorizationFingerprint!==expected.authorizationFingerprint||parsed.data.evaluationKind==='controlled_fixture'&&composition.allowControlledEvaluation!==true)return null;
  return structuredClone(parsed.data);
 }catch{return null;}
}
