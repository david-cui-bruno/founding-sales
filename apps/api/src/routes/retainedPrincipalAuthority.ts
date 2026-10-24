import type {RepositoryContext} from '@fss/domain/db/workspaceScope.ts';
import {requirePrincipal,type RouteDeps} from './routeSupport.ts';
import {samePrivatePrincipal} from './privateReadAuthority.ts';

/** Internal only. Domain calls after its ownership waits, on the command transaction.
 * Device -> session share locks serialize sign-out/revocation through commit.
 * Reauthentication uses the original bearer and fresh trusted auth clock, never wire time.
 */
export function retainedPrincipalAuthority(deps:RouteDeps,ctx:RepositoryContext):()=>Promise<boolean>{
 return async()=>{
  const p=deps.principal;
  if((await ctx.db.query('SELECT id FROM devices WHERE workspace_id=$1 AND id=$2 AND user_id=$3 FOR SHARE',[p.workspaceId,p.deviceId,p.userId])).rows.length!==1)return false;
  if((await ctx.db.query('SELECT id FROM sessions WHERE workspace_id=$1 AND id=$2 AND device_id=$3 AND user_id=$4 FOR SHARE',[p.workspaceId,p.sessionId,p.deviceId,p.userId])).rows.length!==1)return false;
  const current=await requirePrincipal({...deps.auth,db:ctx.db},deps.request);
  return current.ok&&samePrivatePrincipal(p,current.principal);
 };
}
