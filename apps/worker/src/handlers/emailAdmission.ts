import {repositoryContext,type RepositoryContext} from '@fss/domain/db/workspaceScope.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {admitAutomaticEmailCandidate,type AutomaticEmailInput} from '@fss/domain/outreach/automaticEmail.ts';
export type {AutomaticEmailInput};
/** Single-prospect entry; scheduling and activation are separate releases. */
export async function admitAutomaticEmailProspect(ctx:RepositoryContext,input:AutomaticEmailInput){
 return withTransaction(ctx.db,()=>admitAutomaticEmailCandidate(ctx,input));
}

import {findAutomaticEmailWorkspaces,runAutomaticEmailBatch} from '@fss/domain/outreach/emailAdmissionBatch.ts';
export {runAutomaticEmailBatch};

import type {JobHandler} from '@fss/domain/jobs/handlerRegistry.ts';
import {jobIdempotencyKey} from '@fss/domain/jobs/jobKinds.ts';
import type {DueWorkSource} from '../scheduler/schedulerPass.ts';
export function automaticEmailHandler():JobHandler{
 return {kind:'outreach.email_admit',protection:'outbound_fence',maxAttempts:3,leaseSeconds:180,handle:async input=>{
  const revision=input.job.payload['controlRevision'];
  if(typeof revision!=='number'||!Number.isSafeInteger(revision)||revision<1)return;
  await runAutomaticEmailBatch(repositoryContext(input.scope,input.session),revision);
 }};
}
/** One live workspace job, at most hourly. No provider or research reservation. */
export function automaticEmailSource():DueWorkSource{
 return {name:'automatic-email-admission',find:async(session,now)=>{
  const rows=await findAutomaticEmailWorkspaces(session,now);
  for(const row of rows)await session.query('UPDATE outreach_email_admission_settings SET batch_last_at=$2 WHERE workspace_id=$1',[row.workspace_id,now]);
  return rows.map(row=>({workspaceId:row.workspace_id,kind:'outreach.email_admit',idempotencyKey:jobIdempotencyKey.automaticEmail(row.revision,now),payload:{controlRevision:row.revision},maxAttempts:3}));
 }};
}
