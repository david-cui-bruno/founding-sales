import type {RepositoryContext} from '../db/workspaceScope.ts';

const RETIRED_POSTING_REASON='recurring_posting_removed';

/** Historical bindings are preserved, not converted into manual authority.
 * Keep account/policy serialization before post locks, as the former admission
 * barrier did. A new, unbound manual revision still uses ordinary approval. */
export async function retiredPostingDeliveryReason(ctx:RepositoryContext,by:'post_id'|'claim_id'|'id',id:string):Promise<string|null>{
 const owner=ctx.scope.actor.kind==='user'?ctx.scope.actor.userId:null;
 if(!owner)return 'owner_unavailable';
 await ctx.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`social-accounts:${ctx.scope.workspaceId}:${owner}`]);
 await ctx.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`linkedin-posting-policy:${ctx.scope.workspaceId}:${owner}`]);
 const row=(await ctx.db.query<{approval_kind:string;policy_bound:boolean}>(`SELECT a.approval_kind,(b.delivery_id IS NOT NULL) AS policy_bound
 FROM social_deliveries d
 JOIN social_posts p ON p.workspace_id=d.workspace_id AND p.id=d.post_id
 JOIN social_post_approvals a ON a.workspace_id=d.workspace_id AND a.id=d.approval_id
 LEFT JOIN linkedin_posting_candidate_bindings b ON b.workspace_id=d.workspace_id AND b.delivery_id=d.id
 WHERE d.workspace_id=$1 AND d.${by}=$2 AND p.owner_user_id=$3
 AND d.revision=p.current_revision AND d.state IN ('pending','preparing') AND d.submission_id IS NULL
 ORDER BY d.revision DESC LIMIT 1`,[ctx.scope.workspaceId,id,owner])).rows[0];
 return row&&(row.approval_kind!=='manual'||row.policy_bound)?RETIRED_POSTING_REASON:null;
}

/** A failed/cancelled delivery does not erase the authority that bound its revision.
 * Call before post locks, then validate the locked current revision before using
 * this result. New human revisions without that binding remain ordinary drafts. */
export async function retiredPostingRevisionReason(ctx:RepositoryContext,postId:string,revision:number):Promise<string|null>{
 const owner=ctx.scope.actor.kind==='user'?ctx.scope.actor.userId:null;
 if(!owner)return 'owner_unavailable';
 await ctx.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`social-accounts:${ctx.scope.workspaceId}:${owner}`]);
 await ctx.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`linkedin-posting-policy:${ctx.scope.workspaceId}:${owner}`]);
 const bound=(await ctx.db.query(`SELECT 1 FROM social_deliveries d
 JOIN social_posts p ON p.workspace_id=d.workspace_id AND p.id=d.post_id
 JOIN social_post_approvals a ON a.workspace_id=d.workspace_id AND a.id=d.approval_id
 LEFT JOIN linkedin_posting_candidate_bindings b ON b.workspace_id=d.workspace_id AND b.delivery_id=d.id
 WHERE d.workspace_id=$1 AND d.post_id=$2 AND d.revision=$3 AND p.owner_user_id=$4
 AND (a.approval_kind<>'manual' OR b.delivery_id IS NOT NULL) LIMIT 1`,[ctx.scope.workspaceId,postId,revision,owner])).rows.length>0;
 return bound?RETIRED_POSTING_REASON:null;
}

/** An old queued standing draft may never spend through the manual draft worker.
 * This reads only a retained binding, not policy settings or runtime authority. */
export async function retiredPostingDraftReason(ctx:RepositoryContext,id:string):Promise<string|null>{
 const bound=(await ctx.db.query('SELECT 1 FROM linkedin_recurring_slots WHERE workspace_id=$1 AND draft_request_id=$2 LIMIT 1',[ctx.scope.workspaceId,id])).rows.length>0;
 return bound?RETIRED_POSTING_REASON:null;
}
