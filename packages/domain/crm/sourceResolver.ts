import {unavailableMailEvidence,type CrmMailEvidencePort} from './mailEvidence.ts';
import { callTranscriptUtteranceSchema, transcriptIsChannelLabelled, meetingSpeechSchema, type CanonicalSourceReference } from '@fss/contracts';
import { createHash } from 'node:crypto';
import { activeIdentityActor } from './identityAccess.ts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { lockIdentityContext } from './identityAccess.ts';
import { recordCrmAuditEvent } from './audit.ts';

export interface SourceLookup {
  readonly workspaceId: string;
  readonly sourceId: string;
  readonly kind: CanonicalSourceReference['kind'];
  readonly revision: number;
  readonly contentHash: string | null;
  readonly locator: string | null;
}

/** Resolve allowed original text, never content or attribution supplied by a caller. */
export async function resolveCrmSource(context: RepositoryContext, input: SourceLookup,mailEvidence:CrmMailEvidencePort=unavailableMailEvidence) {
  if (input.workspaceId !== context.scope.workspaceId) return null;
  if(input.kind==='mail'){const mail=await mailEvidence.resolve(context,input);return mail===null?null:{state:'available' as const,...mail};}
  if (input.kind === 'meeting_transcript') return resolveMeeting(context,input);
  if(input.kind==='call_transcript')return resolveCall(context,input);
  if (input.kind !== 'selected_note'
    || !await lockIdentityContext(context, { sourceIds: [input.sourceId] })) return null;
  const source = (await context.db.query<{
    id: string; revision: number; availability: string; excerpt: string | null;
    content_hash: string | null; occurred_at: Date | null; observed_at: Date;
  }>('SELECT id,revision,availability,excerpt,content_hash,occurred_at,observed_at FROM crm_selected_sources WHERE workspace_id=$1 AND id=$2',
    [context.scope.workspaceId, input.sourceId])).rows[0];
  if (source === undefined || source.availability !== 'available' || source.excerpt === null
    || source.revision !== input.revision || source.content_hash !== input.contentHash) return null;
  const range = /^text:(0|[1-9]\d{0,7}):(0|[1-9]\d{0,7})$/u.exec(input.locator ?? '');
  if (input.locator !== null && range === null) return null;
  const start = Number(range?.[1] ?? '0');
  const end = Number(range?.[2] ?? '0');
  if (input.locator !== null && (start >= end || end > source.excerpt.length || end - start > 2000)) return null;
  const splitsCharacter = (offset: number) => offset > 0 && offset < source.excerpt!.length
    && source.excerpt!.charCodeAt(offset - 1) >= 0xd800 && source.excerpt!.charCodeAt(offset - 1) <= 0xdbff
    && source.excerpt!.charCodeAt(offset) >= 0xdc00 && source.excerpt!.charCodeAt(offset) <= 0xdfff;
  if (input.locator !== null && (splitsCharacter(start) || splitsCharacter(end))) return null;
  const reference: CanonicalSourceReference = {
    workspaceId: context.scope.workspaceId, sourceId: source.id, kind: 'selected_note', revision: source.revision,
    contentHash: source.content_hash, locator: input.locator, speaker: null,
    occurredAt: source.occurred_at?.toISOString() ?? null, observedAt: source.observed_at.toISOString(),
    completeness: 'selected_excerpt', availability: 'available',
  };
  if (context.scope.actor.kind === 'user' && context.scope.actor.role === 'admin') {
    await recordCrmAuditEvent(context, {
      action: 'crm.evidence_source_read', subjectKind: 'selected_source', subjectId: source.id,
      detail: { sourceRevision: source.revision, exceptionalAdminRead: true },
    });
  }
  return { state: 'available' as const, source: reference, extent: { unit: 'utf16' as const, length: source.excerpt.length },
    passage: input.locator === null ? null : { text: source.excerpt.slice(start, end), locator: input.locator, speaker: null } };
}

