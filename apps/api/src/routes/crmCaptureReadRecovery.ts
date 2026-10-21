import { crmCaptureReadRecoveryReadSchema, crmCaptureReadRecoveryRequestSchema, crmCaptureReadRecoveryStatusSchema } from '@fss/contracts';
import { readCaptureReadRecovery, requestCaptureReadRecovery } from '@fss/domain/mail/crmCaptureReadRecovery.ts';
import { withTransaction } from '@fss/domain/db/queryable.ts';
import { contextForPrincipal, requirePrincipal, runRouteCommand } from './routeSupport.ts';
import { redactError } from '../limits.ts';
import type { ApiRequest, RoutingOptions, RouteResult } from './types.ts';
export const CRM_CAPTURE_READ_RECOVERY_PATHS=['/crm/business/capture-read-recovery/read','/crm/business/capture-read-recovery/request'];
export async function routeCrmCaptureReadRecovery(request:ApiRequest,options:RoutingOptions):Promise<RouteResult|null>{
 if(!CRM_CAPTURE_READ_RECOVERY_PATHS.includes(request.path))return null;
 if(!options.auth)return {status:401,body:redactError('unauthenticated')};
 const verified=await requirePrincipal(options.auth,request);if(!verified.ok)return verified.result;
 const scoped=contextForPrincipal(options.auth,verified.principal);if(!scoped.ok)return scoped.result;
 if(request.method!=='POST')return {status:405,body:redactError('method_not_allowed')};
 if(request.path.endsWith('/request'))return runRouteCommand({auth:options.auth,request,principal:verified.principal},crmCaptureReadRecoveryRequestSchema,'crm.capture_read_recovery_requested',(ctx,body)=>requestCaptureReadRecovery(ctx,body,options.crmCapabilityRuntime));
 const parsed=crmCaptureReadRecoveryReadSchema.safeParse(request.body);
 if(!parsed.success)return {status:400,body:redactError('malformed_body')};
 const result=await withTransaction(options.auth.db,()=>readCaptureReadRecovery(scoped.context,parsed.data,options.crmCapabilityRuntime));
 return result?{status:200,body:crmCaptureReadRecoveryStatusSchema.parse(result)}:{status:404,body:redactError('not_found')};
}
