import {z} from 'zod';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {recordCrmAuditEvent} from '@fss/domain/crm/audit.ts';
import {lockApolloAccount,validApolloReference} from '@fss/domain/sourcing/apolloAllowance.ts';
import type {AdminInvocation,AdminOutcome} from './admin.ts';

const reference=z.string().refine(validApolloReference);
const base={'--workspace-id':z.uuid(),'--account-ref':reference,'--key-ref':reference};
const configureSchema=z.strictObject({...base,'--action':z.literal('configure'),'--enabled':z.enum(['true','false']),
 '--cycle-start':z.iso.datetime({offset:true}),'--cycle-end':z.iso.datetime({offset:true}),
 '--verified-at':z.iso.datetime({offset:true}),'--exclusive-attested-at':z.iso.datetime({offset:true}),
 '--prior-used':z.coerce.number().int().min(0).max(75),
 '--exclusive-account-confirmed':z.literal('true'),'--key-account-binding-confirmed':z.literal('true'),
 '--free-plan-no-trial-no-paid-confirmed':z.literal('true'),'--external-usage-reconciled':z.literal('true'),
});
const optionsSchema=z.discriminatedUnion('--action',[
 configureSchema,z.strictObject({...base,'--action':z.literal('disable')}),
 z.strictObject({...base,'--action':z.literal('reconcile'),'--attempt-id':z.uuid(),'--count-spent-confirmed':z.literal('true')}),
]);
const refuse=(reason:string,detail:string):AdminOutcome=>({ok:false,reason,detail});
/** Audited ECS admin operation only. No secret values accepted or read.
 * References must be operator-bound to the actual exclusive account and scoped key.
 * A point-in-time 0/75 screenshot alone is not an exclusive-use assurance.
 */
