import {socialPublicThreadUrlSchema} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import type {RetentionSweepInput} from '../retention/targets.ts';
import type {TableCoverage} from '../retention/coverage.ts';
export interface PublicThreadRow extends Record<string,unknown>{id:string;owner_user_id:string;revision:number;captured_at:Date;expires_at:Date;
 retained_at:Date;updated_at:Date;source_url:string|null;payload:string|null;payload_sha256:string|null;
 coverage:'partial'|'unknown'|null;message_count:number|null;reason:'expired'|'removed'|null}
const clear="source_url=NULL,payload=NULL,payload_sha256=NULL,coverage=NULL,message_count=NULL,revision=revision+1,updated_at=clock_timestamp()";
async function lifecycleAllowed(ctx:RepositoryContext):Promise<void>{
 if(ctx.scope.actor.kind==='system')return;
 if(ctx.scope.actor.role==='admin'&&(await ctx.db.query("SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 AND status='active' AND role='admin' FOR SHARE",[ctx.scope.workspaceId,ctx.scope.actor.userId])).rows.length===1)return;
 throw new Error('public_thread_lifecycle_authority_required');
}
/** Internal retention/deletion owners only; no HTTP mutation exists. */
export async function eraseSocialPublicThreadsForOwner(ctx:RepositoryContext,ownerUserId:string):Promise<number>{
 await lifecycleAllowed(ctx);
 return (await ctx.db.query(`UPDATE social_public_threads SET ${clear},reason='removed' WHERE workspace_id=$1 AND owner_user_id=$2 AND reason IS NULL`,[ctx.scope.workspaceId,ownerUserId])).rowCount??0;
}
/** A later original-removal owner can revoke only this exact canonical thread. */
export async function eraseSocialPublicThreadByIdentity(ctx:RepositoryContext,input:{ownerUserId:string;url:string}):Promise<number>{
 if(!socialPublicThreadUrlSchema.safeParse(input.url).success)throw new Error('invalid_public_thread_identity');
 await lifecycleAllowed(ctx);
 return (await ctx.db.query(`UPDATE social_public_threads SET ${clear},reason='removed' WHERE workspace_id=$1 AND owner_user_id=$2 AND source_url=$3 AND reason IS NULL`,[ctx.scope.workspaceId,input.ownerUserId,input.url])).rowCount??0;
}
export async function sweepSocialPublicThreads(ctx:RepositoryContext,input:RetentionSweepInput):Promise<number>{
 if(!Number.isSafeInteger(input.limit)||input.limit<1||input.limit>500)throw new Error('invalid_retention_limit');
 await lifecycleAllowed(ctx);
 return (await ctx.db.query(`UPDATE social_public_threads SET ${clear},reason='expired' WHERE workspace_id=$1 AND reason IS NULL
  AND id IN (SELECT id FROM social_public_threads WHERE workspace_id=$1 AND reason IS NULL AND expires_at<=clock_timestamp() ORDER BY id LIMIT $2 FOR UPDATE)
  AND expires_at<=clock_timestamp()`,[ctx.scope.workspaceId,input.limit])).rowCount??0;
}
/** Called only with the current owner's locked row by the read owner. */
export async function removeSocialPublicThreadRow(ctx:RepositoryContext,row:PublicThreadRow):Promise<PublicThreadRow>{
 if(row.reason!==null)return row;
 return (await ctx.db.query<PublicThreadRow>(`UPDATE social_public_threads SET ${clear},reason='removed'
  WHERE workspace_id=$1 AND id=$2 AND owner_user_id=$3 AND reason IS NULL RETURNING *`,[ctx.scope.workspaceId,row.id,row.owner_user_id])).rows[0]??row;
}
export async function expireSocialPublicThreadRow(ctx:RepositoryContext,row:PublicThreadRow):Promise<PublicThreadRow>{
 if(row.reason!==null)return row;
 return (await ctx.db.query<PublicThreadRow>(`UPDATE social_public_threads SET ${clear},reason='expired'
  WHERE workspace_id=$1 AND id=$2 AND owner_user_id=$3 AND reason IS NULL AND expires_at<=clock_timestamp() RETURNING *`,
 [ctx.scope.workspaceId,row.id,row.owner_user_id])).rows[0]??row;
}
export const SOCIAL_PUBLIC_THREAD_RETENTION_COVERAGE:Readonly<Record<string,TableCoverage>>={social_public_threads:{
 dispositions:['swept','deletion_redacts','departure_revokes','retained'],
 note:'Owner-scoped retained LinkedIn public-web snapshot only. Immutable capture and maximum30day/source horizon; registered expiry, exact source removal and owner departure/role loss/delete erase every source URL/ID/hash/author/text byte. Opaque identity/revision/timing remain terminal; workspace deletion cascades. No acquisition, model, account or publication authority.',
}};
