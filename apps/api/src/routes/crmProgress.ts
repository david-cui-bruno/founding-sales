import {crmProgressReadSchema} from '@fss/contracts';
import {readCrmProgress} from '@fss/domain/crm/progress.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {contextForPrincipal,requirePrincipal} from './routeSupport.ts';
import {redactError} from '../limits.ts';
import type {ApiRequest,RoutingOptions,RouteResult} from './types.ts';
export const CRM_PROGRESS_PATHS=['/crm/progress/read'] as const;
export async function routeCrmProgress(request:ApiRequest,options:RoutingOptions):Promise<RouteResult|null>{
 if(request.path!=='/crm/progress/read')return null;
 if(options.auth===undefined)return {status:401,body:redactError('unauthenticated')};
 const verified=await requirePrincipal(options.auth,request);if(!verified.ok)return verified.result;
 const scoped=contextForPrincipal(options.auth,verified.principal);if(!scoped.ok)return scoped.result;
 if(request.method!=='POST')return {status:405,body:redactError('method_not_allowed')};
 const parsed=crmProgressReadSchema.safeParse(request.body);if(!parsed.success)return {status:400,body:redactError('malformed_body')};
 const read=await withTransaction(options.auth.db,()=>readCrmProgress(scoped.context,parsed.data));
 return read===null?{status:404,body:redactError('not_found')}:{status:200,body:read};
}
