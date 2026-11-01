import {z} from 'zod';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {recordCrmAuditEvent} from '@fss/domain/crm/audit.ts';
import {lockResearchBudget} from '@fss/domain/research/ceilings.ts';
import {readResearchSettings,updateResearchSettings} from '@fss/domain/research/settings.ts';
import type {AdminInvocation,AdminOutcome} from './admin.ts';
const count=(maximum:number)=>z.string().regex(/^(0|[1-9][0-9]*)$/u).transform(Number).pipe(z.number().int().min(0).max(maximum));
const optionsSchema=z.strictObject({'--report':z.string().optional(),'--workspace-id':z.uuid(),'--owner-user-id':z.uuid(),'--daily-cents':count(1000000),'--monthly-cents':count(10000000),
 '--daily-firms':count(10000).optional(),'--approval-ref':z.string().trim().min(1).max(200).optional()});
class CeilingRefusal extends Error{constructor(readonly reason:string){super(reason);}}
/** Set research money ceilings and, optionally, the daily firm ceiling through the existing owner.
 * Lowering needs only the audited launcher and a current admin; any increase also needs a recorded approval reference.
 * Never enables research or changes model, pages, search or sending controls. */
export async function researchSetCeilingsCommand(input:Pick<AdminInvocation,'session'|'options'|'launch'>):Promise<AdminOutcome>{
 const options=optionsSchema.safeParse(input.options);
 if(!options.success)return {ok:false,reason:'invalid_options',detail:'Supply workspace, active administrator, nonnegative integer daily/monthly cents, optional daily firms and approval reference.'};
 const launch=input.launch;
 if(!launch?.launchedBy?.startsWith('arn:aws:')||!launch.taskArn?.startsWith('arn:aws:ecs:'))return {ok:false,reason:'launcher_unknown',detail:'Run through the audited ECS operations task.'};
 const o=options.data,w=o['--workspace-id'],owner=o['--owner-user-id'],approvalRef=o['--approval-ref']??null;
 try{return await withTransaction(input.session,async()=>{
  const ctx=repositoryContext(workspaceScope(w,{kind:'user',userId:owner,role:'admin'}),input.session);
  const member=()=>input.session.query("SELECT user_id FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 AND status='active' AND role='admin' FOR SHARE",[w,owner]);
  if(!(await member()).rows.length)throw new CeilingRefusal('owner_inactive');
  await lockResearchBudget(ctx);
  const configured=await input.session.query('SELECT workspace_id FROM research_settings WHERE workspace_id=$1 FOR UPDATE',[w]);
  if(!configured.rows.length)throw new CeilingRefusal('settings_unconfigured');
  const settings=await readResearchSettings(ctx);
  const before={dailyCents:settings.dailyCostCeilingCents,monthlyCents:settings.monthlyCostCeilingCents,dailyFirms:settings.dailyFirmCeiling};
  const after={dailyCents:o['--daily-cents'],monthlyCents:o['--monthly-cents'],dailyFirms:o['--daily-firms']??before.dailyFirms};
  if(approvalRef===null&&(after.dailyCents>before.dailyCents||after.monthlyCents>before.monthlyCents||after.dailyFirms>before.dailyFirms))throw new CeilingRefusal('ceiling_increase_unapproved');
  const updated=await updateResearchSettings(ctx,{dailyCostCeilingCents:after.dailyCents,monthlyCostCeilingCents:after.monthlyCents,...(o['--daily-firms']===undefined?{}:{dailyFirmCeiling:after.dailyFirms})});if(!updated.ok)throw new CeilingRefusal(updated.reason);
  await recordCrmAuditEvent(ctx,{action:'research.ceilings_set',subjectKind:'workspace',subjectId:w,detail:{before,after,approvalRef,ownerUserId:owner,launchedBy:launch.launchedBy,taskArn:launch.taskArn}});
  if(!(await member()).rows.length)throw new CeilingRefusal('owner_inactive');
  return {ok:true,value:after};
 });}catch(error){if(error instanceof CeilingRefusal)return {ok:false,reason:error.reason,detail:'The research ceiling operation was refused and rolled back.'};throw error;}
}
