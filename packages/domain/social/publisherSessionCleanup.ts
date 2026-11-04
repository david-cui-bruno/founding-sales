import type {RepositoryContext} from '../db/workspaceScope.ts';

/** Existing retention sweep only; never run nested inside browser/provider operations.
 * Parent membership -> plan -> account -> session ordering matches publisher authority. */
export async function expireSocialPublisherSessions(ctx:RepositoryContext):Promise<number>{
 if(ctx.scope.actor.kind!=='system'||ctx.scope.actor.component!=='worker')throw new Error('worker_required');
 const candidates=(await ctx.db.query<{id:string;owner_user_id:string;account_id:string}>(`SELECT id,owner_user_id,account_id FROM social_publisher_sessions
  WHERE workspace_id=$1 AND state='usable' AND expires_at<=clock_timestamp() ORDER BY owner_user_id,account_id LIMIT 30`,[ctx.scope.workspaceId])).rows;
 let erased=0;
 for(const session of candidates){
  await ctx.db.query('SELECT user_id FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 FOR UPDATE',[ctx.scope.workspaceId,session.owner_user_id]);
  await ctx.db.query('SELECT id FROM social_standing_plans WHERE workspace_id=$1 AND owner_user_id=$2 ORDER BY id FOR UPDATE',[ctx.scope.workspaceId,session.owner_user_id]);
  await ctx.db.query('SELECT id FROM social_accounts WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.scope.workspaceId,session.account_id]);
  const result=await ctx.db.query(`UPDATE social_publisher_sessions SET encrypted_state=NULL,state='expired',revision=revision+1
   WHERE workspace_id=$1 AND id=$2 AND state='usable' AND expires_at<=clock_timestamp() RETURNING id`,[ctx.scope.workspaceId,session.id]);
  erased+=result.rows.length;
 }
 return erased;
}
