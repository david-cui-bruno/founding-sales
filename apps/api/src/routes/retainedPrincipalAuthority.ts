import type {RepositoryContext} from '@fss/domain/db/workspaceScope.ts';
import {requirePrincipal,type RouteDeps} from './routeSupport.ts';
import {samePrivatePrincipal} from './privateReadAuthority.ts';
import {bearerOf,parseAccessToken,sha256Hex} from '../auth/tokens.ts';

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

/** Selected whole-original export only. Capture the original bearer's deadlines
 * under the same transaction locks, then check without another auth/source wait. */
export function retainedPrincipalPublicationAuthority(deps:RouteDeps,ctx:RepositoryContext){
 const current=retainedPrincipalAuthority(deps,ctx);
 let deadline:number|null=null;
 return {
  authority:async()=>{
   deadline=null;
   if(!await current())return false;
   const bearer=bearerOf(deps.request.headers['authorization']);
   const token=bearer===null?null:parseAccessToken(bearer),p=deps.principal;
   if(!bearer||token?.workspaceId!==p.workspaceId)return false;
   const row=(await ctx.db.query<{expires_at:Date;reauthenticate_after:Date}>(`SELECT expires_at,reauthenticate_after FROM sessions
    WHERE workspace_id=$1 AND id=$2 AND device_id=$3 AND user_id=$4 AND access_token_hash=$5 AND status='active' FOR SHARE`,
   [p.workspaceId,p.sessionId,p.deviceId,p.userId,sha256Hex(bearer)])).rows[0];
   if(!row)return false;
   const end=Math.min(row.expires_at.getTime(),row.reauthenticate_after.getTime());
   if(!Number.isFinite(end))return false;
   deadline=end;
   return true;
  },
  publicationNow:(databaseNow:number):number|null=>{
   // Both clocks are server trusted. Advance source and principal time together.
   const now=Math.max(databaseNow,deps.auth.now().getTime());
   return Number.isFinite(now)&&deadline!==null&&now<deadline?now:null;
  },
 };
}
