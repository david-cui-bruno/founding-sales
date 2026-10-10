import {readHistoryRecovery} from './crmHistoryRecovery.ts';
import {backfillAttemptHashes,backfillConfigurationHash} from './crmBackfillWork.ts';
import {readBackfillAuthority,type BackfillAuthority} from './crmBackfillAuthority.ts';
import type {MailCaptureProof} from './crmSources.ts';
import {createHash} from 'node:crypto';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {withTransaction} from '../db/queryable.ts';
export type BackfillReadMethod='profile'|'list'|'history'|'metadata'|'body';
export interface BackfillAllocation extends Record<string,unknown>{
 workspace_id:string;mailbox_id:string;revision:number;owner_user_id:string;account_binding:string;generation:number;
 project_hash:string;user_hash:string;user_limit_units:number;project_limit_units:number;user_headroom_units:number;project_headroom_units:number;
 profile_units:number;list_units:number;history_units:number;metadata_units:number;body_units:number;verification_sha256:string;verified_until:Date;
}
export interface BackfillAllocationVerifier{verify(allocation:BackfillAllocation,authority?:BackfillAuthority):Promise<boolean>;revalidate?(context:RepositoryContext,allocation:BackfillAllocation,authority:BackfillAuthority):Promise<boolean>}
export async function readBackfillAllocation(context:RepositoryContext,mailboxId:string){
 return (await context.db.query<BackfillAllocation>('SELECT * FROM crm_mail_import_allocations WHERE workspace_id=$1 AND mailbox_id=$2',[context.scope.workspaceId,mailboxId])).rows[0]??null;
}
function fingerprint(row:BackfillAllocation){return createHash('sha256').update(JSON.stringify(row)).digest('hex');}
/** Call only outside a caller-owned transaction: arbitrary receipt verification precedes short reservation locks. */
export async function reserveBackfillRead(context:RepositoryContext,input:{importId:string;mailboxId:string;ownerUserId:string;accountBinding:string;generation:number;method:BackfillReadMethod;expectedProof:MailCaptureProof;expectedRecovery?:{id:string;revision:number;epoch:number;configurationHash:string};expectedCausal?:{messageId:string;conversationId:string;decisionRevision:number};jobId:string;leaseOwner:string;fencingToken:string},verifier:BackfillAllocationVerifier){
 const scope=await readBackfillAuthority(context,input.importId);if(scope===null)return null;
 const before=await readBackfillAllocation(context,input.mailboxId);
 if(before===null||before.owner_user_id!==input.ownerUserId||before.account_binding!==input.accountBinding||before.generation!==input.generation||!await verifier.verify(before,scope))return null;
 return withTransaction(context.db,async()=>{
  const actor=context.scope.actor;if(actor.kind!=='system'||actor.component!=='worker')return null;
  const leased=await context.db.query("SELECT id,kind FROM jobs WHERE workspace_id=$1 AND id=$2 AND state='running' AND lease_owner=$3 AND fencing_token=$4::bigint AND lease_expires_at>clock_timestamp() FOR UPDATE",[context.scope.workspaceId,input.jobId,input.leaseOwner,input.fencingToken]);
  if(!leased.rows.length)return null;
  const authority=await readBackfillAuthority(context,input.importId,true);
  if(authority===null||JSON.stringify(authority.proof)!==JSON.stringify(input.expectedProof))return null;
  const current=(await context.db.query<BackfillAllocation>('SELECT * FROM crm_mail_import_allocations WHERE workspace_id=$1 AND mailbox_id=$2 AND verified_until>clock_timestamp() FOR SHARE',[context.scope.workspaceId,input.mailboxId])).rows[0];
  if(current===undefined||fingerprint(current)!==fingerprint(before)||verifier.revalidate&&!await verifier.revalidate(context,current,authority))return null;
  const imported=await context.db.query('SELECT id FROM crm_mail_imports WHERE workspace_id=$1 AND id=$2 AND mailbox_id=$3 AND owner_user_id=$4 AND account_binding=$5 AND generation=$6',[context.scope.workspaceId,input.importId,input.mailboxId,input.ownerUserId,input.accountBinding,input.generation]);
  if(!imported.rows.length)return null;
  if(input.expectedCausal){
   const causal=input.expectedCausal;
   const messageHash=createHash('sha256').update(JSON.stringify({accountBinding:input.accountBinding,providerMessageId:causal.messageId})).digest('hex');
   const permitted=await context.db.query(`SELECT x.id FROM crm_mail_import_messages x JOIN crm_business_conversations c ON c.workspace_id=x.workspace_id AND c.mailbox_id=$3 AND c.owner_user_id=$4 AND c.account_binding=$5 AND c.provider_thread_id=x.provider_thread_id
    WHERE x.workspace_id=$1 AND x.import_id=$2 AND x.message_hash=$6 AND x.provider_message_id=$7 AND x.state='available' AND c.id=$8 AND c.metadata_availability='available' AND c.decision_revision=$9 AND (c.human_decision='include' OR (c.human_decision IS NULL AND c.category='business')) FOR SHARE OF x,c`,[context.scope.workspaceId,input.importId,input.mailboxId,input.ownerUserId,input.accountBinding,messageHash,causal.messageId,causal.conversationId,causal.decisionRevision]);
   if(permitted.rows.length!==1)return null;
  }
  for(const key of [`crm-mail-project:${current.project_hash}`,`crm-mail-user:${current.user_hash}`].sort())await context.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[key]);
  const sums=(await context.db.query<{project:string;user:string}>(`SELECT COALESCE(sum(units) FILTER(WHERE project_hash=$1),0)::text AS project,COALESCE(sum(units) FILTER(WHERE user_hash=$2),0)::text AS "user" FROM crm_mail_import_read_reservations WHERE reserved_at>clock_timestamp()-interval '60 seconds' AND (project_hash=$1 OR user_hash=$2)`,[current.project_hash,current.user_hash])).rows[0]!;
  if(leased.rows[0]?.['kind']==='crm.mail_backfill'){
   await context.db.query('SELECT id FROM crm_mail_history_recoveries WHERE workspace_id=$1 AND import_id=$2 ORDER BY epoch FOR SHARE',[context.scope.workspaceId,input.importId]);
   const recovery=await readHistoryRecovery(context,input.importId);
   if(input.expectedRecovery===undefined&&recovery!==undefined)return null;
   if(input.expectedRecovery!==undefined&&(recovery===undefined||recovery.id!==input.expectedRecovery.id||recovery.revision!==input.expectedRecovery.revision||recovery.epoch!==input.expectedRecovery.epoch||recovery.configuration_hash!==input.expectedRecovery.configurationHash||!['pending_profile','enumerating','draining'].includes(recovery.state)||recovery.configuration_hash!==backfillConfigurationHash(authority,current)))return null;
   const slice=(await context.db.query<{ordinal:number;next_page_token:string|null}>("SELECT ordinal,next_page_token FROM crm_mail_import_slices WHERE workspace_id=$1 AND import_id=$2 AND state='pending' ORDER BY ordinal LIMIT 1",[context.scope.workspaceId,input.importId])).rows[0];
   await context.db.query('UPDATE jobs SET payload=payload||$3::jsonb WHERE workspace_id=$1 AND id=$2',[context.scope.workspaceId,input.jobId,JSON.stringify(backfillAttemptHashes(authority,current,slice,recovery))]);
  }
  const units=current[`${input.method}_units`];
  if(typeof units!=='number'||BigInt(sums.project)+BigInt(units)>BigInt(current.project_limit_units-current.project_headroom_units)||BigInt(sums.user)+BigInt(units)>BigInt(current.user_limit_units-current.user_headroom_units))return null;
  const reservation=(await context.db.query<{id:string}>(`INSERT INTO crm_mail_import_read_reservations(workspace_id,import_id,project_hash,user_hash,allocation_revision,method,units) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,[context.scope.workspaceId,input.importId,current.project_hash,current.user_hash,current.revision,input.method,units])).rows[0]!;
  return {reservationId:reservation.id,units};
 });
}
export async function observeBackfillRead(context:RepositoryContext,reservationId:string){
 await context.db.query("UPDATE crm_mail_import_read_reservations SET state='observed',observed_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 AND state='unknown'",[context.scope.workspaceId,reservationId]);
}

/** Local check holds independent receipt locks through the caller-owned publication transaction. */
export async function revalidateBackfillPublication(context:RepositoryContext,authority:BackfillAuthority,verifier:BackfillAllocationVerifier){
 const allocation=(await context.db.query<BackfillAllocation>('SELECT * FROM crm_mail_import_allocations WHERE workspace_id=$1 AND mailbox_id=$2 AND verified_until>clock_timestamp() FOR SHARE',[context.scope.workspaceId,authority.proof.mailboxId])).rows[0];
 return allocation!==undefined&&(!verifier.revalidate||await verifier.revalidate(context,allocation,authority));
}
