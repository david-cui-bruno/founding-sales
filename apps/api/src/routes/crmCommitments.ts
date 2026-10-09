import {crmCommitmentReadSchema,crmCommitmentReviewSchema,crmCommitmentPageSchema,crmCommitmentCompleteSchema,crmCommitmentHistoryPageSchema,crmCommitmentReviewStatusSchema,crmCommitmentReviewStatusResultSchema,crmCommitmentQueuedSchema} from '@fss/contracts';
import {readCrmCommitments,reviewCrmCommitment,completeCrmCommitment,readCrmCommitmentReviewStatus,validateCrmCommitmentReviewReceipt} from '@fss/domain/crm/commitments.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {contextForPrincipal,requirePrincipal,runRouteCommand} from './routeSupport.ts';
import {redactError} from '../limits.ts';
import type {ApiRequest,RoutingOptions,RouteResult} from './types.ts';
export const CRM_COMMITMENT_PATHS=['/crm/commitments/read','/crm/commitments/review','/crm/commitments/complete','/crm/commitments/review/status'] as const;
export async function routeCrmCommitments(request:ApiRequest,options:RoutingOptions):Promise<RouteResult|null>{
 if(!(CRM_COMMITMENT_PATHS as readonly string[]).includes(request.path))return null;
 if(options.auth===undefined)return {status:401,body:redactError('unauthenticated')};
 const verified=await requirePrincipal(options.auth,request);if(!verified.ok)return verified.result;
 const scoped=contextForPrincipal(options.auth,verified.principal);if(!scoped.ok)return scoped.result;
 if(request.method!=='POST')return {status:405,body:redactError('method_not_allowed')};
 if(request.path.endsWith('/review/status')){
  const parsed=crmCommitmentReviewStatusSchema.safeParse(request.body);if(!parsed.success)return {status:400,body:redactError('malformed_body')};
  const result=await withTransaction(options.auth.db,()=>readCrmCommitmentReviewStatus(scoped.context,parsed.data,options.crmMailEvidence));
  return result===null?{status:404,body:redactError('not_found')}:{status:200,body:crmCommitmentReviewStatusResultSchema.parse(result)};
 }
 if(request.path.endsWith('/complete'))return runRouteCommand({auth:options.auth,request,principal:verified.principal},crmCommitmentCompleteSchema,'crm.internal_task_completed',(context,input)=>completeCrmCommitment(context,input,options.crmMailEvidence));
 if(request.path.endsWith('/review')){
  const parsed=crmCommitmentReviewSchema.safeParse(request.body);if(!parsed.success)return {status:400,body:redactError('malformed_body')};
  const result=await runRouteCommand({auth:options.auth,request,principal:verified.principal},crmCommitmentReviewSchema,'crm.commitment_reviewed',(context,input)=>reviewCrmCommitment(context,input,options.crmMailEvidence));
  if(result.status!==200)return result;
  const receipt=crmCommitmentQueuedSchema.parse((result.body as {result:unknown}).result);
  const current=await withTransaction(options.auth.db,()=>validateCrmCommitmentReviewReceipt(scoped.context,parsed.data,receipt,options.crmMailEvidence));
  return current==='unavailable'?{status:404,body:redactError('not_found')}:current==='changed'?{status:409,body:{status:'refused',replayed:(result.body as {replayed:boolean}).replayed,reason:'commitment_changed'}}:result;
 }

 const parsed=crmCommitmentReadSchema.safeParse(request.body);if(!parsed.success)return {status:400,body:redactError('malformed_body')};
 const result=await withTransaction(options.auth.db,()=>readCrmCommitments(scoped.context,parsed.data,options.crmMailEvidence));
 return result===null?{status:404,body:redactError('not_found')}:{status:200,body:(parsed.data.scope.kind==='history'?crmCommitmentHistoryPageSchema:crmCommitmentPageSchema).parse(result)};
}
