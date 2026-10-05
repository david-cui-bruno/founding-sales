import {z} from 'zod';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {recordCrmAuditEvent} from '@fss/domain/crm/audit.ts';
import type {AdminInvocation,AdminOutcome} from './admin.ts';
const optionsSchema=z.object({
 '--workspace-id':z.uuid(),'--enabled':z.enum(['true','false']),
 '--prior-day':z.iso.date(),'--prior-day-used':z.coerce.number().int().min(0),
 '--prior-month-used':z.coerce.number().int().min(0),
});
/** First bootstrap reconciles external evaluation usage. Existing counters and halts
 * are never reset by enable/replay. This command contains no provider/secret access. */
export async function discoveryConfigureCommand(input:Pick<AdminInvocation,'session'|'options'|'launch'>):Promise<AdminOutcome>{
 const parsed=optionsSchema.safeParse(input.options);
 if(!parsed.success)return {ok:false,reason:'invalid_options',detail:'Supply workspace, enabled, and reconciled prior usage date/counts.'};
 const launch=input.launch;
 if(!launch?.launchedBy?.startsWith('arn:aws:')||!launch.taskArn?.startsWith('arn:aws:ecs:'))return {ok:false,reason:'launcher_unknown',detail:'Run through the audited ECS operations task.'};
 const o=parsed.data,db=input.session;
 return await withTransaction(db,async()=>{
  if(!(await db.query('SELECT id FROM workspaces WHERE id=$1',[o['--workspace-id']])).rows.length)return {ok:false,reason:'workspace_unknown',detail:'No workspace has that id.'};
  const today=(await db.query<{day:string}>("SELECT to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD') AS day")).rows[0]!.day;
  if(o['--prior-day']>today||o['--prior-day-used']>o['--prior-month-used'])return {ok:false,reason:'invalid_usage',detail:'Usage date cannot be in the future, and daily usage cannot exceed monthly usage.'};
  await db.query('INSERT INTO sourcing_search_account(id,daily_used,monthly_used) VALUES(true,$1,$2) ON CONFLICT DO NOTHING',[o['--prior-day']===today?o['--prior-day-used']:0,o['--prior-day'].slice(0,7)===today.slice(0,7)?o['--prior-month-used']:0]);
  await db.query('INSERT INTO sourcing_discovery_settings(workspace_id,enabled) VALUES($1,$2) ON CONFLICT(workspace_id) DO UPDATE SET enabled=EXCLUDED.enabled',[o['--workspace-id'],o['--enabled']==='true']);
  await recordCrmAuditEvent(repositoryContext(workspaceScope(o['--workspace-id'],{kind:'system',component:'worker'}),db),{action:'sourcing.discovery_configured',subjectKind:'workspace',subjectId:o['--workspace-id'],detail:{enabled:o['--enabled']==='true',launchedBy:launch.launchedBy,taskArn:launch.taskArn}});
  return {ok:true,value:{enabled:o['--enabled']==='true',existingQuotaPreserved:true}};
 });
}
