import {z} from 'zod';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {readModelTransport} from '@fss/domain/classification/modelTransport.ts';
import {readDailyCounter} from '@fss/domain/jobs/counters.ts';
import {RESEARCH_FIRM_RUN_COUNTER} from '@fss/domain/research/ceilings.ts';
import {readResearchSpend,workspaceBusinessZone} from '@fss/domain/research/ledger.ts';
import {isPricedModel,worstCaseRunCents} from '@fss/domain/research/pricing.ts';
import {readResearchSettings} from '@fss/domain/research/settings.ts';
import type {AdminInvocation,AdminOutcome} from './admin.ts';
const optionsSchema=z.strictObject({'--report':z.string().optional(),'--workspace-id':z.uuid()});
/** `fss admin research status`: what research and discovery may still spend today, before an
 * operator sets ceilings or configures discovery. One READ ONLY transaction, rolled back; no launcher,
 * because it decides and changes nothing. */
export async function researchStatusCommand(input:Pick<AdminInvocation,'session'|'options'|'environment'>):Promise<AdminOutcome>{
 const options=optionsSchema.safeParse(input.options);
 if(!options.success)return {ok:false,reason:'invalid_options',detail:'Supply --workspace-id.'};
 const transport=readModelTransport(input.environment).kind;
 if(transport===null)return {ok:false,reason:'model_transport_invalid',detail:'FSS_MODEL_TRANSPORT names no known transport.'};
 const w=options.data['--workspace-id'],db=input.session;
 await db.query('BEGIN TRANSACTION READ ONLY');
 try{
  if(!(await db.query('SELECT id FROM workspaces WHERE id=$1',[w])).rows.length)return {ok:false,reason:'workspace_unknown',detail:'No workspace has that id.'};
  const ctx=repositoryContext(workspaceScope(w,{kind:'system',component:'worker'}),db);
  const at=(await db.query<{at:Date}>('SELECT now() AS at')).rows[0]!.at.toISOString(),businessTimeZone=await workspaceBusinessZone(ctx);
  const configured=(await db.query('SELECT 1 FROM research_settings WHERE workspace_id=$1',[w])).rows.length>0,settings=await readResearchSettings(ctx);
  const firmRunsToday=await readDailyCounter(ctx,{subjectKind:'workspace',subjectKey:w,counterKind:RESEARCH_FIRM_RUN_COUNTER,businessTimeZone,at});
  const discovery=(await db.query<Record<string,unknown>>('SELECT enabled,searches_per_day,next_run_at,last_result,qualification_wait_reason FROM sourcing_discovery_settings WHERE workspace_id=$1',[w])).rows[0]??null;
  const account=(await db.query<Record<string,unknown>>('SELECT halted,daily_used,monthly_used,day,month FROM sourcing_search_account')).rows[0]??null;
  return {ok:true,value:{at,businessTimeZone,transport,
   research:{configured,enabled:settings.enabled,modelName:settings.modelName,modelPriced:isPricedModel(settings.modelName,transport),maxPagesPerFirm:settings.maxPagesPerFirm,maxPageBytes:settings.maxPageBytes,
    dailyFirmCeiling:settings.dailyFirmCeiling,firmRunsToday,dailyCostCeilingCents:settings.dailyCostCeilingCents,monthlyCostCeilingCents:settings.monthlyCostCeilingCents,
    spend:await readResearchSpend(ctx,{businessTimeZone,at}),worstCaseRunCents:worstCaseRunCents({modelName:settings.modelName,transport,maxPagesPerFirm:settings.maxPagesPerFirm,maxPageBytes:settings.maxPageBytes})},
   discovery,searchAccount:account}};
 }finally{await db.query('ROLLBACK');}
}
