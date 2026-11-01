import {z} from 'zod';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {recordCrmAuditEvent} from '@fss/domain/crm/audit.ts';
import {lockResearchBudget} from '@fss/domain/research/ceilings.ts';
import {readResearchSettings,updateResearchSettings} from '@fss/domain/research/settings.ts';
import type {AdminInvocation,AdminOutcome} from './admin.ts';
const cents=(maximum:number)=>z.string().regex(/^(0|[1-9][0-9]*)$/u).transform(Number).pipe(z.number().int().min(0).max(maximum));
const optionsSchema=z.strictObject({'--report':z.string().optional(),'--workspace-id':z.uuid(),'--owner-user-id':z.uuid(),'--daily-cents':cents(1000000),'--monthly-cents':cents(10000000)});
class CeilingRefusal extends Error{constructor(readonly reason:string){super(reason);}}
/** Lower money ceilings through the existing owner; never enable or change research scope. */
export async function researchLowerCeilingsCommand(input:Pick<AdminInvocation,'session'|'options'|'launch'>):Promise<AdminOutcome>{
 const options=optionsSchema.safeParse(input.options);
 if(!options.success)return {ok:false,reason:'invalid_options',detail:'Supply workspace, active administrator and nonnegative integer daily/monthly cents.'};
 const launch=input.launch;
 if(!launch?.launchedBy?.startsWith('arn:aws:')||!launch.taskArn?.startsWith('arn:aws:ecs:'))return {ok:false,reason:'launcher_unknown',detail:'Run through the audited ECS operations task.'};
 const o=options.data,w=o['--workspace-id'],owner=o['--owner-user-id'];
 try{return await withTransaction(input.session,async()=>{
  const ctx=repositoryContext(workspaceScope(w,{kind:'user',userId:owner,role:'admin'}),input.session);
  const member=()=>input.session.query("SELECT user_id FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 AND status='active' AND role='admin' FOR SHARE",[w,owner]);
  if(!(await member()).rows.length)throw new CeilingRefusal('owner_inactive');
  await lockResearchBudget(ctx);
  const configured=await input.session.query('SELECT workspace_id FROM research_settings WHERE workspace_id=$1 FOR UPDATE',[w]);
  if(!configured.rows.length)throw new CeilingRefusal('settings_unconfigured');
  const before=await readResearchSettings(ctx),daily=o['--daily-cents'],monthly=o['--monthly-cents'];
  if(daily>before.dailyCostCeilingCents||monthly>before.monthlyCostCeilingCents)throw new CeilingRefusal('ceiling_increase_refused');
  const updated=await updateResearchSettings(ctx,{dailyCostCeilingCents:daily,monthlyCostCeilingCents:monthly});if(!updated.ok)throw new CeilingRefusal(updated.reason);
  await recordCrmAuditEvent(ctx,{action:'research.ceilings_lowered',subjectKind:'workspace',subjectId:w,detail:{before:{dailyCents:before.dailyCostCeilingCents,monthlyCents:before.monthlyCostCeilingCents},after:{dailyCents:daily,monthlyCents:monthly},ownerUserId:owner,launchedBy:launch.launchedBy,taskArn:launch.taskArn}});
  if(!(await member()).rows.length)throw new CeilingRefusal('owner_inactive');
  return {ok:true,value:{dailyCents:daily,monthlyCents:monthly}};
 });}catch(error){if(error instanceof CeilingRefusal)return {ok:false,reason:error.reason,detail:'The research ceiling operation was refused and rolled back.'};throw error;}
}
