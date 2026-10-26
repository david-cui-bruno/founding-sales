import type {RepositoryContext} from '../db/workspaceScope.ts';
import {lockDiscoveryReviewSources} from '../sourcing/discoveryReviewVisibility.ts';
import {MANUAL_ACTIVITY_RAW_SQL} from '../sourcing/manualProspectActivityAccess.ts';
/** No arbitrary draft age. Exact existing source rights and source deletion own expiry. */
export async function sweepCallingDrafts(ctx:RepositoryContext,input:{limit:number}):Promise<number>{
 await lockDiscoveryReviewSources(ctx);
 const result=await ctx.db.query(`WITH permitted AS (${MANUAL_ACTIVITY_RAW_SQL}), targets AS (
 SELECT d.id FROM calling_follow_up_drafts d WHERE d.workspace_id=$1 AND d.content IS NOT NULL AND (
  NOT EXISTS(SELECT 1 FROM workspace_memberships m WHERE m.workspace_id=d.workspace_id AND m.user_id=d.creator_user_id AND m.status='active')
  OR (d.source_kind='candidate' AND NOT EXISTS(SELECT 1 FROM permitted p JOIN sourcing_manual_prospect_attempts a ON a.workspace_id=p.workspace_id AND a.candidate_id=p.id AND a.candidate_revision=p.revision
   WHERE p.id=d.candidate_id AND p.revision=d.candidate_revision AND a.id=d.attempt_id AND a.content IS NOT NULL AND a.reason IS NULL))
  OR (d.source_kind='firm' AND NOT EXISTS(SELECT 1 FROM firms f JOIN call_logs l ON l.workspace_id=f.workspace_id AND l.firm_id=f.id
   WHERE f.workspace_id=d.workspace_id AND f.id=d.firm_id AND f.status='active' AND l.id=d.call_log_id)))
 ORDER BY d.id LIMIT $3)
 UPDATE calling_follow_up_drafts d SET content=NULL,reason='source_changed_or_unavailable',revision=revision+1,updated_at=clock_timestamp()
 FROM targets t WHERE d.workspace_id=$1 AND d.id=t.id AND d.content IS NOT NULL`,[ctx.scope.workspaceId,'all',input.limit]);
 return result.rowCount??0;
}
