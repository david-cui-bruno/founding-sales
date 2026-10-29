import type {RepositoryContext} from '../db/workspaceScope.ts';
import {lockDiscoveryReviewSources} from './discoveryReviewVisibility.ts';
import {MANUAL_ACTIVITY_RAW_SQL} from './manualProspectActivityAccess.ts';
/** Same source lock and existing evidence retention job; no read-side mutation. */
export async function sweepProspectPriorities(ctx:RepositoryContext,input:{limit:number}):Promise<number>{
 await lockDiscoveryReviewSources(ctx);
 // Historical upgrade fixtures do not have this opt-in owner yet.
 if(!(await ctx.db.query<{exists:boolean}>("SELECT to_regclass('sourcing_prospect_priorities') IS NOT NULL AS exists")).rows[0]?.exists)return 0;
 let removed=0;
 for(const table of ['sourcing_prospect_priorities','sourcing_prospect_considerations']){
  const key=table==='sourcing_prospect_priorities'?'candidate_id':'id';
  const result=await ctx.db.query(`WITH permitted AS (${MANUAL_ACTIVITY_RAW_SQL}), targets AS (
   SELECT a.${key} FROM ${table} a WHERE a.workspace_id=$1 AND (a.expires_at<=clock_timestamp()
   OR NOT EXISTS(SELECT 1 FROM permitted p WHERE p.id=a.candidate_id)) ORDER BY a.${key} LIMIT $3)
   DELETE FROM ${table} a USING targets t WHERE a.workspace_id=$1 AND a.${key}=t.${key}`,[ctx.scope.workspaceId,'all',input.limit]);
  removed+=result.rowCount??0;
 }
 return removed;
}
