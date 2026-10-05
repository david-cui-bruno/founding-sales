import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import type {JobHandler} from '@fss/domain/jobs/handlerRegistry.ts';
import type {JobSpecification} from '@fss/domain/jobs/jobStore.ts';
import {jobIdempotencyKey} from '@fss/domain/jobs/jobKinds.ts';
import {readResearchSettings} from '@fss/domain/research/settings.ts';
import {listApplicableHolds} from '@fss/domain/policy/holds.ts';
import {monitorCandidateSources} from '@fss/domain/sourcing/monitoring.ts';
import type {DueWorkSource} from '../scheduler/schedulerPass.ts';

export function sourcingMonitorHandler():JobHandler {
  return {kind:'sourcing.monitor',protection:'business_uniqueness',maxAttempts:2,leaseSeconds:60,
    handle:async input=>{await monitorCandidateSources(repositoryContext(input.scope,input.session));}};
}
export function sourcingMonitorSource(enabled:boolean):DueWorkSource {
  return {name:'sourcing-monitor',find:async(session,now)=>{
    if(!enabled)return [];
    const {rows}=await session.query<{id:string}>(`SELECT w.id FROM workspaces w WHERE EXISTS
      (SELECT 1 FROM sourcing_candidates c WHERE c.workspace_id=w.id AND c.status='kept' AND c.next_source_check_at<=$1::timestamptz)
      ORDER BY w.id`,[now]);
    const jobs:JobSpecification[]=[];
    const hour=new Date(now).toISOString().slice(0,13);
    for(const row of rows){
      const ctx=repositoryContext(workspaceScope(row.id,{kind:'system',component:'scheduler'}),session);
      if(!(await readResearchSettings(ctx)).enabled)continue;
      if((await listApplicableHolds(ctx,{actionKind:'research'})).length>0)continue;
      jobs.push({workspaceId:row.id,kind:'sourcing.monitor',idempotencyKey:jobIdempotencyKey.sourcingMonitor(row.id,hour),payload:{},maxAttempts:2});
    }
    return jobs;
  }};
}
