import {z} from 'zod';
import {askAgentScopeSchema} from '@fss/contracts';
import {requestAskIndex,readAskIndex} from '@fss/domain/crm/askCanonicalIndex.ts';
import {requirePrincipal,runRouteCommand,contextForPrincipal} from './routeSupport.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {redactError} from '../limits.ts';
import type {ApiRequest,RoutingOptions,RouteResult} from './types.ts';
export const ASK_INDEX_PATHS=['/ask/index/request','/ask/index/read'] as const;
const requestSchema=z.strictObject({scope:askAgentScopeSchema,expectedPurposeRevision:z.number().int().positive(),after:z.strictObject({kind:z.enum(['selected_note','mail','call_transcript','meeting_transcript']),sourceId:z.uuid()}).optional(),commandId:z.uuid(),clientVersion:z.string().min(1).max(100)});
const readSchema=z.strictObject({workId:z.uuid()});
export async function routeAskIndex(request:ApiRequest,options:RoutingOptions):Promise<RouteResult|null>{
 if(!(ASK_INDEX_PATHS as readonly string[]).includes(request.path))return null;
 if(!options.auth)return {status:401,body:redactError('unauthenticated')};const principal=await requirePrincipal(options.auth,request);if(!principal.ok)return principal.result;
 if(request.method!=='POST')return {status:405,body:redactError('method_not_allowed')};
 if(request.path==='/ask/index/request')return runRouteCommand({auth:options.auth,request,principal:principal.principal},requestSchema,'crm.ask_index_requested',requestAskIndex);
 const scoped=contextForPrincipal(options.auth,principal.principal);if(!scoped.ok)return scoped.result;const parsed=readSchema.safeParse(request.body);if(!parsed.success)return {status:400,body:redactError('malformed_body')};const value=await withTransaction(options.auth.db,()=>readAskIndex(scoped.context,parsed.data.workId));return value?{status:200,body:value}:{status:404,body:redactError('not_found')};
}
