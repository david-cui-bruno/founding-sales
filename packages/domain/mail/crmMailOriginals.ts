import {originalMailObservationSchema} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {readMailConversation,type ExactMailSource} from './crmSources.ts';
/** Read the permitted/audited copy first. Hidden originals never become a status side channel. */
export async function readMailConversationV2(context:RepositoryContext,exact:ExactMailSource){
 const copy=await readMailConversation(context,exact);
 if(copy.state!=='available')return copy;
 const row=(await context.db.query<{original_availability:string;original_observation_revision:string;original_observed_at:Date|null;original_observed_generation:number|null;original_observed_account_binding:string|null;original_observation_reason:string|null;connection_state:string}>(`SELECT s.original_availability,s.original_observation_revision::text,s.original_observed_at,s.original_observed_generation,s.original_observed_account_binding,s.original_observation_reason,
 CASE WHEN m.status<>'connected' THEN 'disconnected' WHEN m.owner_user_id<>s.owner_user_id OR m.provider_account_id IS DISTINCT FROM s.provider_account_id OR m.generation<>COALESCE(s.original_observed_generation,s.acquired_generation) THEN 'changed' ELSE 'current' END AS connection_state
 FROM crm_mail_sources s JOIN mailboxes m ON m.workspace_id=s.workspace_id AND m.id=s.mailbox_id WHERE s.workspace_id=$1 AND s.source_id=$2 AND s.source_revision=$3 AND s.content_hash=$4 AND s.availability='available'`,[context.scope.workspaceId,exact.sourceId,exact.sourceRevision,exact.contentHash])).rows[0];
 if(row===undefined)return {state:'unavailable',reason:'source_changed',source:null} as const;
 const originalObservation=originalMailObservationSchema.parse({state:row.original_availability,revision:row.original_observation_revision,observedAt:row.original_observed_at?.toISOString()??null,observedGeneration:row.original_observed_generation,observedAccountBinding:row.original_observed_account_binding,reason:row.original_observation_reason,connectionState:row.connection_state});
 return {...copy,source:{...copy.source,originalObservation}};
}

import {withTransaction} from '../db/queryable.ts';
import {repositoryContext,workspaceScope} from '../db/workspaceScope.ts';
import {lockIdentityContext} from '../crm/identityAccess.ts';
import {snapshotMailCopyAuthorityBatch,lockMailCopyAuthorityBatch} from './crmSources.ts';
import {readBackfillAuthority,type BackfillAuthority} from './crmBackfillAuthority.ts';
import type {GmailMessageMetadata} from './gmailClient.ts';
/** A real, already metered metadata result is recorded separately from account-first import work. */
export async function recordRetainedOriginalMetadata(context:RepositoryContext,input:{authority:BackfillAuthority;messageId:string;metadata:GmailMessageMetadata|null;transientReason?:'grant_unavailable'|'rate_limited'|'provider_unavailable';observedAt:Date;jobId:string;leaseOwner:string;fencingToken:string}){
 if(context.scope.actor.kind!=='system'||context.scope.actor.component!=='worker' )return;
 if(input.transientReason!==undefined&&input.metadata!==null)return;
 const proof=input.authority.proof;
 if(input.metadata!==null&&(input.metadata.id!==input.messageId||!Number.isSafeInteger(input.metadata.internalDateEpochMilliseconds)))return;
 return withTransaction(context.db,async()=>{
  if(!(await context.db.query("SELECT id FROM jobs WHERE workspace_id=$1 AND id=$2 AND state='running' AND lease_owner=$3 AND fencing_token=$4::bigint AND lease_expires_at>clock_timestamp() FOR UPDATE",[context.scope.workspaceId,input.jobId,input.leaseOwner,input.fencingToken])).rows.length)return;
  const member=(await context.db.query<{role:string}>("SELECT role FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 AND status='active' FOR SHARE",[context.scope.workspaceId,proof.ownerUserId])).rows[0];
  if(member?.role!=='admin'&&member?.role!=='salesperson')return;
  const owner=repositoryContext(workspaceScope(context.scope.workspaceId,{kind:'user',userId:proof.ownerUserId,role:member.role}),context.db);
  const source=(await context.db.query<{source_id:string;source_revision:number;content_hash:string}>(`SELECT s.source_id,s.source_revision,s.content_hash FROM crm_mail_capture_identities c JOIN crm_mail_sources s ON s.workspace_id=c.workspace_id AND s.capture_identity_id=c.id JOIN mail_messages m ON m.workspace_id=s.workspace_id AND m.id=s.source_id
   WHERE c.workspace_id=$1 AND c.mailbox_id=$2 AND c.account_binding=$3 AND c.provider_message_id=$4 AND s.owner_user_id=$5 AND s.account_binding=$3 AND s.provider_account_id=$6 AND s.availability='available' AND ($7::text IS NULL OR m.provider_thread_id=$7)`,[context.scope.workspaceId,proof.mailboxId,proof.accountBinding,input.messageId,proof.ownerUserId,proof.providerAccountId,input.metadata?.threadId??null])).rows[0];
  if(source===undefined)return;
  const snapshot=await snapshotMailCopyAuthorityBatch(owner,[{sourceId:source.source_id,sourceRevision:source.source_revision,contentHash:source.content_hash}]);
  if(snapshot===null||!await lockIdentityContext(owner,{firmIds:snapshot.firmIds,personIds:snapshot.personIds})||!await lockMailCopyAuthorityBatch(owner,snapshot,{firmIds:snapshot.firmIds,personIds:snapshot.personIds}))return;
  const current=await readBackfillAuthority(context,input.authority.importId);
  if(current===null||JSON.stringify(current.proof)!==JSON.stringify(proof))return;
  const trash=input.metadata?.labelIds.includes('TRASH')===true;
  const state=input.transientReason!==undefined?'transient_unavailable':input.metadata===null?'confirmed_missing':trash?'trashed':'available';
  const reason=input.transientReason??(input.metadata===null?'verified_message_not_found':trash?'verified_trash_label':'verified_metadata');
  await context.db.query(`UPDATE crm_mail_sources SET original_availability=$3,original_observation_revision=original_observation_revision+1,original_observed_at=$4,original_observed_generation=$5,original_observed_account_binding=$6,original_observation_reason=$7
   WHERE workspace_id=$1 AND source_id=$2 AND source_revision=$8 AND content_hash=$9 AND availability='available' AND (original_observed_at IS NULL OR original_observed_at<=$4)`,[context.scope.workspaceId,source.source_id,state,input.observedAt,proof.generation,proof.accountBinding,reason,source.source_revision,source.content_hash]);
 });
}
