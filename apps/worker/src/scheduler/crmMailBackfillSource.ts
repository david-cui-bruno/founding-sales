import {readHistoryRecovery} from '@fss/domain/mail/crmHistoryRecovery.ts';
import {backfillAttemptHashes,backfillWorkKey} from '@fss/domain/mail/crmBackfillWork.ts';
import {readBackfillAllocation} from '@fss/domain/mail/crmBackfillBudget.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {readBackfillAuthority} from '@fss/domain/mail/crmBackfillAuthority.ts';
import type {DueWorkSource} from './schedulerPass.ts';
/** Nonlocking DB hints only. A queued hint is never external proof or provider permission. */
export function crmMailBackfillSource(enabled=false):DueWorkSource{return {name:'crm-mail-backfill',async find(session){
 if(!enabled)return [];
 const rows=(await session.query<{workspace_id:string;id:string}>(`SELECT i.workspace_id,i.id FROM crm_mail_imports i
 JOIN crm_mail_import_allocations a ON a.workspace_id=i.workspace_id AND a.mailbox_id=i.mailbox_id AND a.owner_user_id=i.owner_user_id AND a.account_binding=i.account_binding AND a.generation=i.generation
 WHERE i.state<>'complete' AND a.verified_until>clock_timestamp()
 AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.workspace_id=i.workspace_id AND j.kind='crm.mail_backfill' AND j.payload->>'importId'=i.id::text AND j.state IN ('queued','retryable','running'))
 ORDER BY i.last_scheduled_scan_at NULLS FIRST,i.workspace_id,i.id LIMIT 100`)).rows;
 const due=[];
 for(const row of rows){
  // Uses only the shared DB-only snapshot; arbitrary proof verification belongs to the worker.
  const context=repositoryContext(workspaceScope(row.workspace_id,{kind:'system',component:'worker'}),session);
  const hint=await readBackfillAuthority(context,row.id);if(hint===null)continue;
  const slice=(await session.query<{ordinal:number;next_page_token:string|null}>("SELECT ordinal,next_page_token FROM crm_mail_import_slices WHERE workspace_id=$1 AND import_id=$2 AND state='pending' ORDER BY ordinal LIMIT 1",[row.workspace_id,row.id])).rows[0];
  const allocation=await readBackfillAllocation(context,hint.proof.mailboxId);if(allocation===null)continue;
  const recovery=await readHistoryRecovery(context,row.id);
  const hashes=backfillAttemptHashes(hint,allocation,slice,recovery);
  const payload={importId:row.id,accountBinding:hint.proof.accountBinding,generation:hint.proof.generation,controlsRevision:hint.proof.controlsRevision,policyRevision:hint.proof.policyRevision};
  const key=backfillWorkKey(hashes);
  if((await session.query("SELECT 1 FROM jobs WHERE workspace_id=$1 AND kind='crm.mail_backfill' AND state='dead' AND payload->>'importId'=$2 AND payload->>'attemptConfigurationHash'=$3 AND payload->>'attemptProgressHash'=$4",[row.workspace_id,row.id,hashes.attemptConfigurationHash,hashes.attemptProgressHash])).rows.length)continue;
  if((await session.query("SELECT 1 FROM jobs WHERE workspace_id=$1 AND kind='crm.mail_backfill' AND idempotency_key=$2",[row.workspace_id,key])).rows.length)continue;
  due.push({workspaceId:row.workspace_id,kind:'crm.mail_backfill' as const,idempotencyKey:key,payload,maxAttempts:4});
 }
 for(const row of [...rows].sort((a,b)=>a.workspace_id.localeCompare(b.workspace_id)||a.id.localeCompare(b.id)))await session.query('UPDATE crm_mail_imports SET last_scheduled_scan_at=GREATEST(COALESCE(last_scheduled_scan_at,\'-infinity\'::timestamptz),clock_timestamp()) WHERE workspace_id=$1 AND id=$2',[row.workspace_id,row.id]);
 return due;
}};}
