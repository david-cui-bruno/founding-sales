import {z} from 'zod';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {recordCrmAuditEvent} from '@fss/domain/crm/audit.ts';
import {lockSendGateForStopFact} from '@fss/domain/policy/sendGate.ts';
import {QUALIFICATION_POLICY_VERSION,QUALIFICATION_PROMPT_VERSION} from '@fss/domain/sourcing/qualificationStore.ts';
import type {AdminInvocation,AdminOutcome} from './admin.ts';
const optionsSchema=z.object({
 '--workspace-id':z.uuid(),'--enabled':z.enum(['true','false']),'--owner-user-id':z.uuid().optional(),
 '--evaluation-sha256':z.string().regex(/^[a-f0-9]{64}$/u).optional(),
 '--reviewed-eligible':z.coerce.number().int().positive().optional(),
 '--false-eligible':z.literal('0').optional(),
});
/** Operator attests a reviewed report; models and ordinary qualification jobs cannot activate this. */
export async function qualificationConfigureCommand(input:Pick<AdminInvocation,'session'|'options'|'launch'>):Promise<AdminOutcome>{
 const parsed=optionsSchema.safeParse(input.options);
 if(!parsed.success)return {ok:false,reason:'invalid_options',detail:'Supply workspace and enabled; enabling requires an owner and a reviewed report with zero false eligible results.'};
 const launch=input.launch;
 if(!launch?.launchedBy?.startsWith('arn:aws:')||!launch.taskArn?.startsWith('arn:aws:ecs:'))return {ok:false,reason:'launcher_unknown',detail:'Run through the audited ECS operations task.'};
 const o=parsed.data,enabled=o['--enabled']==='true';
 if(enabled&&(!o['--owner-user-id']||!o['--evaluation-sha256']||!o['--reviewed-eligible']||o['--false-eligible']!=='0'))return {ok:false,reason:'evaluation_required',detail:'Enabling requires the report SHA-256, reviewed eligible count, zero false eligible and an active owner.'};
 return await withTransaction(input.session,async()=>{
  const ctx=repositoryContext(workspaceScope(o['--workspace-id'],{kind:'system',component:'worker'}),input.session);
  if(!(await input.session.query('SELECT id FROM workspaces WHERE id=$1',[o['--workspace-id']])).rows.length)return {ok:false,reason:'workspace_unknown',detail:'No workspace has that id.'};
  await lockSendGateForStopFact(ctx);
  if(o['--owner-user-id']&&!(await input.session.query("SELECT user_id FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 AND status='active' FOR SHARE",[o['--workspace-id'],o['--owner-user-id']])).rows.length)return {ok:false,reason:'owner_inactive',detail:'Choose an active workspace member.'};
  const evaluation=enabled?{policyVersion:QUALIFICATION_POLICY_VERSION,promptVersion:QUALIFICATION_PROMPT_VERSION,reportSha256:o['--evaluation-sha256'],reviewedEligible:o['--reviewed-eligible'],falseEligible:0}:null;
  await input.session.query(`INSERT INTO sourcing_discovery_settings(workspace_id,auto_admission_enabled,owner_user_id,qualification_evaluation) VALUES($1,$2,$3,$4::jsonb)
   ON CONFLICT(workspace_id) DO UPDATE SET auto_admission_enabled=$2,owner_user_id=COALESCE($3,sourcing_discovery_settings.owner_user_id),qualification_evaluation=COALESCE($4::jsonb,sourcing_discovery_settings.qualification_evaluation)`,[o['--workspace-id'],enabled,o['--owner-user-id']??null,evaluation?JSON.stringify(evaluation):null]);
  await recordCrmAuditEvent(ctx,{action:'sourcing.qualification_configured',subjectKind:'workspace',subjectId:o['--workspace-id'],detail:{enabled,ownerUserId:o['--owner-user-id']??null,evaluation,launchedBy:launch.launchedBy,taskArn:launch.taskArn}});
  return {ok:true,value:{enabled,policyVersion:QUALIFICATION_POLICY_VERSION}};
 });
}
