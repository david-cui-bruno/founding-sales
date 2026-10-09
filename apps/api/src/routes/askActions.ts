import {askActionChangeSchema,askActionCreateSchema,askActionReadSchema} from '@fss/contracts';
import {changeAskAction,createAskAction,readAskActions} from '@fss/domain/crm/askActions.ts';
import {requirePrincipal,contextForPrincipal,runRouteCommand} from './routeSupport.ts';
import {redactError} from '../limits.ts';
import type {ApiRequest,RoutingOptions,RouteResult} from './types.ts';
export const ASK_ACTION_PATHS=['/ask/actions/create','/ask/actions/read','/ask/actions/change'] as const;
export async function routeAskActions(request:ApiRequest,options:RoutingOptions):Promise<RouteResult|null>{
 if(!(ASK_ACTION_PATHS as readonly string[]).includes(request.path))return null;
 if(options.auth===undefined)return {status:401,body:redactError('unauthenticated')};
 const verified=await requirePrincipal(options.auth,request);if(!verified.ok)return verified.result;
 if(request.method!=='POST')return {status:405,body:redactError('method_not_allowed')};
 if(request.path==='/ask/actions/create')return runRouteCommand({auth:options.auth,request,principal:verified.principal},askActionCreateSchema,'crm.ask_manual_action_created',createAskAction);
 if(request.path==='/ask/actions/change')return runRouteCommand({auth:options.auth,request,principal:verified.principal},askActionChangeSchema,'crm.ask_manual_action_changed',changeAskAction);
 const scoped=contextForPrincipal(options.auth,verified.principal);if(!scoped.ok)return scoped.result;
 const parsed=askActionReadSchema.safeParse(request.body);if(!parsed.success)return {status:400,body:redactError('malformed_body')};
 const result=await readAskActions(scoped.context,parsed.data);
 return result===null?{status:404,body:redactError('not_found')}:{status:200,body:result};
}
