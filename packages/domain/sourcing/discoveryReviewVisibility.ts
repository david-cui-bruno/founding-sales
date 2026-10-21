import type {RepositoryContext} from '../db/workspaceScope.ts';

export async function lockDiscoveryReviewSources(ctx:RepositoryContext):Promise<void> {
  await ctx.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`sourcing-discovery-review:${ctx.scope.workspaceId}`]);
}

/** Fixed SQL aliases: review r and candidate c. Same predicate gates queue and replay.
 * Source-only provenance is not website ownership or permission. A known loss on any
 * selected page conservatively hides the whole interpretation, never an old fallback. */
export const DISCOVERY_REVIEW_VISIBLE_SQL=`r.candidate_revision=c.revision AND c.status<>'dismissed'
 AND r.reviewed_at>now()-interval '7 days'
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.evidence) page WHERE
   (page->>'retrievedAt')::timestamptz<=now()-interval '7 days'
   OR (page->>'retrievedAt')::timestamptz>now()
   OR NOT EXISTS(SELECT 1 FROM sourcing_candidate_discovery_origins o WHERE o.workspace_id=r.workspace_id AND o.candidate_id=r.candidate_id
     AND o.provider=page->'source'->>'provider' AND o.release=page->'source'->>'release' AND o.record_id=page->'source'->>'recordId')
   OR EXISTS(SELECT 1 FROM sourcing_candidates lost WHERE lost.workspace_id=r.workspace_id
     AND lost.source_check->>'state'='unavailable' AND lost.source_check->>'reason' IN ('source_unavailable','source_not_permitted','no_readable_text')
     AND (rtrim(lost.payload->>'sourceUrl','/')=rtrim(page->>'url','/') OR rtrim(lost.source_check->'lastSuccess'->>'url','/')=rtrim(page->>'url','/')))
   OR EXISTS(SELECT 1 FROM evidence_items e WHERE e.workspace_id=r.workspace_id AND rtrim(e.source_reference,'/')=rtrim(page->>'url','/')
     AND (e.retention_expires_at<=now() OR (NOT e.terms_allow_retention AND e.retention_expires_at IS NULL))))`;

/** Physical erasure, including historical reviews. Called before an existing source
 * loss/terms deletion removes the original predicate. No copied content in receipts. */
export async function eraseDiscoveryReviewsForSources(ctx:RepositoryContext,urls:readonly string[]):Promise<number> {
  if(urls.length===0)return 0;
  await lockDiscoveryReviewSources(ctx);
  const result=await ctx.db.query(`DELETE FROM sourcing_candidate_discovery_reviews r WHERE r.workspace_id=$1
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(r.evidence) page WHERE rtrim(page->>'url','/')=ANY($2::text[]))`,[ctx.scope.workspaceId,urls.map(url=>url.replace(/\/+$/u,''))]);
  return result.rowCount??0;
}

/** Conservative bounded cleanup. Reads hide first, independently of sweep timing. */
export async function sweepDiscoveryReviews(ctx:RepositoryContext,input:{now:string;limit:number}):Promise<number> {
  await lockDiscoveryReviewSources(ctx);
  const result=await ctx.db.query(`DELETE FROM sourcing_candidate_discovery_reviews WHERE workspace_id=$1 AND id IN (
    SELECT r.id FROM sourcing_candidate_discovery_reviews r JOIN sourcing_candidates c ON c.workspace_id=r.workspace_id AND c.id=r.candidate_id
    WHERE r.workspace_id=$1 AND NOT (${DISCOVERY_REVIEW_VISIBLE_SQL.replaceAll('now()','$3::timestamptz')}) ORDER BY r.reviewed_at,r.id LIMIT $2)`,[ctx.scope.workspaceId,input.limit,input.now]);
  return result.rowCount??0;
}
