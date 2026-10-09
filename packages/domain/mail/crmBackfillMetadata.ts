import {activeBusinessActor} from '../business/acquisition.ts';
import {createHash} from 'node:crypto';
import type {BusinessMailMetadataReceipt} from './pipeline.ts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import type {GmailMessageMetadata} from './gmailClient.ts';
import type {BackfillAuthority} from './crmBackfillAuthority.ts';
/** Caller holds the current import/account closure. A causal record is never body permission. */
export async function recordBackfillMetadata(context:RepositoryContext,input:{authority:BackfillAuthority;messageId:string;metadata:GmailMessageMetadata|null;scope:'historical'|'overlap'|'reconciliation';observationReceipt?:BusinessMailMetadataReceipt|void}){
 const actor=context.scope.actor;if(actor.kind!=='system'||actor.component!=='worker')return;
 const {authority,messageId,metadata}=input;
 if(!/^[A-Za-z0-9_-]{1,128}$/u.test(messageId))return;
 if(metadata!==null&&(!/^[A-Za-z0-9_-]{1,128}$/u.test(metadata.threadId)||metadata.id!==messageId||!Number.isSafeInteger(metadata.internalDateEpochMilliseconds)))return;
 if(metadata!==null&&input.scope==='historical'&&(BigInt(metadata.internalDateEpochMilliseconds)*1000n<BigInt(authority.fromEpochMicroseconds)||BigInt(metadata.internalDateEpochMilliseconds)*1000n>=BigInt(authority.toEpochMicroseconds)))return;
 const proof=authority.proof;
 const hash=createHash('sha256').update(JSON.stringify({accountBinding:proof.accountBinding,providerMessageId:messageId})).digest('hex');
 const conversation=metadata===null||input.observationReceipt?.ok!==true?undefined:(await context.db.query<{metadata_availability:string}>("SELECT metadata_availability FROM crm_business_conversations WHERE workspace_id=$1 AND mailbox_id=$2 AND owner_user_id=$3 AND account_binding=$4 AND provider_thread_id=$5 AND id=$6",[context.scope.workspaceId,proof.mailboxId,proof.ownerUserId,proof.accountBinding,metadata.threadId,input.observationReceipt.conversationId])).rows[0];
 const now=(await context.db.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0]!.now;
 const state=metadata===null?'confirmed_missing':input.observationReceipt?.ok===false&&input.observationReceipt.reason==='metadata_deleted'?'deleted':conversation?.metadata_availability==='available'?'available':'refused';
 const reason=state==='available'?null:state==='deleted'?'metadata_deleted':state==='confirmed_missing'?'provider_confirmed_missing':metadata!==null&&(metadata.internalDateEpochMilliseconds<now.getTime()-90*86400000||input.observationReceipt?.ok===false&&input.observationReceipt.reason==='outside_review_window')?'outside_review_window':'metadata_observation_unavailable';
 await context.db.query(`INSERT INTO crm_mail_import_messages(workspace_id,import_id,message_hash,provider_message_id,provider_thread_id,provider_at,scope,state,reason)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
 ON CONFLICT(workspace_id,import_id,message_hash) DO UPDATE SET provider_message_id=EXCLUDED.provider_message_id,provider_thread_id=EXCLUDED.provider_thread_id,provider_at=EXCLUDED.provider_at,scope=EXCLUDED.scope,state=EXCLUDED.state,reason=EXCLUDED.reason,revision=crm_mail_import_messages.revision+1,observed_at=clock_timestamp()
 WHERE crm_mail_import_messages.state<>'deleted'`,[context.scope.workspaceId,authority.importId,hash,state==='deleted'?null:messageId,state==='available'?metadata!.threadId:null,state==='available'?new Date(metadata!.internalDateEpochMilliseconds):null,input.scope,state,reason]);
}

