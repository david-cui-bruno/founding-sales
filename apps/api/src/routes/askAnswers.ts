import {askAnswerRequestSchema} from '@fss/contracts';
import {requestAskAnswer} from '@fss/domain/crm/askAnswers.ts';
import {requirePrincipal,runRouteCommand} from './routeSupport.ts';
import {redactError} from '../limits.ts';
import type {ApiRequest,RoutingOptions,RouteResult} from './types.ts';

export const ASK_ANSWER_PATHS=['/ask/answers/request'] as const;
export async function routeAskAnswers(request:ApiRequest,options:RoutingOptions):Promise<RouteResult|null>{
 if(request.path!=='/ask/answers/request')return null;
 if(options.auth===undefined)return {status:401,body:redactError('unauthenticated')};
 const verified=await requirePrincipal(options.auth,request);if(!verified.ok)return verified.result;
 if(request.method!=='POST')return {status:405,body:redactError('method_not_allowed')};
 return runRouteCommand({auth:options.auth,request,principal:verified.principal},askAnswerRequestSchema,'crm.ask_answer_requested',requestAskAnswer);
}
