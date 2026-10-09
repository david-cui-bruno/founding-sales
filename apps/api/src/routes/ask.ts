import {askReadSchema,askResponseSchema} from '@fss/contracts';
import {readAsk} from '@fss/domain/crm/ask.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {requirePrincipal,contextForPrincipal} from './routeSupport.ts';
import {redactError} from '../limits.ts';
import type {ApiRequest,RoutingOptions,RouteResult} from './types.ts';
export const ASK_PATHS=['/ask/read'] as const;
export async function routeAsk(request:ApiRequest,options:RoutingOptions):Promise<RouteResult|null>{
 if(request.path!=='/ask/read')return null;
 if(options.auth===undefined)return {status:401,body:redactError('unauthenticated')};
 const verified=await requirePrincipal(options.auth,request);if(!verified.ok)return verified.result;
 const scoped=contextForPrincipal(options.auth,verified.principal);if(!scoped.ok)return scoped.result;
 if(request.method!=='POST')return {status:405,body:redactError('method_not_allowed')};
 const parsed=askReadSchema.safeParse(request.body);if(!parsed.success)return {status:400,body:redactError('malformed_body')};
 const result=await withTransaction(options.auth.db,()=>readAsk(scoped.context,parsed.data));
 return result===null?{status:404,body:redactError('not_found')}:{status:200,body:askResponseSchema.parse(result)};
}