/** Native CRM history cannot move to a newly assigned person with the operational firm. */
async function nativeHistoryPermitted(context:RepositoryContext,kind:'call_transcript'|'meeting_transcript',sourceId:string){
 const actor=context.scope.actor;if(actor.kind!=='user')return false;if(actor.role==='admin')return true;
 const original=(await context.db.query<{owner_user_id:string;original_firm_id:string|null}>('SELECT coalesce(source_owner_user_id,requested_by) AS owner_user_id,original_firm_id FROM crm_extraction_generations WHERE workspace_id=$1 AND source_id=$2 AND source_kind=$3 ORDER BY observed_at,id LIMIT 1',[context.scope.workspaceId,sourceId,kind])).rows[0];
 if(original!==undefined){if(original.owner_user_id!==actor.userId)return false;const live=(await context.db.query<{firm_id:string}>(kind==='call_transcript'?'SELECT firm_id FROM call_sessions WHERE workspace_id=$1 AND id=$2':'SELECT m.firm_id FROM meeting_transcripts t JOIN meeting_recordings r ON r.workspace_id=t.workspace_id AND r.id=t.recording_id JOIN meetings m ON m.workspace_id=r.workspace_id AND m.id=r.meeting_id WHERE t.workspace_id=$1 AND t.id=$2',[context.scope.workspaceId,sourceId])).rows[0];return live===undefined||live.firm_id===original.original_firm_id;}
 if(kind==='call_transcript')return (await context.db.query<{actor_user_id:string}>('SELECT actor_user_id FROM call_sessions WHERE workspace_id=$1 AND id=$2',[context.scope.workspaceId,sourceId])).rows[0]?.actor_user_id===actor.userId;
 const captured=(await context.db.query<{owner:string|null}>('SELECT r.crm_capture_owner_user_id AS owner FROM meeting_transcripts t JOIN meeting_recordings r ON r.workspace_id=t.workspace_id AND r.id=t.recording_id WHERE t.workspace_id=$1 AND t.id=$2',[context.scope.workspaceId,sourceId])).rows[0]?.owner;
 return captured===null||captured===actor.userId;
}

