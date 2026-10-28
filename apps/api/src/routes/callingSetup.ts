import {callingSetupCommandSchema,callingSetupReceiptInputSchema,callingSetupReceiptSchema,callingBudgetCommandSchema,callingBudgetReceiptSchema} from '@fss/contracts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {CALLING_SETUP_COMMAND_KIND,changeCallingProvider,readCallingSetup,readCallingSetupReceipt} from '@fss/domain/calling/setup.ts';
import {CALLING_BUDGET_COMMAND_KIND,changeCallingBudget,readCallingBudgetReceipt} from '@fss/domain/calling/setupBudget.ts';
import {CallingAuthorityChanged,requireCallingAuthority} from '@fss/domain/calling/followUpDraftAccess.ts';
import {policyRouteDeps} from './dialSupport.ts';
import {contextForPrincipal,runRouteCommand} from './routeSupport.ts';
import {retainedPrincipalAuthority} from './retainedPrincipalAuthority.ts';
import {privatePrincipalIsCurrent} from './privateReadAuthority.ts';
import type {ApiRequest,RouteResult,RoutingOptions} from './types.ts';
export const CALLING_SETUP_PATHS=['/calling/setup','/calling/setup/provider','/calling/setup/receipt','/calling/setup/budget','/calling/setup/budget-receipt'] as const;
/** Calling-local owner control. No generic settings proxy or provider account request. */
export async function routeCallingSetup(request:ApiRequest,options:RoutingOptions):Promise<RouteResult|null>{
 if(!(CALLING_SETUP_PATHS as readonly string[]).includes(request.path))return null;
 const prepared=await policyRouteDeps(request,options);if(!prepared.ok)return prepared.result;
 if(request.method!==(request.path===CALLING_SETUP_PATHS[0]?'GET':'POST'))return {status:405,body:{error:'method_not_allowed'}};
 const deps=prepared.deps,scoped=contextForPrincipal(deps.auth,deps.principal);if(!scoped.ok)return scoped.result;
 const configured=(options.integrations?.twilio??null)!==null;
 try{
  let answer:RouteResult;
  if(request.path===CALLING_SETUP_PATHS[1]||request.path===CALLING_SETUP_PATHS[3]){
   const beforeCommit=(ctx:Parameters<typeof requireCallingAuthority>[0])=>requireCallingAuthority(ctx,retainedPrincipalAuthority(deps,ctx));
   answer=request.path===CALLING_SETUP_PATHS[1]
    ?await runRouteCommand(deps,callingSetupCommandSchema,CALLING_SETUP_COMMAND_KIND,(ctx,input)=>changeCallingProvider(ctx,input,configured,retainedPrincipalAuthority(deps,ctx)),beforeCommit)
    :await runRouteCommand(deps,callingBudgetCommandSchema,CALLING_BUDGET_COMMAND_KIND,(ctx,input)=>changeCallingBudget(ctx,input,retainedPrincipalAuthority(deps,ctx)),beforeCommit);
   // Replays do not run command work/beforeCommit. They cannot confer fresh admin authority.
   if(deps.principal.role!=='admin'&&answer.status===200)throw new CallingAuthorityChanged();
  }else{
   answer=await withTransaction(deps.auth.db,async()=>{
    const ctx=scoped.context,authority=retainedPrincipalAuthority(deps,ctx);
    if(request.path===CALLING_SETUP_PATHS[0])return {status:200,body:await readCallingSetup(ctx,configured,authority)};
    const parsed=callingSetupReceiptInputSchema.safeParse(request.body);if(!parsed.success)return {status:400,body:{error:'malformed_body'}};
    return request.path===CALLING_SETUP_PATHS[4]
     ?{status:200,body:callingBudgetReceiptSchema.parse(await readCallingBudgetReceipt(ctx,parsed.data,deps.principal.deviceId,authority))}
     :{status:200,body:callingSetupReceiptSchema.parse(await readCallingSetupReceipt(ctx,parsed.data,deps.principal.deviceId,authority))};
   });
  }
  if(!await privatePrincipalIsCurrent(deps))throw new CallingAuthorityChanged();
  return answer;
 }catch(error){if(error instanceof CallingAuthorityChanged)return {status:401,body:{error:'session_changed'}};throw error;}
}