export async function apolloDiscoveryConfigureCommand(input:Pick<AdminInvocation,'session'|'options'|'launch'>):Promise<AdminOutcome>{
 const parsed=optionsSchema.safeParse(input.options);
 if(!parsed.success)return refuse('invalid_options','Supply opaque account/key references and explicit Free-only, exclusive-use, real-cycle and reconciled usage attestations. Never supply a secret.');
 const launch=input.launch;
 if(!launch?.launchedBy?.startsWith('arn:aws:')||!launch.taskArn?.startsWith('arn:aws:ecs:'))return refuse('launcher_unknown','Run through the audited ECS operations task.');
 const db=input.session,o=parsed.data;
 return withTransaction(db,async()=>{
  await lockApolloAccount(db,o['--account-ref']);
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('apollo-free-key:'||$1,0))",[o['--key-ref']]);
  const rows=(await db.query<{id:string;workspace_id:string;key_ref:string;cycle_start:Date;cycle_end:Date;starting_used:number;reserved:number;halted:boolean}>(`SELECT id,workspace_id,key_ref,cycle_start,cycle_end,starting_used,reserved,halted FROM sourcing_apollo_allowances WHERE account_ref=$1 ORDER BY cycle_start DESC FOR UPDATE`,[o['--account-ref']])).rows;
  const clock=(await db.query<{at:Date}>('SELECT clock_timestamp() AS at')).rows[0]!.at;
  const ctx=repositoryContext(workspaceScope(o['--workspace-id'],{kind:'system',component:'worker'}),db);
  const audit=async(action:string,id:string,detail:Readonly<Record<string,unknown>>)=>recordCrmAuditEvent(ctx,{action,subjectKind:'sourcing_apollo_allowance',subjectId:id,detail:{...detail,launchedBy:launch.launchedBy,taskArn:launch.taskArn}});
  if(!(await db.query('SELECT id FROM workspaces WHERE id=$1',[o['--workspace-id']])).rows.length)return refuse('workspace_unknown','No workspace has that id.');
  if(o['--action']!=='configure'){
   const row=rows.find(r=>r.workspace_id===o['--workspace-id']&&r.key_ref===o['--key-ref']);
   if(!row)return refuse('binding_unknown','No allowance matches this workspace/account/key binding.');
   if(o['--action']==='disable'){
    await db.query('UPDATE sourcing_apollo_allowances SET enabled=false WHERE id=$1',[row.id]);
    await audit('sourcing.apollo_disabled',row.id,{usagePreserved:true});
    return {ok:true,value:{enabled:false,usagePreserved:true}};
   }
   const attempt=(await db.query<{id:string;state:string}>(`SELECT id,state FROM sourcing_apollo_attempts WHERE id=$1 AND workspace_id=$2 AND allowance_id=$3 FOR UPDATE`,[o['--attempt-id'],o['--workspace-id'],row.id])).rows[0];
   if(!attempt||attempt.state==='complete')return refuse('attempt_not_unresolved','Reconcile only an unresolved reserved, failed or unknown attempt.');
   await db.query("UPDATE sourcing_apollo_attempts SET state='failed',failure_code='operator_reconciled_spent',finished_at=clock_timestamp() WHERE id=$1",[attempt.id]);
   await db.query('UPDATE sourcing_apollo_allowances SET halted=true,enabled=false WHERE id=$1',[row.id]);
   await audit('sourcing.apollo_reconciled',row.id,{attemptId:attempt.id,countedSpent:true,haltPreserved:true});
   return {ok:true,value:{countedSpent:true,haltPreserved:true,enabled:false}};
  }
  const start=new Date(o['--cycle-start']),end=new Date(o['--cycle-end']),verified=new Date(o['--verified-at']),attested=new Date(o['--exclusive-attested-at']);
  if(!(start<=clock&&clock<end&&start<=verified&&verified<=clock&&start<=attested&&attested<=clock&&clock.getTime()-verified.getTime()<=86400000&&clock.getTime()-attested.getTime()<=86400000))return refuse('cycle_not_current','Require the real current cycle and verification/exclusive attestation within the last day, evaluated after locks.');
  // Exact same cycle can only toggle enabled. No replay may change counters,
  // account binding, cycle end, verification or the original attestation.
  const same=rows.find(r=>r.cycle_start.getTime()===start.getTime());
  if(same){
   if(same.workspace_id!==o['--workspace-id']||same.key_ref!==o['--key-ref']||same.cycle_end.getTime()!==end.getTime()||same.starting_used!==o['--prior-used'])return refuse('cycle_replay_conflict','Existing cycle identity, dates and starting usage are immutable.');
   if(same.halted&&o['--enabled']==='true')return refuse('account_halted','A halt cannot be reset or refunded, even after reconciliation.');
   await db.query('UPDATE sourcing_apollo_allowances SET enabled=$2 WHERE id=$1',[same.id,o['--enabled']==='true']);
   await audit('sourcing.apollo_configured',same.id,{enabled:o['--enabled']==='true',usagePreserved:true,freeOnly:true,exclusiveAccount:true,keyAccountBound:true,externalUsageReconciled:true});
   return {ok:true,value:{allowanceId:same.id,enabled:o['--enabled']==='true',usagePreserved:true}};
  }
  if(rows.some(r=>start<r.cycle_end&&r.cycle_start<end))return refuse('cycle_overlap','Account-wide cycles cannot overlap across workspaces or keys.');
  if(rows.some(r=>clock<r.cycle_end||start<r.cycle_end))return refuse('prior_cycle_not_ended','A new cycle is explicit and only starts after the real prior cycle ends.');
  const unresolved=(await db.query(`SELECT a.id FROM sourcing_apollo_attempts a JOIN sourcing_apollo_allowances l ON l.id=a.allowance_id WHERE l.account_ref=$1 AND a.state<>'complete' AND COALESCE(a.failure_code,'')<>'operator_reconciled_spent' LIMIT 1`,[o['--account-ref']])).rows.length>0;
  if(unresolved)return refuse('prior_attempt_unresolved','Reconcile prior unknown/failed attempts as spent before a new cycle.');
  const conflicting=(await db.query(`SELECT id FROM sourcing_apollo_allowances WHERE key_ref=$1 AND account_ref<>$2 LIMIT 1`,[o['--key-ref'],o['--account-ref']])).rows.length>0;
  if(conflicting)return refuse('key_binding_conflict','The key reference is already bound to a different account.');
  const inserted=(await db.query<{id:string}>(`INSERT INTO sourcing_apollo_allowances(workspace_id,account_ref,key_ref,cycle_start,cycle_end,verified_at,exclusive_attested_at,starting_used,enabled) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,[o['--workspace-id'],o['--account-ref'],o['--key-ref'],start,end,verified,attested,o['--prior-used'],o['--enabled']==='true'])).rows[0]!;
  await audit('sourcing.apollo_configured',inserted.id,{enabled:o['--enabled']==='true',startingUsed:o['--prior-used'],cycleLimit:75,freeOnly:true,exclusiveAccount:true,keyAccountBound:true,externalUsageReconciled:true,globalVendorQuotaGuaranteed:false});
  return {ok:true,value:{allowanceId:inserted.id,enabled:o['--enabled']==='true',cycleLimit:75,globalVendorQuotaGuaranteed:false}};
 });
}
