import {mailConversationSchema} from '@fss/contracts';
import {createHash} from 'node:crypto';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {readMailConversation,type ExactMailSource} from '../mail/crmSources.ts';
/** Completed CRM work grants no outreach permission and changes no stop. */
export async function projectMailProgress(context:RepositoryContext,exact:ExactMailSource,fence:()=>Promise<boolean>){
 const read=mailConversationSchema.parse(await readMailConversation(context,exact));if(read.state!=='available')return;
 const source=read.source;
 if(source.direction!=='outgoing'||!source.sentProof||source.completeness!=='complete'||!source.ranges.some(r=>r.kind==='authored'))return;
 const canonical=(await context.db.query<{provider_thread_id:string}>('SELECT provider_thread_id FROM mail_messages WHERE workspace_id=$1 AND id=$2',[context.scope.workspaceId,exact.sourceId])).rows[0];if(!canonical)return;
 const contexts=[...source.originalContexts,...source.reviewedContexts];
 const firmIds=[...new Set(contexts.flatMap(cx=>cx.firmId?[cx.firmId]:[]))].sort();
 const personIds=[...new Set(contexts.flatMap(cx=>cx.personId?[cx.personId]:[]))].sort();
 if(!await fence())return;
 const args=[context.scope.workspaceId,source.sourceId,source.sourceRevision,source.contentHash,source.ownerUserId,source.mailboxId,source.accountBinding,source.occurredAt,createHash('sha256').update(JSON.stringify(contexts)).digest('hex'),firmIds,personIds];
 const receipt=(await context.db.query<{id:string}>(`INSERT INTO crm_mail_progress_receipts(workspace_id,source_id,source_revision,source_hash,owner_user_id,mailbox_id,account_binding,event_kind,provider_at,context_hash,original_firm_ids,original_person_ids) VALUES($1,$2,$3,$4,$5,$6,$7,'contacted',$8,$9,$10,$11) ON CONFLICT DO NOTHING RETURNING id`,args)).rows[0]??(await context.db.query<{id:string}>('SELECT id FROM crm_mail_progress_receipts WHERE workspace_id=$1 AND source_id=$2 AND source_revision=$3 AND source_hash=$4',[context.scope.workspaceId,source.sourceId,source.sourceRevision,source.contentHash])).rows[0];if(!receipt)return;
 const requests=(await context.db.query<{id:string;internal_date:Date;contact_id:string;firm_id:string}>(`SELECT m.id,m.internal_date,x.contact_id,x.firm_id FROM mail_messages m JOIN mail_message_matches x ON x.workspace_id=m.workspace_id AND x.mail_message_id=m.id WHERE m.workspace_id=$1 AND m.mailbox_id=$2 AND m.provider_thread_id=$3 AND m.direction='incoming' AND m.internal_date<$4::timestamptz AND x.firm_id=ANY($5::uuid[]) AND x.contact_id IS NOT NULL AND NOT x.ambiguous AND x.selected IS DISTINCT FROM false AND NOT EXISTS(SELECT 1 FROM mail_message_matches other WHERE other.workspace_id=x.workspace_id AND other.mail_message_id=x.mail_message_id AND other.id<>x.id) AND EXISTS(SELECT 1 FROM mail_message_classifications c WHERE c.workspace_id=m.workspace_id AND c.mail_message_id=m.id AND c.layer='deterministic' AND c.class IN ('human','uncertain')) ORDER BY m.id LIMIT 100`,[context.scope.workspaceId,source.mailboxId,canonical.provider_thread_id,source.occurredAt,firmIds])).rows;
 for(const request of requests){
  const incoming=(await context.db.query<{source_revision:number;content_hash:string}>('SELECT source_revision,content_hash FROM crm_mail_sources WHERE workspace_id=$1 AND source_id=$2',[context.scope.workspaceId,request.id])).rows[0];if(!incoming)continue;
  const original=await readMailConversation(context,{sourceId:request.id,sourceRevision:incoming.source_revision,contentHash:incoming.content_hash});if(original.state!=='available')continue;
  if(original.source.accountBinding!==source.accountBinding||original.source.mailboxId!==source.mailboxId||!source.participants.slice(1).includes(original.source.participants[0]!)||!original.source.participants.slice(1).includes(source.participants[0]!))continue;
  const sender=original.source.participants[0]!;
  const routes=(await context.db.query<{contact_id:string|null;firm_id:string;eligibility:string}>('SELECT contact_id,firm_id,eligibility FROM email_addresses WHERE workspace_id=$1 AND address=$2 AND retired_at IS NULL ORDER BY id LIMIT 2',[context.scope.workspaceId,sender])).rows;
  if(routes.length!==1||routes[0]!.contact_id!==request.contact_id||routes[0]!.firm_id!==request.firm_id||routes[0]!.eligibility!=='usable')continue;
  await context.db.query('INSERT INTO crm_mail_reply_resolutions(workspace_id,request_message_id,sent_receipt_id,request_provider_at) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[context.scope.workspaceId,request.id,receipt.id,request.internal_date]);
 }
}

/** Current source authority is checked before source-linked progress is displayed. */
export async function readCrmProgress(context:RepositoryContext,input:{firmId?:string|undefined;personId?:string|undefined;limit:number}){
 const actor=context.scope.actor;if(actor.kind!=='user')return null;
 const rows=(await context.db.query<{id:string;source_id:string;source_revision:number;source_hash:string;event_kind:'contacted'|'replied';original_firm_ids:string[];original_person_ids:string[]}>(`SELECT id,source_id,source_revision,source_hash,event_kind,original_firm_ids,original_person_ids FROM crm_mail_progress_receipts WHERE workspace_id=$1 AND state='active' AND ($2 OR owner_user_id=$3) AND ($4::uuid IS NULL OR $4=ANY(original_firm_ids)) AND ($5::uuid IS NULL OR $5=ANY(original_person_ids)) ORDER BY provider_at,id LIMIT $6`,[context.scope.workspaceId,actor.role==='admin',actor.userId,input.firmId??null,input.personId??null,input.limit+1])).rows;
 const events=[];
 for(const row of rows.slice(0,input.limit)){
  const read=await readMailConversation(context,{sourceId:row.source_id,sourceRevision:row.source_revision,contentHash:row.source_hash});if(read.state!=='available')continue;
  const source=read.source;
  events.push({id:row.id,kind:row.event_kind,occurredAt:source.occurredAt,firmIds:row.original_firm_ids,personIds:row.original_person_ids,source:{workspaceId:context.scope.workspaceId,sourceId:source.sourceId,kind:'mail' as const,revision:source.sourceRevision,contentHash:source.contentHash,locator:null,speaker:null,occurredAt:source.occurredAt,observedAt:source.observedAt,completeness:source.completeness==='complete'?'complete' as const:'partial' as const,availability:'available' as const},evidence:{kind:'mail_source' as const,id:source.sourceId}});
 }
 return {version:1 as const,events,truncated:rows.length>input.limit,coverage:'partial' as const};
}
