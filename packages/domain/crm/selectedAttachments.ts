import {createHash} from 'node:crypto';
import type {z} from 'zod';
import type {selectedAttachmentFileSchema} from '@fss/contracts';
import {SELECTED_ATTACHMENT_FORMATS} from '@fss/contracts';
import type {selectedAttachmentCommitSchema,selectedAttachmentAnalyzeSchema,selectedAttachmentReselectSchema} from '@fss/contracts';
import {previewSelectedImport,commitSelectedImport,prepareSelectedImport,changeSelectedImport} from './selectedImports.ts';
import {resolveCrmSource} from './sourceResolver.ts';
import {readCrmProcessing,readCrmProcessingHealth,requestCrmProcessing} from './processing.ts';
import {activeIdentityActor,lockIdentityContext} from './identityAccess.ts';
import {recordCrmAuditEvent} from './audit.ts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
export async function previewSelectedAttachment(context:RepositoryContext,input:z.infer<typeof selectedAttachmentFileSchema>){
 if(!await activeIdentityActor(context))return null;
 if(input.completeness!=='complete')return {state:'unsupported' as const,reason:'incomplete_selection' as const,processing:'unavailable' as const,supportedFormats:[...SELECTED_ATTACHMENT_FORMATS],maxBytes:80000 as const,maxCharacters:20000 as const};
 const bytes=Buffer.from(input.bytesBase64,'base64');
 if(bytes.length!==input.declaredByteLength)return {state:'unsupported' as const,reason:'incomplete_selection' as const,processing:'unavailable' as const,supportedFormats:[...SELECTED_ATTACHMENT_FORMATS],maxBytes:80000 as const,maxCharacters:20000 as const};
 if(bytes.toString('base64')!==input.bytesBase64)return null;
 if(bytes.length>80000)return {state:'unsupported' as const,reason:'selection_limit_exceeded' as const,processing:'unavailable' as const,supportedFormats:[...SELECTED_ATTACHMENT_FORMATS],maxBytes:80000 as const,maxCharacters:20000 as const};
 if(bytes.length===0)return {state:'unsupported' as const,reason:'empty_selection' as const,processing:'unavailable' as const,supportedFormats:[...SELECTED_ATTACHMENT_FORMATS],maxBytes:80000 as const,maxCharacters:20000 as const};
 if(bytes.subarray(0,5).equals(Buffer.from('%PDF-')))return {state:'unsupported' as const,reason:'unsupported_format' as const,processing:'unavailable' as const,supportedFormats:[...SELECTED_ATTACHMENT_FORMATS],maxBytes:80000 as const,maxCharacters:20000 as const};
 const extension=/\.([^.]+)$/u.exec(input.fileName)?.[1]?.toLowerCase();
 const format=extension==='txt'?'utf8_text':extension==='md'?'utf8_markdown':extension==='csv'?'utf8_csv':extension==='srt'?'utf8_srt':extension==='vtt'?'utf8_vtt':null;
 if(format===null)return {state:'unsupported' as const,reason:'unsupported_format' as const,processing:'unavailable' as const,supportedFormats:[...SELECTED_ATTACHMENT_FORMATS],maxBytes:80000 as const,maxCharacters:20000 as const};
 let text:string;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{return {state:'unsupported' as const,reason:'unreadable_text' as const,processing:'unavailable' as const,supportedFormats:[...SELECTED_ATTACHMENT_FORMATS],maxBytes:80000 as const,maxCharacters:20000 as const};}
 if(text.includes('\0'))return {state:'unsupported' as const,reason:'unreadable_text' as const,processing:'unavailable' as const,supportedFormats:[...SELECTED_ATTACHMENT_FORMATS],maxBytes:80000 as const,maxCharacters:20000 as const};
 if(text.length>20000)return {state:'unsupported' as const,reason:'selection_limit_exceeded' as const,processing:'unavailable' as const,supportedFormats:[...SELECTED_ATTACHMENT_FORMATS],maxBytes:80000 as const,maxCharacters:20000 as const};
 if(!text.trim())return {state:'unsupported' as const,reason:'empty_selection' as const,processing:'unavailable' as const,supportedFormats:[...SELECTED_ATTACHMENT_FORMATS],maxBytes:80000 as const,maxCharacters:20000 as const};
 return {state:'supported' as const,fileName:input.fileName,byteLength:bytes.length,fileHash:hash(bytes),sourceContentHash:hash(text),format,origin:'user_selected_original' as const,completeness:'complete' as const,processing:'not_requested' as const,previewHash:hash(JSON.stringify(input))};
}
export async function commitSelectedAttachment(context:RepositoryContext,input:z.infer<typeof selectedAttachmentCommitSchema>){
 const preview=await previewSelectedAttachment(context,input.file);
 if(preview===null||preview.state!=='supported'||preview.previewHash!==input.previewHash)return {ok:false as const,reason:'file_selection_changed'};
 const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.from(input.file.bytesBase64,'base64'));
 const selection={text,subtype:'selected_file' as const,label:input.file.fileName,direction:'unknown' as const,participants:input.participants,occurredAt:input.occurredAt,attachments:[]};
 const importPreview=await previewSelectedImport(context,selection);if(importPreview===null)return {ok:false as const,reason:'file_selection_unavailable'};
 const result=await commitSelectedImport(context,{...selection,personId:input.personId,firmId:input.firmId,importKey:`attachment:${input.importKey}`,previewHash:importPreview.previewHash,parserVersion:'selected-v1',commandId:input.commandId,clientVersion:input.clientVersion});
 if(!result.ok)return result;
 await context.db.query(`INSERT INTO crm_selected_file_receipts(workspace_id,source_id,source_revision,metadata_revision,file_hash,source_content_hash,file_name,byte_length,format,parser_version,origin,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'selected-file-utf8-v1','user_selected_original','selected') ON CONFLICT DO NOTHING`,[context.scope.workspaceId,result.value.sourceId,result.value.sourceRevision,result.value.metadataRevision,preview.fileHash,preview.sourceContentHash,preview.fileName,preview.byteLength,preview.format]);
 return result;
}
export async function readSelectedAttachment(context:RepositoryContext,sourceId:string){
 if(!await lockIdentityContext(context,{sourceIds:[sourceId]}))return null;
 const head=(await context.db.query<{owner_user_id:string;revision:number;availability:'available'|'deleted'|'awaiting_recapture'|'unavailable';content_hash:string|null;occurred_at:Date|null;observed_at:Date;metadata_revision:number}>('SELECT s.owner_user_id,s.revision,s.availability,s.content_hash,s.occurred_at,s.observed_at,m.revision AS metadata_revision FROM crm_selected_sources s JOIN crm_selected_imports m ON m.workspace_id=s.workspace_id AND m.source_id=s.id WHERE s.workspace_id=$1 AND s.id=$2 FOR SHARE OF m',[context.scope.workspaceId,sourceId])).rows[0];if(head===undefined)return null;
 const row=(await context.db.query<{source_revision:number;metadata_revision:number;file_hash:string|null;source_content_hash:string|null;file_name:string|null;byte_length:number|null;format:string|null;origin:string|null;state:string}>('SELECT source_revision,metadata_revision,file_hash,source_content_hash,file_name,byte_length,format,origin,state FROM crm_selected_file_receipts WHERE workspace_id=$1 AND source_id=$2 FOR SHARE',[context.scope.workspaceId,sourceId])).rows[0];if(row===undefined)return null;
 const file={state:row.state,sourceRevision:row.source_revision,metadataRevision:head.metadata_revision,fileName:row.file_name,byteLength:row.byte_length,fileHash:row.file_hash,format:row.format,origin:row.origin};
 if(head.availability!=='available'){
  const actor=context.scope.actor;
  if(actor.kind==='user'&&actor.role==='admin'&&actor.userId!==head.owner_user_id)await recordCrmAuditEvent(context,{action:'crm.selected_file_private_read',subjectKind:'selected_source',subjectId:sourceId,detail:{sourceRevision:head.revision,exceptionalAdminRead:true}});
  const processingHealth=await readCrmProcessingHealth(context,{sourceId,kind:'selected_note'});if(processingHealth===null)return null;
  return {processingHealth,file,source:{workspaceId:context.scope.workspaceId,sourceId,kind:'selected_note' as const,revision:head.revision,contentHash:head.content_hash,locator:null,speaker:null,occurredAt:head.occurred_at?.toISOString()??null,observedAt:head.observed_at.toISOString(),completeness:'unavailable' as const,availability:head.availability},processing:{state:'source_unavailable' as const,reason:head.availability==='deleted'?'source_deleted':'source_unavailable'}};
 }
 const source={workspaceId:context.scope.workspaceId,sourceId,kind:'selected_note' as const,revision:head.revision,contentHash:head.content_hash,locator:null};
 const resolved=await resolveCrmSource(context,source);if(resolved===null)return null;
 const processing=await readCrmProcessing(context,source);if(processing===null)return null;
 return {file,source:resolved.source,processing};
}
export async function requestSelectedAttachmentAnalysis(context:RepositoryContext,input:z.infer<typeof selectedAttachmentAnalyzeSchema>){
 const selected=await readSelectedAttachment(context,input.source.sourceId);
 if(selected===null||selected.file.state!=='selected'||selected.file.fileHash!==input.fileHash||selected.source.workspaceId!==input.source.workspaceId||selected.source.revision!==input.source.revision||selected.source.contentHash!==input.source.contentHash)return {ok:false as const,reason:'file_selection_changed'};
 const requested=await requestCrmProcessing(context,input.source);if(!requested.ok)return requested;
 if(requested.value===null||!('generationId' in requested.value))return {ok:false as const,reason:'file_processing_unavailable'};
 return {ok:true as const,value:{sourceId:input.source.sourceId,sourceRevision:input.source.revision,generationId:requested.value.generationId,state:requested.value.state,reason:requested.value.reason}};
}
export async function reselectSelectedAttachment(context:RepositoryContext,input:z.infer<typeof selectedAttachmentReselectSchema>){
 const preview=await previewSelectedAttachment(context,input.file);if(preview===null||preview.state!=='supported'||preview.previewHash!==input.previewHash)return {ok:false as const,reason:'file_selection_changed'};
 if(!await lockIdentityContext(context,{sourceIds:[input.sourceId]}))return {ok:false as const,reason:'file_selection_unavailable'};
 const current=(await context.db.query<{availability:string}>('SELECT availability FROM crm_selected_sources WHERE workspace_id=$1 AND id=$2',[context.scope.workspaceId,input.sourceId])).rows[0];
 const exists=(await context.db.query('SELECT source_id FROM crm_selected_file_receipts WHERE workspace_id=$1 AND source_id=$2',[context.scope.workspaceId,input.sourceId])).rows.length===1;
 if(!exists||current===undefined)return {ok:false as const,reason:'file_selection_unavailable'};
 const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.from(input.file.bytesBase64,'base64'));
 const selection={text,subtype:'selected_file' as const,label:input.file.fileName,direction:'unknown' as const,participants:input.participants,occurredAt:input.occurredAt,attachments:[]};
 const content=await prepareSelectedImport(context,selection);if(content===null)return {ok:false as const,reason:'file_selection_unavailable'};
 const changed=await changeSelectedImport(context,input,current.availability==='awaiting_recapture'?'recapture':'correct',{...selection,previewHash:content.previewHash});if(!changed.ok)return changed;
 await context.db.query(`UPDATE crm_selected_file_receipts SET source_revision=$3,metadata_revision=$4,file_hash=$5,source_content_hash=$6,file_name=$7,byte_length=$8,format=$9,parser_version='selected-file-utf8-v1',origin='user_selected_original',state='selected' WHERE workspace_id=$1 AND source_id=$2`,[context.scope.workspaceId,input.sourceId,changed.value.sourceRevision,changed.value.metadataRevision,preview.fileHash,preview.sourceContentHash,preview.fileName,preview.byteLength,preview.format]);
 return changed;
}
