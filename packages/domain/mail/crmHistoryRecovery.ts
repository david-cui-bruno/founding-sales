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

import type {GmailListRequest,GmailListOutcome,GmailHistoryRequest,GmailHistoryOutcome,GmailMessageMetadata} from './gmailClient.ts';
import type {BusinessMailMetadataObserver} from './pipeline.ts';
import {recordBackfillMetadata} from './crmBackfillMetadata.ts';
interface RecoveryReaders {
 list(request:GmailListRequest):Promise<GmailListOutcome>;
 history(request:GmailHistoryRequest):Promise<GmailHistoryOutcome>;
 metadata(messageId:string):Promise<GmailMessageMetadata|null>;
 observer:BusinessMailMetadataObserver;
}
async function lockedRecovery(context:RepositoryContext,input:RecoveryFence&{recovery:HistoryRecovery}){
 const authority=await lockedAuthority(context,input);if(authority===null)return null;
 await context.db.query('SELECT mailbox_id FROM crm_mail_import_allocations WHERE workspace_id=$1 AND mailbox_id=$2 FOR SHARE',[context.scope.workspaceId,authority.proof.mailboxId]);
 const allocation=await readBackfillAllocation(context,authority.proof.mailboxId);
 if(allocation===null||backfillConfigurationHash(authority,allocation)!==input.recovery.configuration_hash)return null;
 await context.db.query('SELECT id FROM crm_mail_history_recoveries WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[context.scope.workspaceId,input.recovery.id]);
 const current=await readHistoryRecovery(context,authority.importId);
 if(current===undefined||current.id!==input.recovery.id||current.revision!==input.recovery.revision||current.state!==input.recovery.state)return null;
 return authority;
}
/** One metered page per job. No provider wait occurs in the locked observer or progress stages. */
export async function advanceHistoryRecovery(context:RepositoryContext,input:RecoveryFence&{recovery:HistoryRecovery},readers:RecoveryReaders){
 const recovery=input.recovery;
 async function observe(messageId:string,metadata:GmailMessageMetadata|null){
  await withTransaction(context.db,async()=>{
   const authority=await lockedRecovery(context,input);if(authority===null)return;
   const observationReceipt=metadata===null?undefined:await readers.observer.observe(context,{mailboxId:authority.proof.mailboxId,ownerUserId:authority.proof.ownerUserId,providerAccountId:authority.proof.providerAccountId,generation:authority.proof.generation,metadata,acquisitionOrigin:{importId:authority.importId}});
   await recordBackfillMetadata(context,{authority,messageId,metadata,scope:'overlap',observationReceipt});
  });
 }
 if(recovery.state==='enumerating'){
  if(recovery.from_at===null||recovery.to_at===null||recovery.total_days===null||recovery.next_day_ordinal>=recovery.total_days)return 'invalid_evidence' as const;
  const bounds=(await context.db.query<{from_us:string;to_us:string}>("SELECT (extract(epoch FROM from_at)*1000000)::bigint::text AS from_us,(extract(epoch FROM to_at)*1000000)::bigint::text AS to_us FROM crm_mail_history_recoveries WHERE workspace_id=$1 AND id=$2",[context.scope.workspaceId,recovery.id])).rows[0];if(bounds===undefined||bounds.from_us===null||bounds.to_us===null)return 'authority_changed' as const;
  const start=BigInt(bounds.from_us)+BigInt(recovery.next_day_ordinal)*86400000000n;
  const end=start+86400000000n<BigInt(bounds.to_us)?start+86400000000n:BigInt(bounds.to_us);
  const page=await readers.list({afterEpochSeconds:Number(start/1000000n)-1,beforeEpochSeconds:Number(end/1000000n)+1,maxResults:25,...recovery.next_day_page_token===null?{}:{pageToken:recovery.next_day_page_token}});
  if(!page.ok)return 'provider_unavailable' as const;
  if(page.messageIds.length>25||page.nextPageToken!==null&&(page.nextPageToken.length<1||page.nextPageToken.length>2000))return 'invalid_evidence' as const;
  for(const messageId of new Set(page.messageIds)){
   if(!/^[A-Za-z0-9_-]{1,128}$/u.test(messageId))return 'invalid_evidence' as const;
   const metadata=await readers.metadata(messageId);
   if(metadata!==null&&(BigInt(metadata.internalDateEpochMilliseconds)*1000n<start||BigInt(metadata.internalDateEpochMilliseconds)*1000n>=end))continue;
   await observe(messageId,metadata);
  }
  await withTransaction(context.db,async()=>{
   if(await lockedRecovery(context,input)===null)return;
   const next=page.nextPageToken===null?recovery.next_day_ordinal+1:recovery.next_day_ordinal;
   await context.db.query("UPDATE crm_mail_history_recoveries SET next_day_ordinal=$3,next_day_page_token=$4,state=$5,revision=revision+1,observed_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2",[context.scope.workspaceId,recovery.id,next,page.nextPageToken,next===recovery.total_days?'draining':'enumerating']);
  });
  return 'progress' as const;
 }
 if(recovery.state==='draining'){
  if(recovery.history_cursor===null)return 'invalid_evidence' as const;
  const page=await readers.history({startHistoryId:recovery.history_cursor,maxResults:25,includeLifecycleChanges:true,...recovery.history_page_token===null?{}:{pageToken:recovery.history_page_token}});
  if(!page.ok){
   if(page.reason!=='history_expired')return 'provider_unavailable' as const;
   await withTransaction(context.db,async()=>{if(await lockedRecovery(context,input)===null)return;await context.db.query("UPDATE crm_mail_history_recoveries SET state='blocked',reason='history_coverage_expired',revision=revision+1,observed_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2",[context.scope.workspaceId,recovery.id]);});
   return 'history_expired' as const;
  }
  if(!/^[0-9]{1,20}$/u.test(page.historyId)||BigInt(page.historyId)<BigInt(recovery.history_cursor)||page.records.length>25||page.nextPageToken!==null&&(page.nextPageToken.length<1||page.nextPageToken.length>2000))return 'invalid_evidence' as const;
  let previous=BigInt(recovery.history_cursor);
  for(const record of page.records){
   if(!/^[0-9]{1,20}$/u.test(record.id)||BigInt(record.id)<=previous||BigInt(record.id)>BigInt(page.historyId))return 'invalid_evidence' as const;
   previous=BigInt(record.id);
   for(const messageId of new Set(record.changes.map(change=>change.messageId))){
    if(!/^[A-Za-z0-9_-]{1,128}$/u.test(messageId))return 'invalid_evidence' as const;
    await observe(messageId,await readers.metadata(messageId));
   }
  }
  await withTransaction(context.db,async()=>{
   if(await lockedRecovery(context,input)===null)return;
   await context.db.query("UPDATE crm_mail_history_recoveries SET history_cursor=$3,history_page_token=$4,state=$5,completed_at=CASE WHEN $5='complete' THEN clock_timestamp() ELSE NULL END,revision=revision+1,observed_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2",[context.scope.workspaceId,recovery.id,page.nextPageToken===null?page.historyId:recovery.history_cursor,page.nextPageToken,page.nextPageToken===null?'complete':'draining']);
  });
  return 'progress' as const;
 }
 return 'invalid_evidence' as const;
}
