import {askHistoryListSchema,askHistoryChangeSchema} from '@fss/contracts';
import {listAskHistory,changeAskHistory} from '@fss/domain/crm/askHistory.ts';
import {requirePrincipal,contextForPrincipal,runRouteCommand} from './routeSupport.ts';
import {redactError} from '../limits.ts';
import type {ApiRequest,RoutingOptions,RouteResult} from './types.ts';
export const ASK_HISTORY_PATHS=['/ask/history/list','/ask/history/change'] as const;
export async function routeAskHistory(request:ApiRequest,options:RoutingOptions):Promise<RouteResult|null>{
 if(!(ASK_HISTORY_PATHS as readonly string[]).includes(request.path))return null;
 if(options.auth===undefined)return {status:401,body:redactError('unauthenticated')};
 const verified=await requirePrincipal(options.auth,request);if(!verified.ok)return verified.result;
 if(request.method!=='POST')return {status:405,body:redactError('method_not_allowed')};
 if(request.path==='/ask/history/change')return runRouteCommand({auth:options.auth,request,principal:verified.principal},askHistoryChangeSchema,'crm.ask_history_changed',changeAskHistory);
 const scoped=contextForPrincipal(options.auth,verified.principal);if(!scoped.ok)return scoped.result;
 const parsed=askHistoryListSchema.safeParse(request.body);if(!parsed.success)return {status:400,body:redactError('malformed_body')};
 const result=await listAskHistory(scoped.context,parsed.data);
 return result===null?{status:404,body:redactError('not_found')}:{status:200,body:result};
}
