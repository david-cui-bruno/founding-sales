import {withTransaction} from '../db/queryable.ts';
import {readBackfillAuthority} from './crmBackfillAuthority.ts';
import {createGmailMailCaptureProvider} from './crmGmailProvider.ts';
import {revalidateBackfillPublication,reserveBackfillRead,observeBackfillRead,type BackfillAllocationVerifier} from './crmBackfillBudget.ts';
import type {HistoricalMailCaptureProvider,MailCaptureProofVerifier,MailCaptureProof} from './crmSources.ts';
import type {GmailMessageMetadata} from './gmailClient.ts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import type {HistoricalMetadataAdmission} from './pipeline.ts';
import type {BackfillAuthority} from './crmBackfillAuthority.ts';
import type {HistoryRecovery} from './crmHistoryRecovery.ts';

/** A frozen admitted original is not replaceable by a new date on the same ID. */
async function selectedHistoricalOriginal(context:RepositoryContext,input:{importId:string;providerMessageId:string;conversationId:string;decisionRevision:number},metadata:GmailMessageMetadata,authority:BackfillAuthority){
 if(metadata.id!==input.providerMessageId||!Number.isSafeInteger(metadata.internalDateEpochMilliseconds)||metadata.internalDateEpochMilliseconds<0)return false;
 const row=(await context.db.query<{scope:string;provider_us:string}>(`SELECT x.scope,(extract(epoch FROM x.provider_at)*1000000)::bigint::text AS provider_us FROM crm_mail_import_messages x JOIN crm_business_conversations c ON c.workspace_id=x.workspace_id AND c.mailbox_id=$3 AND c.owner_user_id=$4 AND c.account_binding=$5 AND c.provider_thread_id=x.provider_thread_id WHERE x.workspace_id=$1 AND x.import_id=$2 AND x.provider_message_id=$6 AND x.provider_thread_id=$7 AND x.state='available' AND c.id=$8 AND c.decision_revision=$9 AND c.metadata_availability='available' AND (c.human_decision='include' OR (c.human_decision IS NULL AND c.category='business')) FOR SHARE OF x,c`,[context.scope.workspaceId,input.importId,authority.proof.mailboxId,authority.proof.ownerUserId,authority.proof.accountBinding,metadata.id,metadata.threadId,input.conversationId,input.decisionRevision])).rows[0];
 if(!row||row.provider_us!==String(BigInt(metadata.internalDateEpochMilliseconds)*1000n))return false;
 return row.scope!=='historical'||BigInt(row.provider_us)>=BigInt(authority.fromEpochMicroseconds)&&BigInt(row.provider_us)<BigInt(authority.toEpochMicroseconds);
}
/** Explicit historical composition: the native adapter's actual reads, never live fallback. */
export function createHistoricalGmailMailCaptureProvider(deps:Parameters<typeof createGmailMailCaptureProvider>[0]&{proofVerifier:MailCaptureProofVerifier;allocationVerifier:BackfillAllocationVerifier}):HistoricalMailCaptureProvider{
 async function revalidate(context:Parameters<typeof readBackfillAuthority>[0],input:{importId:string;expectedProof:MailCaptureProof}){const authority=await readBackfillAuthority(context,input.importId,true);return authority!==null&&JSON.stringify(authority.proof)===JSON.stringify(input.expectedProof)&&await revalidateBackfillPublication(context,authority,deps.allocationVerifier);}
 return {revalidate,async read(input){
  async function metered<T>(method:'metadata'|'body',read:()=>Promise<T>):Promise<T>{
   if(!await deps.proofVerifier.verify(input.expectedProof))throw new Error('historical_capture_verification_required');
   const reservation=await reserveBackfillRead(input.context,{importId:input.importId,mailboxId:input.mailboxId,ownerUserId:input.expectedProof.ownerUserId,accountBinding:input.expectedProof.accountBinding,generation:input.generation,method,expectedProof:input.expectedProof,expectedCausal:{messageId:input.providerMessageId,conversationId:input.conversationId,decisionRevision:input.decisionRevision},jobId:input.jobId,leaseOwner:input.leaseOwner,fencingToken:input.fencingToken},deps.allocationVerifier);
   if(reservation===null)throw new Error('historical_capture_allocation_unavailable');
   let value:T;
   try{value=await read();}catch{throw new Error('historical_capture_provider_unavailable');}
   await observeBackfillRead(input.context,reservation.reservationId);
   if(!await withTransaction(input.context.db,()=>revalidate(input.context,input)))throw new Error('historical_capture_authority_changed');
   return value;
  }
  let selected:GmailMessageMetadata|null=null;
  const provider=createGmailMailCaptureProvider({...deps,authorizeRead:proof=>deps.proofVerifier.verify(proof),authorizeSelectedMetadata:async(proof,metadata)=>{
   if(!metadata||JSON.stringify(proof)!==JSON.stringify(input.expectedProof))return false;
   const allowed=await withTransaction(input.context.db,async()=>{const authority=await readBackfillAuthority(input.context,input.importId,true);return authority!==null&&await revalidate(input.context,input)&&await selectedHistoricalOriginal(input.context,input,metadata,authority);});
   if(allowed)selected=structuredClone(metadata);return allowed;
  },gmail:{...deps.gmail,
   getMetadata:async(access,messageId,headers)=>await metered('metadata',()=>deps.gmail.getMetadata(access,messageId,headers)),
   getBody:async(access,messageId)=>await metered('body',()=>deps.gmail.getBody(access,messageId)),
  }});
  const result=await provider.read(input);
  if(!selected||!await withTransaction(input.context.db,async()=>{const authority=await readBackfillAuthority(input.context,input.importId,true);return authority!==null&&await revalidate(input.context,input)&&await selectedHistoricalOriginal(input.context,input,selected!,authority);}))throw new Error('historical_original_changed');
  return result;
 }};
}

