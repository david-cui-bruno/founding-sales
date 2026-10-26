import {callingExecutionReceiptInputSchema} from '@fss/contracts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {readCallingExecutionReceipt} from '@fss/domain/calls/executionReceipt.ts';
import {CallingAuthorityChanged} from '@fss/domain/calling/followUpDraftAccess.ts';
import {policyRouteDeps} from './dialSupport.ts';
import {contextForPrincipal} from './routeSupport.ts';
import {retainedPrincipalAuthority} from './retainedPrincipalAuthority.ts';
import {privatePrincipalIsCurrent} from './privateReadAuthority.ts';
import type {ApiRequest,RouteResult,RoutingOptions} from './types.ts';
export const CALLING_EXECUTION_RECEIPT_PATHS=['/calling/execution/receipt'] as const;
export async function routeCallingExecutionReceipt(request:ApiRequest,options:RoutingOptions):Promise<RouteResult|null>{
 if(request.path!==CALLING_EXECUTION_RECEIPT_PATHS[0])return null;
 const prepared=await policyRouteDeps(request,options);if(!prepared.ok)return prepared.result;
 if(request.method!=='POST')return {status:405,body:{error:'method_not_allowed'}};
 const parsed=callingExecutionReceiptInputSchema.safeParse(request.body);
 if(!parsed.success)return {status:400,body:{error:'malformed_body'}};
 const deps=prepared.deps,scoped=contextForPrincipal(deps.auth,deps.principal);if(!scoped.ok)return scoped.result;
 try{
  const body=await withTransaction(deps.auth.db,()=>readCallingExecutionReceipt(scoped.context,parsed.data,deps.principal.deviceId,retainedPrincipalAuthority(deps,scoped.context)));
  if(!await privatePrincipalIsCurrent(deps))return {status:401,body:{error:'session_changed'}};
  return {status:200,body};
 }catch(error){if(error instanceof CallingAuthorityChanged)return {status:401,body:{error:'session_changed'}};throw error;}
}
