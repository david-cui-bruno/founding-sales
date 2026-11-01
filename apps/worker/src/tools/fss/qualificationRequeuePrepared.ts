import {z} from 'zod';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {recordCrmAuditEvent} from '@fss/domain/crm/audit.ts';
import {requestQualification} from '@fss/domain/sourcing/qualificationStore.ts';
import {BUSINESS_JUDGMENT_MODELS} from '@fss/domain/sourcing/qualificationModel.ts';
import type {AdminInvocation,AdminOutcome} from './admin.ts';
const optionsSchema=z.strictObject({'--report':z.string().optional(),'--workspace-id':z.uuid(),'--approval-ref':z.string().trim().min(1).max(200),
 '--limit':z.string().regex(/^[1-9][0-9]*$/u).transform(Number).pipe(z.number().int().min(1).max(1000)).optional()});
/** Refusals that hold for every later candidate today: stop rather than spend the batch on them. */
const STOPS:readonly string[]=['daily_firm_ceiling','research_disabled','research_held'];
/**
 * One-time re-qualification of current prepared candidates under the business judgment (David, 1 November 2026): every
 * candidate whose latest prepared-capture run was made by a model without it (`BUSINESS_JUDGMENT_MODELS`) is requested
 * again through `requestQualification`, so research enabled/holds, the daily firm ceiling and, at run time, the money
 * ceilings bound it exactly like the scheduler. Rerun on later days for the remainder; a requested run is not selected
 * again. `--dry-run` only counts. Never changes ceilings, quotas, sending, contact or admission.
 */
export async function qualificationRequeuePreparedCommand(input:Pick<AdminInvocation,'session'|'options'|'switches'|'launch'>):Promise<AdminOutcome>{
 const parsed=optionsSchema.safeParse(input.options);
 if(!parsed.success)return {ok:false,reason:'invalid_options',detail:'Supply the workspace, the approval reference and an optional limit of 1 to 1000.'};
 const launch=input.launch;
 if(!launch?.launchedBy?.startsWith('arn:aws:')||!launch.taskArn?.startsWith('arn:aws:ecs:'))return {ok:false,reason:'launcher_unknown',detail:'Run through the audited ECS operations task.'};
 const o=parsed.data,w=o['--workspace-id'],limit=o['--limit']??1000,dryRun=input.switches.has('--dry-run'),db=input.session,models=[...BUSINESS_JUDGMENT_MODELS];
 return await withTransaction(db,async()=>{
  const ctx=repositoryContext(workspaceScope(w,{kind:'system',component:'worker'}),db);
  const due=(await db.query<{id:string;revision:number}>(`SELECT c.id,c.revision FROM sourcing_candidates c
   JOIN LATERAL(SELECT r.requested_at,r.model_name,r.state,r.capture_policy_version FROM sourcing_qualification_runs r WHERE r.workspace_id=c.workspace_id AND r.candidate_id=c.id ORDER BY r.requested_at DESC,r.id DESC LIMIT 1) last ON true
   WHERE c.workspace_id=$1 AND c.payload->>'kind' IS DISTINCT FROM 'discovery-v1' AND c.status<>'dismissed' AND NOT c.qualification_blocked
    AND NOT EXISTS(SELECT 1 FROM sourcing_retained_identity_decisions d WHERE d.workspace_id=c.workspace_id AND d.candidate_id=c.id)
    AND last.capture_policy_version IS NOT NULL AND last.state NOT IN ('pending','running') AND last.model_name<>ALL($2::text[])
   ORDER BY c.status<>'kept',last.requested_at,c.id`,[w,models])).rows;
  if(dryRun)return {ok:true,value:{dryRun:true,eligible:due.length,limit,judgmentModels:models}};
  const refusals:Record<string,number>={};let requested=0,stoppedBy:string|null=null;
  for(const candidate of due.slice(0,limit)){
   const queued=await requestQualification(ctx,{candidateId:candidate.id,expectedRevision:candidate.revision});
   if(queued.ok){requested++;continue;}
   if(STOPS.includes(queued.reason)){stoppedBy=queued.reason;break;}
   refusals[queued.reason]=(refusals[queued.reason]??0)+1;
  }
  const value={dryRun:false,eligible:due.length,limit,requested,stoppedBy,refusals,remaining:due.length-requested-Object.values(refusals).reduce((a,b)=>a+b,0),judgmentModels:models};
  await recordCrmAuditEvent(ctx,{action:'sourcing.qualification_requeued',subjectKind:'workspace',subjectId:w,detail:{...value,approvalRef:o['--approval-ref'],launchedBy:launch.launchedBy,taskArn:launch.taskArn}});
  return {ok:true,value};
 });
}
