import type {RepositoryContext} from '../db/workspaceScope.ts';
import {decideAdminOnly} from '../crm/authorization.ts';
import {readResearchSettings} from '../research/settings.ts';
import {listApplicableHolds} from '../policy/holds.ts';
import {requestSourceCheck} from './sourceCheck.ts';

export const SOURCE_MONITOR_LIMIT=25;
/** Runs inside the worker transaction. Row locks serialize review and explicit checks.
 * No network: the durable check job owns fetching after this transaction commits.
 */
export async function monitorCandidateSources(context:RepositoryContext):Promise<{queued:number}> {
  if(!decideAdminOnly(context).permitted)return {queued:0};
  if(!(await readResearchSettings(context)).enabled)return {queued:0};
  if((await listApplicableHolds(context,{actionKind:'research'})).length>0)return {queued:0};
  const {rows}=await context.db.query<{id:string;revision:number}>(
    `SELECT id,revision FROM sourcing_candidates WHERE workspace_id=$1 AND status='kept'
      AND next_source_check_at<=now() ORDER BY next_source_check_at,id
      LIMIT $2 FOR UPDATE SKIP LOCKED`,[context.scope.workspaceId,SOURCE_MONITOR_LIMIT]);
  let queued=0;
  for(const row of rows){
    const result=await requestSourceCheck(context,{id:row.id,expectedRevision:row.revision},{scheduled:true});
    if(result.ok){queued++;continue;}
    if(['daily_firm_ceiling','research_disabled','research_held'].includes(result.reason))break;
    // An un-fetchable source must not occupy the head of every bounded pass.
    // Pending work likewise already owns a request; do not duplicate it hourly.
    if(result.reason==='source_not_permitted'||result.reason==='check_in_progress'){
      await context.db.query("UPDATE sourcing_candidates SET next_source_check_at=now()+interval '7 days' WHERE workspace_id=$1 AND id=$2 AND status='kept'",[context.scope.workspaceId,row.id]);
    }
  }
  return {queued};
}
