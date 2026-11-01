import type {RepositoryContext} from '../db/workspaceScope.ts';
import {activeIdentityActor} from '../crm/identityAccess.ts';
import {lockPreparationCleanup} from './preparationLifecycle.ts';
import {CallingPreparationChanged} from './preparation.ts';
import type {PreparationAuthority} from './preparationSource.ts';

/** Internal domain/operator entry only. No general member administration route.
 * Lifecycle/gate/Today precede the member row and its existing erasure triggers.
 * The database's last-active-admin constraint remains in force.
 */
export async function changePreparedCallingMemberAuthority(ctx:RepositoryContext,input:{userId:string;role?:'salesperson';status?:'inactive';delete?:boolean},authority:PreparationAuthority):Promise<{ok:true}|{ok:false;reason:'admin_only'|'member_unknown'|'invalid_input'}>{
 if(ctx.scope.actor.kind!=='user'||ctx.scope.actor.role!=='admin'||!await activeIdentityActor(ctx)||!await authority())return {ok:false,reason:'admin_only'};
 await lockPreparationCleanup(ctx);
 const member=(await ctx.db.query<{role:string;status:string}>('SELECT role,status FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 FOR UPDATE',[ctx.scope.workspaceId,input.userId])).rows[0];
 if(!member)return {ok:false,reason:'member_unknown'};
 if(input.role!==undefined&&input.role!=='salesperson'||input.status!==undefined&&input.status!=='inactive')return {ok:false,reason:'invalid_input'};
 if(!await authority()||!await activeIdentityActor(ctx))throw new CallingPreparationChanged('authority_changed');
 if(input.delete)await ctx.db.query('DELETE FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2',[ctx.scope.workspaceId,input.userId]);
 else await ctx.db.query(`UPDATE workspace_memberships SET role=$3,status=$4,
  deactivated_at=CASE WHEN $4='inactive' THEN COALESCE(deactivated_at,clock_timestamp()) ELSE NULL END,updated_at=clock_timestamp()
  WHERE workspace_id=$1 AND user_id=$2`,[ctx.scope.workspaceId,input.userId,input.role??member.role,input.status??member.status]);
 // Losing one's own authority cannot produce an accepted member command.
 if(!await authority()||!await activeIdentityActor(ctx))throw new CallingPreparationChanged('authority_changed');
 return {ok:true};
}
/** Existing research-evidence maintenance owns physical expiry; clock-based current
 * execution denial already applies before this bounded cleanup reaches the row. A prepared-capture company is also
 * withdrawn once a newer qualification run supersedes its source (current reads already refuse it meanwhile).
 */
export async function sweepCallingPreparations(ctx:RepositoryContext,input:{limit:number}):Promise<number>{
 await lockPreparationCleanup(ctx);
 const rows=(await ctx.db.query<{id:string;reason:string}>(`SELECT p.id,CASE WHEN p.source_expires_at<=clock_timestamp() THEN 'source_expired' ELSE 'source_changed' END reason
  FROM calling_preparations p WHERE p.workspace_id=$1 AND p.state='live' AND (p.source_expires_at<=clock_timestamp() OR p.source_kind='prepared_capture'
  AND EXISTS(SELECT 1 FROM sourcing_qualification_runs q JOIN sourcing_qualification_runs n ON n.workspace_id=q.workspace_id AND n.candidate_id=q.candidate_id
   AND (n.requested_at,n.id)>(q.requested_at,q.id) WHERE q.workspace_id=p.workspace_id AND q.id=p.discovery_run_ref))
  ORDER BY p.source_expires_at,p.id LIMIT $2`,[ctx.scope.workspaceId,input.limit])).rows;
 for(const row of rows)await ctx.db.query('SELECT erase_calling_preparation($1,$2,$3)',[ctx.scope.workspaceId,row.id,row.reason]);
 return rows.length;
}
