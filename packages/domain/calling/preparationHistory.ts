import type {RepositoryContext} from '../db/workspaceScope.ts';
import {lockPreparedCallingLifecycle,lockPreparationCleanup} from './preparationLifecycle.ts';
import {preparationForFirm} from './preparationStore.ts';
import {readPreparationExecution} from './preparationExecution.ts';
import {activeIdentityActor} from '../crm/identityAccess.ts';
/** Actual history remains recordable after source loss. This is cleanup custody,
 * never execution permission. Take it before ordinary outcome gate/Today/rows.
 */
export async function lockPreparedCallingHistory(ctx:RepositoryContext,firmId:string):Promise<void>{
 if(!await preparationForFirm(ctx,firmId))return;
 await lockPreparedCallingLifecycle(ctx.db,ctx.scope.workspaceId,firmId);
 await lockPreparationCleanup(ctx);
 const actor=ctx.scope.actor,firm=(await ctx.db.query<{status:string;assigned_user_id:string|null}>('SELECT status,assigned_user_id FROM firms WHERE workspace_id=$1 AND id=$2',[ctx.scope.workspaceId,firmId])).rows[0];
 // The gate freezes assignment. This precheck permits only the eventual history
 // owner to perform required expiry cleanup; the existing row owner decides again.
 if(!firm||firm.status!=='active'||actor.kind!=='user'||!await activeIdentityActor(ctx)||actor.role!=='admin'&&firm.assigned_user_id!==actor.userId)return;
 const p=await preparationForFirm(ctx,firmId);
 if(p?.state==='live'&&!(await readPreparationExecution(ctx,firmId)).ok)
  await ctx.db.query('SELECT erase_calling_preparation($1,$2,$3)',[ctx.scope.workspaceId,p.id,p.source_expires_at.getTime()<=Date.now()?'source_expired':'source_changed']);
}
