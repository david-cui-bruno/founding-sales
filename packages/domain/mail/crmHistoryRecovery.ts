import {crmMailRecoveryCoverageSchema} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {withTransaction} from '../db/queryable.ts';
import {readBackfillAuthority,type BackfillAuthority} from './crmBackfillAuthority.ts';
import {readBackfillAllocation,type BackfillAllocationVerifier} from './crmBackfillBudget.ts';
import {backfillConfigurationHash} from './crmBackfillWork.ts';
export interface HistoryRecovery extends Record<string,unknown>{id:string;epoch:number;revision:number;state:'pending_profile'|'enumerating'|'draining'|'complete'|'blocked'|'deleted';reason:string|null;configuration_hash:string;allocation_revision:number;from_at:Date|null;to_at:Date|null;history_anchor:string|null;history_cursor:string|null;history_page_token:string|null;total_days:number|null;next_day_ordinal:number;next_day_page_token:string|null}
export async function readHistoryRecovery(context:RepositoryContext,importId:string){
 return (await context.db.query<HistoryRecovery>('SELECT * FROM crm_mail_history_recoveries WHERE workspace_id=$1 AND import_id=$2 ORDER BY epoch DESC LIMIT 1',[context.scope.workspaceId,importId])).rows[0];
}
/** Caller has already authorized the exact import read. Scope is enumeration, not lost event history. */
export async function readHistoryRecoveryCoverage(context:RepositoryContext,importId:string){
 const row=await readHistoryRecovery(context,importId);if(row===undefined)return null;
 return crmMailRecoveryCoverageSchema.parse({kind:'surviving_message_enumeration_and_fresh_history',epoch:row.epoch,state:row.state,originalCursor:'unavailable',fromAt:row.from_at?.toISOString()??null,toAt:row.to_at?.toISOString()??null,windowFrozen:row.history_anchor!==null,totalDays:row.total_days,completedDays:row.next_day_ordinal,historyComplete:row.state==='complete',reason:row.reason});
}
interface RecoveryFence{authority:BackfillAuthority;jobId:string;leaseOwner:string;fencingToken:string}
async function lockedAuthority(context:RepositoryContext,input:RecoveryFence){
 if(context.scope.actor.kind!=='system'||context.scope.actor.component!=='worker')return null;
 if(!(await context.db.query("SELECT id FROM jobs WHERE workspace_id=$1 AND id=$2 AND state='running' AND lease_owner=$3 AND fencing_token=$4::bigint AND lease_expires_at>clock_timestamp() FOR UPDATE",[context.scope.workspaceId,input.jobId,input.leaseOwner,input.fencingToken])).rows.length)return null;
 const current=await readBackfillAuthority(context,input.authority.importId,true);
 return current!==null&&JSON.stringify(current.proof)===JSON.stringify(input.authority.proof)&&current.historyAnchor===input.authority.historyAnchor&&current.toEpochMicroseconds===input.authority.toEpochMicroseconds?current:null;
}
/** Only an actual expired history outcome enters this stage; verification remains outside SQL. */
export async function beginExpiredHistoryRecovery(context:RepositoryContext,input:RecoveryFence,verifier:BackfillAllocationVerifier){
 const allocation=await readBackfillAllocation(context,input.authority.proof.mailboxId);
 if(allocation===null||!await verifier.verify(allocation))return;
 const hash=backfillConfigurationHash(input.authority,allocation);
 await withTransaction(context.db,async()=>{
  const current=await lockedAuthority(context,input);if(current===null)return;
  await context.db.query('SELECT mailbox_id FROM crm_mail_import_allocations WHERE workspace_id=$1 AND mailbox_id=$2 FOR SHARE',[context.scope.workspaceId,current.proof.mailboxId]);
  const live=await readBackfillAllocation(context,current.proof.mailboxId);if(live===null||backfillConfigurationHash(current,live)!==hash)return;
  const last=await readHistoryRecovery(context,current.importId);
  if(last!==undefined&&last.state!=='complete'&&last.state!=='blocked')return;
  const epoch=(last?.epoch??0)+1;if(epoch>4)return;
  await context.db.query(`INSERT INTO crm_mail_history_recoveries(workspace_id,import_id,epoch,account_binding,generation,controls_revision,policy_revision,allocation_revision,configuration_hash,from_at)
   SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE((SELECT to_at FROM crm_mail_history_recoveries WHERE workspace_id=$1 AND import_id=$2 AND state='complete' ORDER BY epoch DESC LIMIT 1),(SELECT to_at FROM crm_mail_imports WHERE workspace_id=$1 AND id=$2))`,[context.scope.workspaceId,current.importId,epoch,current.proof.accountBinding,current.proof.generation,current.proof.controlsRevision,current.proof.policyRevision,live.revision,hash]);
 });
}
/** A paid profile has succeeded, but only this exact locked DB-time freeze defines the gap. */
export async function freezeHistoryRecovery(context:RepositoryContext,input:RecoveryFence&{recovery:HistoryRecovery;historyAnchor:string}){
 if(!/^[0-9]{1,20}$/u.test(input.historyAnchor))return;
 await withTransaction(context.db,async()=>{
  const current=await lockedAuthority(context,input);if(current===null)return;
  await context.db.query('SELECT mailbox_id FROM crm_mail_import_allocations WHERE workspace_id=$1 AND mailbox_id=$2 FOR SHARE',[context.scope.workspaceId,current.proof.mailboxId]);
  const allocation=await readBackfillAllocation(context,current.proof.mailboxId);
  if(allocation===null||allocation.revision!==input.recovery.allocation_revision||backfillConfigurationHash(current,allocation)!==input.recovery.configuration_hash)return;
  await context.db.query(`WITH instant AS(SELECT clock_timestamp() AS at) UPDATE crm_mail_history_recoveries SET to_at=instant.at,history_anchor=$5,history_cursor=$5,
   total_days=CASE WHEN instant.at-from_at<=interval '7776000 seconds' THEN ceil(extract(epoch FROM(instant.at-from_at))/86400)::integer ELSE NULL END,
   state=CASE WHEN instant.at-from_at<=interval '7776000 seconds' THEN 'enumerating' ELSE 'blocked' END,
   reason=CASE WHEN instant.at-from_at<=interval '7776000 seconds' THEN NULL ELSE 'coverage_gap_too_old' END,revision=revision+1,observed_at=clock_timestamp()
   FROM instant WHERE workspace_id=$1 AND import_id=$2 AND id=$3 AND revision=$4 AND state='pending_profile' AND to_at IS NULL`,[context.scope.workspaceId,current.importId,input.recovery.id,input.recovery.revision,input.historyAnchor]);
 });
}
