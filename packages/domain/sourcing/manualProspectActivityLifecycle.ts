import type {RepositoryContext} from '../db/workspaceScope.ts';
import {lockDiscoveryReviewSources} from './discoveryReviewVisibility.ts';
import {MANUAL_ACTIVITY_RAW_SQL} from './manualProspectActivityAccess.ts';
/** Read denial is immediate; existing bounded retention also clears older copies. */
export async function sweepManualActivity(ctx:RepositoryContext,input:{limit:number}):Promise<number>{
 await lockDiscoveryReviewSources(ctx);
 const result=await ctx.db.query(`WITH permitted AS (${MANUAL_ACTIVITY_RAW_SQL}), targets AS (
 SELECT a.id FROM sourcing_manual_prospect_attempts a JOIN sourcing_candidates c ON c.workspace_id=a.workspace_id AND c.id=a.candidate_id
 WHERE a.workspace_id=$1 AND a.content IS NOT NULL AND (a.candidate_revision<>c.revision OR NOT EXISTS(SELECT 1 FROM permitted p WHERE p.id=c.id))
 ORDER BY a.id LIMIT $3)
 UPDATE sourcing_manual_prospect_attempts a SET content=NULL,reason=CASE WHEN a.candidate_revision<>c.revision THEN 'candidate_revision_changed' ELSE 'source_changed_or_unavailable' END,revision=a.revision+1,updated_at=clock_timestamp()
 FROM sourcing_candidates c,targets t WHERE a.workspace_id=$1 AND a.id=t.id AND c.workspace_id=a.workspace_id AND c.id=a.candidate_id AND a.content IS NOT NULL`,[ctx.scope.workspaceId,'all',input.limit]);
 return result.rowCount??0;
}
