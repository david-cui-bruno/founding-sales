import {queueWeeklySocialDrafts} from '@fss/domain/social/weekly.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {expireSocialDraftRequests} from '@fss/domain/social/drafts.ts';
import {runSocialDraft,type SocialDraftPort} from '@fss/domain/social/draftRun.ts';
import type {JobHandler} from '@fss/domain/jobs/handlerRegistry.ts';
import type {JobSpecification} from '@fss/domain/jobs/jobStore.ts';
import type {DueWorkSource} from '../scheduler/schedulerPass.ts';
export function socialDraftHandler(port:SocialDraftPort|null):JobHandler{return {
 kind:'social.draft',protection:'outbound_fence',maxAttempts:1,leaseSeconds:180,
 handle:async input=>{const id=input.job.payload['requestId'];if(typeof id!=='string')return;await runSocialDraft(repositoryContext(input.scope,input.session),id,port);},
};}
/** Manual requests and explicit weekly opt-ins; expiry also runs while disabled. */
export function socialDraftSource(enabled:boolean):DueWorkSource{return {name:'social-drafts',find:async(session,at)=>{
 const workspaces=(await session.query<{workspace_id:string}>("SELECT workspace_id FROM social_draft_requests WHERE state IN ('queued','calling') GROUP BY workspace_id UNION SELECT workspace_id FROM social_weekly_settings WHERE enabled AND next_at<=now() ORDER BY workspace_id LIMIT 25")).rows;
 const jobs:JobSpecification[]=[];
 for(const {workspace_id:workspace} of workspaces){
  const ctx=repositoryContext(workspaceScope(workspace,{kind:'system',component:'scheduler'}),session);
  await expireSocialDraftRequests(ctx);
  if(!enabled)continue;
  await queueWeeklySocialDrafts(ctx);
  const rows=(await session.query<{id:string;paid_attempts:number}>("SELECT id,paid_attempts FROM social_draft_requests WHERE workspace_id=$1 AND state='queued' AND deadline_at>now() AND paid_attempts<2 ORDER BY created_at,id LIMIT 25",[workspace])).rows;
  for(const row of rows)jobs.push({workspaceId:workspace,kind:'social.draft',idempotencyKey:`social-draft:${row.id}:${row.paid_attempts}:${at.slice(0,16)}`,payload:{requestId:row.id},maxAttempts:1});
 }
 return jobs;
}};}