/** Native transcript identity is its immutable original row; no universal content store. */
async function resolveMeeting(context: RepositoryContext, input: SourceLookup) {
  const actor=context.scope.actor;
  if(actor.kind!=='user'||!await activeIdentityActor(context)||!await nativeHistoryPermitted(context,'meeting_transcript',input.sourceId))return null;
  const identity=()=>context.db.query<{meeting_id:string;firm_id:string;recording_id:string}>(`SELECT r.meeting_id,m.firm_id,t.recording_id FROM meeting_transcripts t
    JOIN meeting_recordings r ON r.workspace_id=t.workspace_id AND r.id=t.recording_id
    JOIN meetings m ON m.workspace_id=r.workspace_id AND m.id=r.meeting_id
    WHERE t.workspace_id=$1 AND t.id=$2`,[context.scope.workspaceId,input.sourceId]);
  const before=(await identity()).rows[0];
  if(before===undefined||before.firm_id===null)return null;
  const firm=(await context.db.query<{assigned_user_id:string;status:string}>('SELECT assigned_user_id,status FROM firms WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[context.scope.workspaceId,before.firm_id])).rows[0];
  if(firm===undefined||actor.role!=='admin'&&(firm.status!=='active'||firm.assigned_user_id!==actor.userId))return null;
  await context.db.query('SELECT id FROM meetings WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[context.scope.workspaceId,before.meeting_id]);
  await context.db.query('SELECT id FROM meeting_recordings WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[context.scope.workspaceId,before.recording_id]);
  const after=(await identity()).rows[0];
  if(after?.firm_id!==before.firm_id||after.meeting_id!==before.meeting_id||after.recording_id!==before.recording_id||!await activeIdentityActor(context)||!await nativeHistoryPermitted(context,'meeting_transcript',input.sourceId))return null;
  const row=(await context.db.query<{version:number;utterances:unknown[];created_at:Date;starts_at:Date}>(`SELECT t.version,t.utterances,t.created_at,m.starts_at FROM meeting_transcripts t
    JOIN meeting_recordings r ON r.workspace_id=t.workspace_id AND r.id=t.recording_id
    JOIN meetings m ON m.workspace_id=r.workspace_id AND m.id=r.meeting_id WHERE t.workspace_id=$1 AND t.id=$2 FOR SHARE OF t`,[context.scope.workspaceId,input.sourceId])).rows[0];
  if(row===undefined||row.version!==input.revision||row.utterances.length>20000)return null;
  const parsed=meetingSpeechSchema.array().safeParse(row.utterances);
  if(!parsed.success)return null;
  const hash=createHash('sha256').update(JSON.stringify(parsed.data)).digest('hex');
  if(hash!==input.contentHash)return null;
  const range=/^utterance:(0|[1-9]\d{0,5}):text:(0|[1-9]\d{0,7}):(0|[1-9]\d{0,7})$/u.exec(input.locator??'');
  if(input.locator!==null&&range===null)return null;
  const speech=range===null?null:parsed.data[Number(range[1])];
  const start=Number(range?.[2]??0),end=Number(range?.[3]??0);
  if(range!==null&&(speech===undefined||speech===null||start>=end||end>speech.text.length||end-start>2000))return null;
  const text=speech?.text??'';
  const split=(offset:number)=>offset>0&&offset<text.length&&/[\uD800-\uDBFF]/u.test(text[offset-1]!)&&/[\uDC00-\uDFFF]/u.test(text[offset]!);
  if(range!==null&&(split(start)||split(end)))return null;
  if(actor.role==='admin')await recordCrmAuditEvent(context,{action:'crm.evidence_source_read',subjectKind:'meeting_transcript',subjectId:input.sourceId,detail:{sourceRevision:row.version,exceptionalAdminRead:true}});
  if(!await activeIdentityActor(context))return null;
  const source:CanonicalSourceReference={workspaceId:context.scope.workspaceId,sourceId:input.sourceId,kind:'meeting_transcript',revision:row.version,contentHash:hash,
    locator:input.locator,speaker:speech?.speaker??null,occurredAt:row.starts_at.toISOString(),observedAt:row.created_at.toISOString(),completeness:'partial',availability:'available'};
  return {state:'available' as const,source,extent:{unit:'utf16' as const,length:parsed.data.reduce((total,u)=>total+u.text.length,0)},
    passage:speech===null||speech===undefined?null:{text:speech.text.slice(start,end),locator:input.locator!,speaker:speech.speaker}};
}

/** A transient model input assembled from the current original, never persisted in job payloads. */
export async function loadCrmExtractionText(context:RepositoryContext,input:SourceLookup):Promise<string|null>{
 if(await resolveCrmSource(context,{...input,locator:null})===null)return null;
 if(input.kind==='selected_note'){
  const text=(await context.db.query<{excerpt:string}>('SELECT excerpt FROM crm_selected_sources WHERE workspace_id=$1 AND id=$2',[context.scope.workspaceId,input.sourceId])).rows[0]?.excerpt;
  return text!==undefined&&Buffer.byteLength(text)<=80000?text:null;
 }
 if(input.kind==='call_transcript'){
  const raw=(await context.db.query<{provider:string;model:string;utterances:unknown[]}>('SELECT provider,model,utterances FROM call_transcripts WHERE workspace_id=$1 AND call_session_id=$2',[context.scope.workspaceId,input.sourceId])).rows[0];
  const parsed=callTranscriptUtteranceSchema.array().max(5000).safeParse(raw?.utterances);if(!parsed.success||raw===undefined)return null;
  const text=JSON.stringify(parsed.data.map((row,index)=>({utterance:index,speaker:`${transcriptIsChannelLabelled(raw)?'channel':'diarizer'}:${row.speaker}`,text:row.text,locator:`utterance:${index}:text:0:${row.text.length}`})));
  return Buffer.byteLength(text)<=80000?text:null;
 }
 if(input.kind==='meeting_transcript'){
  const raw=(await context.db.query<{utterances:unknown[]}>('SELECT utterances FROM meeting_transcripts WHERE workspace_id=$1 AND id=$2',[context.scope.workspaceId,input.sourceId])).rows[0]?.utterances;
  const parsed=meetingSpeechSchema.array().max(20000).safeParse(raw);if(!parsed.success)return null;
  const text=JSON.stringify(parsed.data.map((row,index)=>({utterance:index,speaker:row.speaker,attribution:row.attribution,text:row.text,locator:`utterance:${index}:text:0:${row.text.length}`})));
  return Buffer.byteLength(text)<=80000?text:null;
 }
 return null;
}

async function resolveCall(context:RepositoryContext,input:SourceLookup){
 const actor=context.scope.actor;if(actor.kind!=='user'||!await activeIdentityActor(context)||!await nativeHistoryPermitted(context,'call_transcript',input.sourceId))return null;
 const before=(await context.db.query<{firm_id:string}>('SELECT firm_id FROM call_sessions WHERE workspace_id=$1 AND id=$2',[context.scope.workspaceId,input.sourceId])).rows[0];
 if(before===undefined)return null;
 const firm=(await context.db.query<{assigned_user_id:string;status:string}>('SELECT assigned_user_id,status FROM firms WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[context.scope.workspaceId,before.firm_id])).rows[0];
 if(firm===undefined||actor.role!=='admin'&&(firm.status!=='active'||firm.assigned_user_id!==actor.userId))return null;
 const session=(await context.db.query<{firm_id:string;started_at:Date|null}>('SELECT firm_id,started_at FROM call_sessions WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[context.scope.workspaceId,input.sourceId])).rows[0];
 if(session?.firm_id!==before.firm_id||!await activeIdentityActor(context))return null;
 const row=(await context.db.query<{crm_revision:number;provider:string;model:string;utterances:unknown[];created_at:Date}>('SELECT crm_revision,provider,model,utterances,created_at FROM call_transcripts WHERE workspace_id=$1 AND call_session_id=$2 FOR SHARE',[context.scope.workspaceId,input.sourceId])).rows[0];
 if(row===undefined||row.crm_revision!==input.revision)return null;
 const parsed=callTranscriptUtteranceSchema.array().max(5000).safeParse(row.utterances);if(!parsed.success)return null;
 const hash=createHash('sha256').update(JSON.stringify(parsed.data)).digest('hex');if(hash!==input.contentHash)return null;
 const range=/^utterance:(0|[1-9]\d{0,5}):text:(0|[1-9]\d{0,7}):(0|[1-9]\d{0,7})$/u.exec(input.locator??'');if(input.locator!==null&&range===null)return null;
 const speech=range===null?null:parsed.data[Number(range[1])];const start=Number(range?.[2]??0),end=Number(range?.[3]??0);
 if(range!==null&&(speech==null||start>=end||end>speech.text.length||end-start>2000))return null;
 const text=speech?.text??'';const split=(offset:number)=>offset>0&&offset<text.length&&/[\uD800-\uDBFF]/u.test(text[offset-1]!)&&/[\uDC00-\uDFFF]/u.test(text[offset]!);if(range!==null&&(split(start)||split(end)))return null;
 const speaker=speech==null?null:`${transcriptIsChannelLabelled(row)?'channel':'diarizer'}:${speech.speaker}`;
 if(actor.role==='admin')await recordCrmAuditEvent(context,{action:'crm.evidence_source_read',subjectKind:'call_transcript',subjectId:input.sourceId,detail:{sourceRevision:row.crm_revision,exceptionalAdminRead:true}});
 if(!await activeIdentityActor(context)||!await nativeHistoryPermitted(context,'call_transcript',input.sourceId))return null;
 const source:CanonicalSourceReference={workspaceId:context.scope.workspaceId,sourceId:input.sourceId,kind:'call_transcript',revision:row.crm_revision,contentHash:hash,locator:input.locator,speaker,occurredAt:session.started_at?.toISOString()??null,observedAt:row.created_at.toISOString(),completeness:'partial',availability:'available'};
 return {state:'available' as const,source,extent:{unit:'utf16' as const,length:parsed.data.reduce((total,u)=>total+u.text.length,0)},passage:speech==null?null:{text:speech.text.slice(start,end),locator:input.locator!,speaker}};
}

/** Body-free health can survive an erased native original, with its captured firm scope. */
export async function readNativeCrmSourceState(context:RepositoryContext,input:{sourceId:string;kind:SourceLookup['kind']}){
 const actor=context.scope.actor;if(actor.kind!=='user'||!await activeIdentityActor(context)||!['call_transcript','meeting_transcript'].includes(input.kind))return null;
 const locate=async()=> input.kind==='call_transcript'?(await context.db.query<{firm_id:string;revision:number}>('SELECT s.firm_id,t.crm_revision AS revision FROM call_sessions s JOIN call_transcripts t ON t.workspace_id=s.workspace_id AND t.call_session_id=s.id WHERE s.workspace_id=$1 AND s.id=$2',[context.scope.workspaceId,input.sourceId])).rows[0]:(await context.db.query<{firm_id:string;revision:number}>('SELECT m.firm_id,t.version AS revision FROM meeting_transcripts t JOIN meeting_recordings r ON r.workspace_id=t.workspace_id AND r.id=t.recording_id JOIN meetings m ON m.workspace_id=r.workspace_id AND m.id=r.meeting_id WHERE t.workspace_id=$1 AND t.id=$2',[context.scope.workspaceId,input.sourceId])).rows[0];
 const originalOwner=(await context.db.query<{owner_user_id:string}>('SELECT coalesce(source_owner_user_id,requested_by) AS owner_user_id FROM crm_extraction_generations WHERE workspace_id=$1 AND source_id=$2 AND source_kind=$3 ORDER BY observed_at,id LIMIT 1',[context.scope.workspaceId,input.sourceId,input.kind])).rows[0]?.owner_user_id;
 if(originalOwner!==undefined&&actor.role!=='admin'&&originalOwner!==actor.userId)return null;
 const existing=await locate();
 const last=existing===undefined?(await context.db.query<{original_firm_id:string|null;source_revision:number;state:string}>('SELECT original_firm_id,source_revision,state FROM crm_extraction_generations WHERE workspace_id=$1 AND source_id=$2 AND source_kind=$3 ORDER BY observed_at DESC,id DESC LIMIT 1',[context.scope.workspaceId,input.sourceId,input.kind])).rows[0]:undefined;
 const originalFirm=(await context.db.query<{original_firm_id:string|null}>('SELECT original_firm_id FROM crm_extraction_generations WHERE workspace_id=$1 AND source_id=$2 AND source_kind=$3 ORDER BY observed_at,id LIMIT 1',[context.scope.workspaceId,input.sourceId,input.kind])).rows[0]?.original_firm_id;
 const firmId=originalFirm??existing?.firm_id??last?.original_firm_id;if(firmId==null)return null;
 const firm=(await context.db.query<{assigned_user_id:string;status:string}>('SELECT assigned_user_id,status FROM firms WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[context.scope.workspaceId,firmId])).rows[0];
 if(firm===undefined||actor.role!=='admin'&&(firm.status!=='active'||firm.assigned_user_id!==actor.userId)||!await activeIdentityActor(context))return null;
 if(actor.role==='admin')await recordCrmAuditEvent(context,{action:'crm.processing_health_read',subjectKind:input.kind,subjectId:input.sourceId,detail:{exceptionalAdminRead:true}});
 const current=await locate();if(current!==undefined&&current.firm_id!==firmId&&actor.role!=='admin'||!await nativeHistoryPermitted(context,input.kind==='call_transcript'?'call_transcript':'meeting_transcript',input.sourceId))return null;
 return {revision:current?.revision??last?.source_revision??existing?.revision??1,availability:current!==undefined?'available':last?.state==='deleted'?'deleted':'unavailable'};
}

/** Derive an exact native reference from its original store, then use the normal ACL resolver. */
export async function nativeProcessingReference(context:RepositoryContext,kind:'call_transcript'|'meeting_transcript',sourceId:string):Promise<CanonicalSourceReference|null>{
 const row=(await context.db.query<{revision:number;utterances:unknown}>(kind==='call_transcript'?'SELECT crm_revision AS revision,utterances FROM call_transcripts WHERE workspace_id=$1 AND call_session_id=$2':'SELECT version AS revision,utterances FROM meeting_transcripts WHERE workspace_id=$1 AND id=$2',[context.scope.workspaceId,sourceId])).rows[0];
 if(row===undefined)return null;
 const parsed=kind==='call_transcript'?callTranscriptUtteranceSchema.array().max(5000).safeParse(row.utterances):meetingSpeechSchema.array().max(20000).safeParse(row.utterances);
 if(!parsed.success)return null;
 const contentHash=createHash('sha256').update(JSON.stringify(parsed.data)).digest('hex');
 return (await resolveCrmSource(context,{workspaceId:context.scope.workspaceId,kind,sourceId,revision:row.revision,contentHash,locator:null}))?.source??null;
}
