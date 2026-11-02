import {repositoryContext} from '@fss/domain/db/workspaceScope.ts';
import type {JobHandler} from '@fss/domain/jobs/handlerRegistry.ts';
import type {JobSpecification} from '@fss/domain/jobs/jobStore.ts';
import {jobIdempotencyKey} from '@fss/domain/jobs/jobKinds.ts';
import type {EmailVerifier} from '@fss/domain/outreach/emailVerification.ts';
import {runPreparedEmailAdmission} from '@fss/domain/outreach/preparedEmailAdmission.ts';
import type {DueWorkSource} from '../scheduler/schedulerPass.ts';
import type {Logger} from '../bootstrap/log.ts';

/** ADR0035. The domain owns every check, lock and commit. The DNS check runs inside the runner's transaction but before any admission
 * lock, exactly like the route-validation lookup, and a recorded answer is not asked again inside its window. */
export function preparedEmailAdmitHandler(deps:{verifier:EmailVerifier;log?:Logger}):JobHandler {
 return {kind:'outreach.email_admit',protection:'outbound_fence',maxAttempts:1,leaseSeconds:120,
  handle:async input=>{
   const pass=await runPreparedEmailAdmission(repositoryContext(input.scope,input.session),{verifier:deps.verifier});
   // Counts only: no address, company or provider text.
   if(deps.log&&(pass.admitted||pass.checked||pass.failed))try{deps.log.log(pass.failed?'warn':'info','prepared_email_admission',{admitted:pass.admitted,checked:pass.checked,failed:pass.failed});}catch{ /* A log sink cannot change admission custody. */ }
  }};
}

/** One pass per workspace every ten minutes while an unrevoked, unexpired campaign has lifetime and daily room. */
export function preparedEmailAdmitSource():DueWorkSource {
 return {name:'prepared-email-admission',find:async(session,now)=>{
  const rows=(await session.query<{workspace_id:string}>(`SELECT DISTINCT c.workspace_id FROM outreach_email_campaigns c
   WHERE c.revoked_at IS NULL AND c.expires_at>$1::timestamptz
   AND (SELECT count(*) FROM outreach_email_campaign_admissions a WHERE a.workspace_id=c.workspace_id AND a.campaign_id=c.id)<c.max_enrollments
   AND (SELECT count(*) FROM outreach_email_campaign_admissions a JOIN outreach_email_campaigns d ON d.workspace_id=a.workspace_id AND d.id=a.campaign_id
    WHERE a.workspace_id=c.workspace_id AND d.owner_user_id=c.owner_user_id AND (a.admitted_at AT TIME ZONE 'UTC')::date=($1::timestamptz AT TIME ZONE 'UTC')::date)<c.daily_admission_limit
   ORDER BY 1 LIMIT 25`,[now])).rows;
  return rows.map((row):JobSpecification=>({workspaceId:row.workspace_id,kind:'outreach.email_admit',idempotencyKey:jobIdempotencyKey.outreachEmailAdmit(row.workspace_id,now),payload:{},maxAttempts:1}));
 }};
}
