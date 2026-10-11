import {cancelAskAnswer,previewAskInvestigation,commitAskInvestigation} from '@fss/domain/crm/askInvestigationControls.ts';
import {askAnswerRequestSchema,askAnswerReadSchema,askAnswerSourceReadSchema,askAnswerCancelSchema,askAnswerInvestigationPreviewSchema,askAnswerInvestigationCommitSchema} from '@fss/contracts';
import {requestAskAnswer,readAskAnswer,readAskAnswerSource} from '@fss/domain/crm/askAnswers.ts';
import {requirePrincipal,runRouteCommand,contextForPrincipal} from './routeSupport.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {redactError} from '../limits.ts';
import type {ApiRequest,RoutingOptions,RouteResult} from './types.ts';

export const ASK_ANSWER_PATHS=['/ask/answers/request','/ask/answers/read','/ask/answers/source/read','/ask/answers/cancel','/ask/answers/investigation/preview','/ask/answers/investigation/commit'] as const;
export async function routeAskAnswers(request:ApiRequest,options:RoutingOptions):Promise<RouteResult|null>{
 if(!(ASK_ANSWER_PATHS as readonly string[]).includes(request.path))return null;
 if(options.auth===undefined)return {status:401,body:redactError('unauthenticated')};
 const verified=await requirePrincipal(options.auth,request);if(!verified.ok)return verified.result;
 if(request.method!=='POST')return {status:405,body:redactError('method_not_allowed')};
 if(request.path==='/ask/answers/cancel')return runRouteCommand({auth:options.auth,request,principal:verified.principal},askAnswerCancelSchema,'crm.ask_answer_cancelled',cancelAskAnswer);
 if(request.path==='/ask/answers/investigation/commit')return runRouteCommand({auth:options.auth,request,principal:verified.principal},askAnswerInvestigationCommitSchema,'crm.ask_investigation_committed',commitAskInvestigation);
 if(request.path==='/ask/answers/investigation/preview'){
  const scoped=contextForPrincipal(options.auth,verified.principal);if(!scoped.ok)return scoped.result;
  const parsed=askAnswerInvestigationPreviewSchema.safeParse(request.body);if(!parsed.success)return {status:400,body:redactError('malformed_body')};
  return {status:200,body:await withTransaction(options.auth.db,()=>previewAskInvestigation(scoped.context,parsed.data))};
 }
 if(request.path==='/ask/answers/source/read'){
  const scoped=contextForPrincipal(options.auth,verified.principal);if(!scoped.ok)return scoped.result;
  const parsed=askAnswerSourceReadSchema.safeParse(request.body);if(!parsed.success)return {status:400,body:redactError('malformed_body')};
  const result=await withTransaction(options.auth.db,()=>readAskAnswerSource(scoped.context,parsed.data));
  return result===null?{status:404,body:redactError('not_found')}:{status:200,body:result};
 }
 if(request.path==='/ask/answers/read'){
  const scoped=contextForPrincipal(options.auth,verified.principal);if(!scoped.ok)return scoped.result;
  const parsed=askAnswerReadSchema.safeParse(request.body);if(!parsed.success)return {status:400,body:redactError('malformed_body')};
  const result=await withTransaction(options.auth.db,()=>readAskAnswer(scoped.context,parsed.data.requestId));
  return result===null?{status:404,body:redactError('not_found')}:{status:200,body:result};
 }
 return runRouteCommand({auth:options.auth,request,principal:verified.principal},askAnswerRequestSchema,'crm.ask_answer_requested',requestAskAnswer);
}
