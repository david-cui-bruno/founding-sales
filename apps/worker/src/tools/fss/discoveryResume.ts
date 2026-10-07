import {z} from 'zod';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {recordCrmAuditEvent} from '@fss/domain/crm/audit.ts';
import type {AdminInvocation,AdminOutcome} from './admin.ts';
const schema=z.object({
 '--workspace-id':z.uuid(),'--observed-at':z.iso.datetime(),
 '--provider-month-used':z.coerce.number().int().min(0),
 '--provider-month-limit':z.coerce.number().int().positive(),
 '--expected-month-used':z.coerce.number().int().min(0),
});
/** Resume only after an operator has checked provider usage. Never refunds a reserved
 * request, retries an old attempt, enables a workspace, or changes mail settings. */
export async function discoveryResumeCommand(input:Pick<AdminInvocation,'session'|'options'|'launch'>):Promise<AdminOutcome>{
 const parsed=schema.safeParse(input.options);
 if(!parsed.success)return {ok:false,reason:'invalid_options',detail:'Supply workspace, recent provider usage and the expected local monthly counter.'};
 const launch=input.launch;
 if(!launch?.launchedBy?.startsWith('arn:aws:')||!launch.taskArn?.startsWith('arn:aws:ecs:'))return {ok:false,reason:'launcher_unknown',detail:'Run through the audited ECS operations task.'};
 const o=parsed.data,db=input.session;
 return await withTransaction(db,async()=>{
  if(!(await db.query('SELECT id FROM workspaces WHERE id=$1',[o['--workspace-id']])).rows.length)return {ok:false,reason:'workspace_unknown',detail:'Workspace not found.'};
  const a=(await db.query<{halted:boolean;monthly_used:number;daily_used:number;current_month:boolean;current_day:boolean;fresh:boolean}>(`SELECT halted,monthly_used,daily_used,month=date_trunc('month',now() AT TIME ZONE 'UTC')::date AS current_month,day=(now() AT TIME ZONE 'UTC')::date AS current_day,($1::timestamptz BETWEEN now()-interval '10 minutes' AND now()) AND date_trunc('month',$1::timestamptz AT TIME ZONE 'UTC')=date_trunc('month',now() AT TIME ZONE 'UTC') AS fresh FROM sourcing_search_account WHERE id=true FOR UPDATE`,[o['--observed-at']])).rows[0];
  if(!a)return {ok:false,reason:'account_not_configured',detail:'Configure the shared account first.'};
  if(!a.fresh||!a.current_month||a.monthly_used!==o['--expected-month-used'])return {ok:false,reason:'usage_changed',detail:'Read current usage again before resuming.'};
  if((await db.query("SELECT id FROM sourcing_discovery_attempts WHERE state='dispatched' LIMIT 1")).rows.length)return {ok:false,reason:'dispatch_unresolved',detail:'Resolve the outstanding dispatch before resuming.'};
  const monthly=Math.max(a.monthly_used,o['--provider-month-used']);
  const daily=(a.current_day?a.daily_used:0)+Math.max(0,monthly-a.monthly_used);
  if(monthly>=Math.min(600,o['--provider-month-limit'])||daily>=20)return {ok:false,reason:'quota_exhausted',detail:'No allowance remains under the existing caps.'};
  if(!a.halted)return {ok:true,value:{resumed:false,alreadyRunning:true}};
  await db.query("UPDATE sourcing_search_account SET halted=false,monthly_used=$1,daily_used=$2,day=(now() AT TIME ZONE 'UTC')::date WHERE id=true",[monthly,daily]);
  await recordCrmAuditEvent(repositoryContext(workspaceScope(o['--workspace-id'],{kind:'system',component:'worker'}),db),{action:'sourcing.discovery_resumed',subjectKind:'workspace',subjectId:o['--workspace-id'],detail:{observedAt:o['--observed-at'],providerMonthUsed:o['--provider-month-used'],providerMonthLimit:o['--provider-month-limit'],previousMonthlyUsed:a.monthly_used,monthlyUsed:monthly,dailyUsed:daily,launchedBy:launch.launchedBy,taskArn:launch.taskArn}});
  return {ok:true,value:{resumed:true,monthlyUsed:monthly,dailyUsed:daily}};
 });
}