/** Internal, per-original closure from an actual reserved metadata result. No
 * serialized flag or import ID can construct authority at the public observer. */
export function reservedHistoricalObservation(input:{metadata:GmailMessageMetadata;reservationId:string;authority:BackfillAuthority;jobId:string;leaseOwner:string;fencingToken:string;allocationVerifier:BackfillAllocationVerifier;recovery?:HistoryRecovery}):HistoricalMetadataAdmission{
 const original=structuredClone(input.metadata),expectedProof=JSON.stringify(input.authority.proof);
 return {metadata:input.metadata,mailboxId:input.authority.proof.mailboxId,ownerUserId:input.authority.proof.ownerUserId,providerAccountId:input.authority.proof.providerAccountId,generation:input.authority.proof.generation,importId:input.authority.importId,async authorizeSelectedMetadata(context,observed){
  if(observed!==input.metadata||JSON.stringify(observed)!==JSON.stringify(original)||!Number.isSafeInteger(original.internalDateEpochMilliseconds)||original.internalDateEpochMilliseconds<0)return false;
  const proof=input.authority.proof;
  if(!(await context.db.query("SELECT 1 FROM jobs j JOIN crm_mail_import_read_reservations r ON r.workspace_id=j.workspace_id WHERE j.workspace_id=$1 AND j.id=$2 AND j.kind='crm.mail_backfill' AND j.state='running' AND j.lease_owner=$3 AND j.fencing_token=$4::bigint AND j.lease_expires_at>clock_timestamp() AND r.id=$5 AND r.import_id=$6 AND r.method='metadata' AND r.state='observed' FOR SHARE OF j,r",[context.scope.workspaceId,input.jobId,input.leaseOwner,input.fencingToken,input.reservationId,input.authority.importId])).rows.length)return false;
  const current=await readBackfillAuthority(context,input.authority.importId,true);
  if(!current||JSON.stringify(current.proof)!==expectedProof||current.fromEpochMicroseconds!==input.authority.fromEpochMicroseconds||current.toEpochMicroseconds!==input.authority.toEpochMicroseconds||!await revalidateBackfillPublication(context,current,input.allocationVerifier))return false;
  const at=BigInt(original.internalDateEpochMilliseconds)*1000n;
  if(input.recovery){
   const recovery=input.recovery;
   const row=(await context.db.query<{state:string;from_us:string;to_us:string}>(`SELECT state,(extract(epoch FROM from_at)*1000000)::bigint::text AS from_us,(extract(epoch FROM to_at)*1000000)::bigint::text AS to_us FROM crm_mail_history_recoveries WHERE workspace_id=$1 AND id=$2 AND import_id=$3 AND revision=$4 AND epoch=$5 AND configuration_hash=$6 AND state IN ('enumerating','draining') FOR SHARE`,[context.scope.workspaceId,recovery.id,current.importId,recovery.revision,recovery.epoch,recovery.configuration_hash])).rows[0];
   return !!row&&row.from_us!==null&&at>=BigInt(row.from_us)&&(row.state==='draining'||row.to_us!==null&&at<BigInt(row.to_us));
  }
  const expansion=(await context.db.query<{message_ids:string[];next_ordinal:number;provider_thread_id:string}>(`SELECT e.message_ids,e.next_ordinal,c.provider_thread_id FROM crm_mail_thread_expansions e JOIN crm_business_conversations c ON c.workspace_id=e.workspace_id AND c.id=e.conversation_id WHERE e.workspace_id=$1 AND e.import_id=$2 AND e.state='enumerating' AND c.mailbox_id=$3 AND c.owner_user_id=$4 AND c.account_binding=$5 AND c.decision_revision=e.decision_revision AND c.metadata_availability='available' AND (c.human_decision='include' OR (c.human_decision IS NULL AND c.category='business')) FOR SHARE OF e,c`,[context.scope.workspaceId,current.importId,proof.mailboxId,proof.ownerUserId,proof.accountBinding])).rows[0];
  if(expansion)return expansion.provider_thread_id===original.threadId&&expansion.message_ids[expansion.next_ordinal]===original.id;
  const pending=(await context.db.query("SELECT 1 FROM crm_mail_import_slices WHERE workspace_id=$1 AND import_id=$2 AND state='pending' LIMIT 1",[context.scope.workspaceId,current.importId])).rows.length>0;
  return at>=BigInt(current.fromEpochMicroseconds)&&(!pending||at<BigInt(current.toEpochMicroseconds));
 }};
}