async function redactRows(context:RepositoryContext,ids:readonly string[]){
 if(ids.length===0)return 0;
 await context.db.query('SELECT id FROM crm_mail_import_messages WHERE workspace_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE',[context.scope.workspaceId,ids]);
 return (await context.db.query("UPDATE crm_mail_import_messages SET state='deleted',reason='metadata_deleted',provider_message_id=NULL,provider_thread_id=NULL,provider_at=NULL,revision=revision+1,observed_at=clock_timestamp() WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND state<>'deleted'",[context.scope.workspaceId,ids])).rowCount??0;
}
/** Terminal metadata cleanup from an already authorized scoped deletion closure. */
export async function redactBackfillMetadataRows(context:RepositoryContext,ids:readonly string[]){
 const actor=context.scope.actor;
 if(!(actor.kind==='system'&&actor.component==='worker')&&!(actor.kind==='user'&&actor.role==='admin'&&await activeBusinessActor(context)))return 0;
 return redactRows(context,ids);
}
export async function redactBackfillMetadataForConversations(context:RepositoryContext,conversationIds:readonly string[]){
 const actor=context.scope.actor;
 if(!(actor.kind==='system'&&actor.component==='worker')&&!(actor.kind==='user'&&actor.role==='admin'&&await activeBusinessActor(context)))return 0;
 const ids=(await context.db.query<{id:string}>(`SELECT x.id FROM crm_mail_import_messages x JOIN crm_mail_imports i ON i.workspace_id=x.workspace_id AND i.id=x.import_id JOIN crm_business_conversations b ON b.workspace_id=i.workspace_id AND b.mailbox_id=i.mailbox_id AND b.owner_user_id=i.owner_user_id AND b.account_binding=i.account_binding AND b.provider_thread_id=x.provider_thread_id WHERE x.workspace_id=$1 AND b.id=ANY($2::uuid[]) AND x.state<>'deleted' ORDER BY x.id`,[context.scope.workspaceId,conversationIds])).rows.map(row=>row.id);
 return redactRows(context,ids);
}
export async function redactBackfillMetadataForSources(context:RepositoryContext,sourceIds:readonly string[]){
 const actor=context.scope.actor;
 if(actor.kind==='system'&&actor.component!=='worker'||actor.kind==='user'&&!await activeBusinessActor(context))return 0;
 const userId=actor.kind==='user'&&actor.role!=='admin'?actor.userId:null;
 const ids=(await context.db.query<{id:string}>(`SELECT x.id FROM crm_mail_import_messages x JOIN crm_mail_imports i ON i.workspace_id=x.workspace_id AND i.id=x.import_id JOIN crm_mail_capture_identities c ON c.workspace_id=i.workspace_id AND c.mailbox_id=i.mailbox_id AND c.account_binding=i.account_binding AND c.provider_message_id=x.provider_message_id JOIN crm_mail_sources s ON s.workspace_id=c.workspace_id AND s.source_id=c.source_id WHERE x.workspace_id=$1 AND s.source_id=ANY($2::uuid[]) AND ($3::uuid IS NULL OR s.owner_user_id=$3) AND x.state<>'deleted' ORDER BY x.id`,[context.scope.workspaceId,sourceIds,userId])).rows.map(row=>row.id);
 return redactRows(context,ids);
}
/** Unavailable originals carry no business retention exception; terminal hash barriers remain. */
export async function expireUnavailableBackfillMetadata(context:RepositoryContext,limit:number){
 if(context.scope.actor.kind!=='system'||context.scope.actor.component!=='worker'||!Number.isInteger(limit)||limit<1||limit>500)return 0;
 const ids=(await context.db.query<{id:string}>("SELECT id FROM crm_mail_import_messages WHERE workspace_id=$1 AND state IN ('refused','confirmed_missing') AND observed_at<clock_timestamp()-interval '90 days' ORDER BY observed_at,id LIMIT $2 FOR UPDATE",[context.scope.workspaceId,limit])).rows.map(row=>row.id);
 return redactRows(context,ids);
}
