import type {SocialDraftRequest} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {tryLockResearchBudget} from '../research/ceilings.ts';
import {finaliseSubjectReservations} from '../research/reservations.ts';
import {databaseNow} from '../policy/clock.ts';
import {recordCrmAuditEvent} from '../crm/audit.ts';
import {SOCIAL_DRAFT_MODEL,SOCIAL_DRAFT_PROMPT_VERSION,type SocialDraftConcept} from './draftPolicy.ts';
import {readSocialDraftSources} from './draftSources.ts';
import type {SocialResult} from './posts.ts';
export interface SocialDraftRow {
 [key:string]:unknown;
 id:string;owner_user_id:string;source_selection:SocialDraftRequest;source_hash:string;
 prompt_version:string;model_name:string;state:'queued'|'calling'|'ready'|'review'|'expired';
 paid_attempts:number;concepts:SocialDraftConcept[]|null;reason:string|null;
 created_at:Date;deadline_at:Date;updated_at:Date;
}
/** Called within the command transaction; the request contains no transcript text. */
export async function requestSocialDrafts(ctx:RepositoryContext,input:SocialDraftRequest):Promise<SocialResult<{requestId:string}>>{
 if(ctx.scope.actor.kind!=='user')return {ok:false,reason:'user_required'};
 const owner=ctx.scope.actor.userId;
 await ctx.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`social-drafts:${ctx.scope.workspaceId}:${owner}`]);
 const prepared=await readSocialDraftSources(ctx,input);if(!prepared.ok)return prepared;
 const existing=(await ctx.db.query<{id:string}>("SELECT id FROM social_draft_requests WHERE workspace_id=$1 AND owner_user_id=$2 AND source_hash=$3 AND prompt_version=$4 AND state IN ('queued','calling')",[ctx.scope.workspaceId,owner,prepared.value.hash,SOCIAL_DRAFT_PROMPT_VERSION])).rows[0];
 if(existing)return {ok:true,value:{requestId:existing.id}};
 const count=(await ctx.db.query<{count:number}>("SELECT count(*)::integer AS count FROM social_draft_requests WHERE workspace_id=$1 AND owner_user_id=$2 AND state IN ('queued','calling')",[ctx.scope.workspaceId,owner])).rows[0]!.count;
 if(count>=3)return {ok:false,reason:'draft_requests_pending'};
 const row=(await ctx.db.query<{id:string}>(`INSERT INTO social_draft_requests(workspace_id,owner_user_id,source_selection,source_hash,prompt_version,model_name) VALUES($1,$2,$3::jsonb,$4,$5,$6) RETURNING id`,[ctx.scope.workspaceId,owner,JSON.stringify(input),prepared.value.hash,SOCIAL_DRAFT_PROMPT_VERSION,SOCIAL_DRAFT_MODEL])).rows[0]!;
 await recordCrmAuditEvent(ctx,{action:'social.drafts_requested',subjectKind:'social_draft_request',subjectId:row.id,detail:{sourceCount:input.sourceRefs.length}});
 return {ok:true,value:{requestId:row.id}};
}
export async function readSocialDraftRequest(ctx:RepositoryContext,id:string):Promise<SocialDraftRow|null>{
 if(ctx.scope.actor.kind!=='user')return null;
 return (await ctx.db.query<SocialDraftRow>('SELECT * FROM social_draft_requests WHERE workspace_id=$1 AND id=$2 AND owner_user_id=$3',[ctx.scope.workspaceId,id,ctx.scope.actor.userId])).rows[0]??null;
}
/** Run within the scheduler transaction even when processing is disabled.
 * A lost calling reservation is estimated, never treated as a free attempt. */
export async function expireSocialDraftRequests(ctx:RepositoryContext):Promise<number>{
 if(ctx.scope.actor.kind!=='system'||!['worker','scheduler'].includes(ctx.scope.actor.component))throw new Error('system_required');
 if(!await tryLockResearchBudget(ctx))return 0;
 const at=await databaseNow(ctx);
 const pending=(await ctx.db.query<{id:string}>("SELECT id FROM social_draft_requests WHERE workspace_id=$1 AND state IN ('queued','calling') AND deadline_at<=now() ORDER BY deadline_at,id LIMIT 100 FOR UPDATE",[ctx.scope.workspaceId])).rows;
 for(const row of pending)await finaliseSubjectReservations(ctx,{subjectKind:'social_draft',subjectId:row.id,at});
 if(!pending.length)return 0;
 const rows=await ctx.db.query("UPDATE social_draft_requests SET state='expired',reason='deadline_expired',updated_at=now() WHERE workspace_id=$1 AND state IN ('queued','calling') AND id=ANY($2::uuid[]) RETURNING id",[ctx.scope.workspaceId,pending.map(row=>row.id)]);
 return rows.rows.length;
}
