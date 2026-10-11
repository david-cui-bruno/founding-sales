import {businessSelectionPayloadSchema} from '@fss/contracts';
import {z} from 'zod';
import {createHash} from 'node:crypto';
import {repositoryContext} from '@fss/domain/db/workspaceScope.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {readBackfillAuthority} from '@fss/domain/mail/crmBackfillAuthority.ts';
import {reserveBackfillRead,observeBackfillRead,revalidateBackfillPublication} from '@fss/domain/mail/crmBackfillBudget.ts';
import {lockBusinessMetadataAddresses} from '@fss/domain/business/acquisition.ts';
import {normalizeIdentityEndpoint} from '@fss/domain/crm/endpoints.ts';
import {isSuppressed} from '@fss/domain/suppression/effective.ts';
import {headerValue} from '@fss/domain/mail/gmailClient.ts';
import {METADATA_HEADERS} from '@fss/domain/mail/types.ts';
import type {JobHandler} from '@fss/domain/jobs/handlerRegistry.ts';
import type {CrmMailBackfillDeps} from './crmMailBackfill.ts';
const schema=businessSelectionPayloadSchema.extend({importId:z.uuid(),ownerUserId:z.uuid()});
export function businessSelectionHandler(deps:CrmMailBackfillDeps|undefined):JobHandler{return {kind:'crm.business_selection',protection:'outbound_fence',maxAttempts:1,leaseSeconds:120,async handle(input){
 async function run(){
 const parsed=schema.safeParse(input.job.payload);if(!parsed.success||!deps)return {done:true,progress:{outcome:'selection_configuration_required'}};
 const chosen=parsed.data,context=repositoryContext(input.scope,input.session),authority=await readBackfillAuthority(context,chosen.importId);
 if(!authority||authority.proof.ownerUserId!==chosen.ownerUserId||authority.proof.mailboxId!==chosen.mailboxId||authority.proof.generation!==chosen.expectedGeneration||authority.proof.accountBinding!==chosen.expectedAccountBinding||authority.proof.policyRevision!==chosen.expectedPolicyRevision||!await deps.proofVerifier.verify(authority.proof))return {done:true,progress:{outcome:'selection_authority_changed'}};
 const access=await deps.resolveAccess({workspaceId:input.scope.workspaceId,mailboxId:chosen.mailboxId,providerAccountId:authority.proof.providerAccountId,generation:chosen.expectedGeneration});
 if(!access||access.mailboxId!==chosen.mailboxId||access.providerAccountId!==authority.proof.providerAccountId||access.generation!==chosen.expectedGeneration)return {done:true,progress:{outcome:'selection_authority_changed'}};
 const reservation=await reserveBackfillRead(context,{importId:chosen.importId,mailboxId:chosen.mailboxId,ownerUserId:chosen.ownerUserId,accountBinding:chosen.expectedAccountBinding,generation:chosen.expectedGeneration,method:'metadata',expectedProof:authority.proof,jobId:input.job.id,leaseOwner:input.job.leaseOwner,fencingToken:input.job.fencingToken},deps.allocationVerifier);
 if(!reservation)return {done:true,progress:{outcome:'quota_or_authority_unavailable'}};
 let metadata;try{metadata=await deps.gmail.getMetadata(access.access,chosen.providerMessageId,METADATA_HEADERS);}catch{throw new Error('selection_provider_read_unavailable');}await observeBackfillRead(context,reservation.reservationId);
 if(!metadata||metadata.id!==chosen.providerMessageId||metadata.labelIds.includes('DRAFT'))return {done:true,progress:{outcome:'selected_message_unavailable'}};
 if(!await deps.proofVerifier.verify(authority.proof))return {done:true,progress:{outcome:'selection_authority_changed'}};
 return withTransaction(input.session,async()=>{
 const current=await readBackfillAuthority(context,chosen.importId,true);
 if(!current||JSON.stringify(current.proof)!==JSON.stringify(authority.proof)||!await revalidateBackfillPublication(context,current,deps.allocationVerifier))return {done:true,progress:{outcome:'selection_authority_changed'}};
 const leased=await input.session.query("SELECT id FROM jobs WHERE workspace_id=$1 AND id=$2 AND state='running' AND lease_owner=$3 AND fencing_token=$4::bigint AND lease_expires_at>clock_timestamp() FOR UPDATE",[input.scope.workspaceId,input.job.id,input.job.leaseOwner,input.job.fencingToken]);if(!leased.rows.length)return {done:true,progress:{outcome:'selection_lease_lost'}};
 const participants=[headerValue(metadata.headers,'From'),headerValue(metadata.headers,'To'),headerValue(metadata.headers,'Cc')].flatMap(value=>[...(value??'').matchAll(/([^<>\s,]+@[^<>\s,]+)/gu)]).map(match=>normalizeIdentityEndpoint('email',match[1]!));
 if(!participants.length||participants.length>50||participants.some(value=>!value))return {done:true,progress:{outcome:'selected_metadata_invalid'}};
 const endpoints=participants.filter((value):value is string=>value!==null);await lockBusinessMetadataAddresses(context,endpoints);
 for(const endpoint of endpoints)if((await isSuppressed(context,{scope:'handle',canonicalKey:endpoint}))?.source==='deletion_tombstone')return {done:true,progress:{outcome:'metadata_deleted'}};
 const old=(await input.session.query<{id:string;metadata_availability:string}>('SELECT id,metadata_availability FROM crm_business_conversations WHERE workspace_id=$1 AND mailbox_id=$2 AND account_binding=$3 AND provider_thread_id=$4 FOR UPDATE',[input.scope.workspaceId,chosen.mailboxId,chosen.expectedAccountBinding,metadata.threadId])).rows[0];if(old?.metadata_availability==='deleted')return {done:true,progress:{outcome:'metadata_deleted'}};
 const subject=(headerValue(metadata.headers,'Subject')??'').slice(0,500),date=new Date(metadata.internalDateEpochMilliseconds);if(!Number.isFinite(date.getTime()))return {done:true,progress:{outcome:'selected_metadata_invalid'}};
 const hash=createHash('sha256').update(JSON.stringify({subject,participants:endpoints,at:date.toISOString()})).digest('hex');
 const row=(await input.session.query<{id:string}>(`INSERT INTO crm_business_conversations(workspace_id,mailbox_id,owner_user_id,account_binding,provider_thread_id,subject,participants,latest_provider_at,category,reason,classifier_version,metadata_hash,explicit_selected_at) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,'uncertain','explicit_metadata_selection','selected-message-v1',$9,clock_timestamp()) ON CONFLICT(workspace_id,mailbox_id,account_binding,provider_thread_id) DO UPDATE SET explicit_selected_at=clock_timestamp(),metadata_revision=crm_business_conversations.metadata_revision+1 RETURNING id`,[input.scope.workspaceId,chosen.mailboxId,chosen.ownerUserId,chosen.expectedAccountBinding,metadata.threadId,subject,JSON.stringify(endpoints),date,hash])).rows[0]!;
 return {done:true,progress:{outcome:'preview_available',conversationId:row.id,captureAllowed:false}};
 });
 }
 const result=await run();await input.session.query("UPDATE jobs SET payload=jsonb_set(payload,'{selectionOutcome}',$5::jsonb,true) WHERE workspace_id=$1 AND id=$2 AND state='running' AND lease_owner=$3 AND fencing_token=$4::bigint AND lease_expires_at>clock_timestamp()",[input.scope.workspaceId,input.job.id,input.job.leaseOwner,input.job.fencingToken,JSON.stringify(result.progress)]);return result;
}};}
