import type {z} from 'zod';
import type {RepositoryContext} from '@fss/domain/db/workspaceScope.ts';
import {PrivateDraftAuthorityChanged,requirePrivateDraftAuthority} from '@fss/domain/social/privateDrafts.ts';
import {contextForPrincipal,runRouteCommand,type RouteDeps,type CommandResult} from './routeSupport.ts';
import {retainedPrincipalAuthority} from './retainedPrincipalAuthority.ts';

async function currentSocialPrincipal(deps:RouteDeps,ctx:RepositoryContext):Promise<void>{
 const member=await ctx.db.query("SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 AND status='active' FOR UPDATE",[deps.principal.workspaceId,deps.principal.userId]);
 if(member.rows.length!==1)throw new PrivateDraftAuthorityChanged();
 await requirePrivateDraftAuthority(retainedPrincipalAuthority(deps,ctx));
}
/** Existing receipt owner, with membership-before-content and post-wait/replay fences. */
export async function guardedSocialCommand<Schema extends z.ZodType<{commandId:string;clientVersion:string}>,T>(
 deps:RouteDeps,schema:Schema,kind:string,
 work:(context:RepositoryContext,body:z.infer<Schema>)=>Promise<CommandResult<T>>,
 beforeCommit?:(context:RepositoryContext)=>Promise<void>,
){
 try{
  const result=await runRouteCommand(deps,schema,kind,async(ctx,body)=>{
   await currentSocialPrincipal(deps,ctx);
   return work(ctx,body);
  },async ctx=>{await beforeCommit?.(ctx);await currentSocialPrincipal(deps,ctx);});
  const scoped=contextForPrincipal(deps.auth,deps.principal);if(!scoped.ok)return scoped.result;
  await currentSocialPrincipal(deps,scoped.context);
  return result;
 }catch(error){if(error instanceof PrivateDraftAuthorityChanged)return {status:401,body:{error:'unauthenticated'}};throw error;}
}
