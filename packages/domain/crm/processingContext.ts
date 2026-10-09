import {unavailableMailEvidence,type CrmMailEvidencePort} from './mailEvidence.ts';
import {createHash} from 'node:crypto';
import {crmClaimContextSchema,type CrmClaimContext} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import type {SourceLookup} from './sourceResolver.ts';
/** This describes the exact original source context; it never infers a speaker or firm from text. */
export async function readProcessingContext(context:RepositoryContext,source:SourceLookup,mailEvidence:CrmMailEvidencePort=unavailableMailEvidence):Promise<CrmClaimContext|null>{
 if(source.kind==='mail')return mailEvidence.readContext(context,source);
 if(source.kind==='selected_note'){
  const row=(await context.db.query<{person_id:string|null;firm_id:string|null}>('SELECT person_id,firm_id FROM crm_selected_sources WHERE workspace_id=$1 AND id=$2 AND revision=$3 AND content_hash=$4',[context.scope.workspaceId,source.sourceId,source.revision,source.contentHash])).rows[0];if(row===undefined)return null;
  const contexts=(await context.db.query<{firm_id:string;relationship_id:string;relationship_revision:number;review:'current'|'required'}>('SELECT firm_id,relationship_id,relationship_revision,review FROM crm_source_relationship_contexts WHERE workspace_id=$1 AND source_id=$2 AND source_revision=$3 AND source_hash=$4 ORDER BY relationship_id,relationship_revision LIMIT 101',[context.scope.workspaceId,source.sourceId,source.revision,source.contentHash])).rows;
  if(contexts.length>100)return null;
  return {personId:row.person_id,firmIds:[...new Set([...(row.firm_id===null?[]:[row.firm_id]),...contexts.map(value=>value.firm_id)])].sort(),relationships:contexts.map(value=>({relationshipId:value.relationship_id,revision:value.relationship_revision})),review:contexts.some(value=>value.review==='required')?'required':'current'};
 }
 const original=(await context.db.query<{original_firm_id:string|null}>('SELECT original_firm_id FROM crm_extraction_generations WHERE workspace_id=$1 AND source_id=$2 AND source_kind=$3 ORDER BY observed_at,id LIMIT 1',[context.scope.workspaceId,source.sourceId,source.kind])).rows[0]?.original_firm_id;
 if(original!==undefined&&original!==null)return {personId:null,firmIds:[original],relationships:[],review:'current'};
 const row=source.kind==='call_transcript'?(await context.db.query<{firm_id:string}>('SELECT firm_id FROM call_sessions WHERE workspace_id=$1 AND id=$2',[context.scope.workspaceId,source.sourceId])).rows[0]:(await context.db.query<{firm_id:string|null}>('SELECT m.firm_id FROM meeting_transcripts t JOIN meeting_recordings r ON r.workspace_id=t.workspace_id AND r.id=t.recording_id JOIN meetings m ON m.workspace_id=r.workspace_id AND m.id=r.meeting_id WHERE t.workspace_id=$1 AND t.id=$2',[context.scope.workspaceId,source.sourceId])).rows[0];
 return row===undefined||row.firm_id===null?null:{personId:null,firmIds:[row.firm_id],relationships:[],review:'current'};
}
export function parsedProcessingContext(value:unknown):CrmClaimContext|null{const parsed=crmClaimContextSchema.safeParse(value);return parsed.success?parsed.data:null;}
/** A correction may request context review, but cannot relabel original IDs/relationship revisions. */
export function sameProcessingContext(original:CrmClaimContext,current:CrmClaimContext){return processingContextHash(original)===processingContextHash(current);}

/** Stable IDs/revisions define generation identity; review flags never rebind a source. */
export function processingContextHash(value:CrmClaimContext){
 const base=`${value.personId??''}|${value.firmIds.join(',')}|${value.relationships.map(row=>`${row.relationshipId}:${row.revision}`).join(',')}`;
 const mail=value.mailContexts?.map(row=>[row.contextId,row.sourceRevision,row.personId,row.firmId,row.opportunityId,row.operationalMatchId,row.operationalMatchHash,row.kind]).sort((a,b)=>JSON.stringify(a)<JSON.stringify(b)?-1:JSON.stringify(a)>JSON.stringify(b)?1:0);
 return createHash('sha256').update(mail===undefined||mail.length===0?base:`${base}|mail:${JSON.stringify(mail)}`).digest('hex');
}

export const NATIVE_PROCESSING_AUTHORIZATION_HASH=createHash('sha256').update('none/native').digest('hex');

export const UNAVAILABLE_MAIL_AUTHORIZATION_HASH=createHash('sha256').update('none/mail').digest('hex');
