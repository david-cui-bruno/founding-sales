import {crmMailImportReadSchema,crmMailImportRequestSchema} from '@fss/contracts';
import {readCrmMailImport,requestCrmMailImport} from '@fss/domain/mail/crmBackfill.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {contextForPrincipal,requirePrincipal,runRouteCommand} from './routeSupport.ts';
import {redactError} from '../limits.ts';
import type {ApiRequest,RoutingOptions,RouteResult} from './types.ts';
export const CRM_MAIL_IMPORT_PATHS=['/crm/business/mail/import/read','/crm/business/mail/import/request'] as const;
export async function routeCrmMailImport(request:ApiRequest,options:RoutingOptions):Promise<RouteResult|null>{
 if(!(CRM_MAIL_IMPORT_PATHS as readonly string[]).includes(request.path))return null;
 if(options.auth===undefined)return {status:401,body:redactError('unauthenticated')};
 const verified=await requirePrincipal(options.auth,request);if(!verified.ok)return verified.result;
 const scoped=contextForPrincipal(options.auth,verified.principal);if(!scoped.ok)return scoped.result;
 if(request.method!=='POST')return {status:405,body:redactError('method_not_allowed')};
 if(request.path.endsWith('/request'))return runRouteCommand({auth:options.auth,request,principal:verified.principal},crmMailImportRequestSchema,'crm.mail_import_requested',requestCrmMailImport);
 const parsed=crmMailImportReadSchema.safeParse(request.body);if(!parsed.success)return {status:400,body:redactError('malformed_body')};
 return {status:200,body:await withTransaction(options.auth.db,()=>readCrmMailImport(scoped.context,parsed.data))};
}
