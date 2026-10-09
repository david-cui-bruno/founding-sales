import {createHash} from 'node:crypto';
import {callTranscriptUtteranceSchema,meetingSpeechSchema} from '@fss/contracts';
import {repositoryContext,workspaceScope,type RepositoryContext} from '../db/workspaceScope.ts';
import {requestCrmProcessing} from './processing.ts';
import {enqueueJob} from '../jobs/jobStore.ts';
import {readProcessingContext,processingContextHash} from './processingContext.ts';
import type {SourceLookup} from './sourceResolver.ts';
/** Called within the successful original transcript transaction; a failed intent rolls capture back. */
export async function enqueueNativeCrmExtraction(context:RepositoryContext,input:{kind:'call_transcript'|'meeting_transcript';sourceId:string}):Promise<void>{
 const configured=(await context.db.query<{enabled:boolean;revision:number}>('SELECT enabled,revision FROM crm_extraction_purposes WHERE workspace_id=$1',[context.scope.workspaceId])).rows[0];
 if(!configured?.enabled)return;
 const row=input.kind==='call_transcript'?(await context.db.query<{owner:string;firm_id:string;revision:number;utterances:unknown}>(`SELECT c.actor_user_id AS owner,c.firm_id,t.crm_revision AS revision,t.utterances FROM call_transcripts t JOIN call_sessions c ON c.workspace_id=t.workspace_id AND c.id=t.call_session_id WHERE t.workspace_id=$1 AND t.call_session_id=$2`,[context.scope.workspaceId,input.sourceId])).rows[0]:
  (await context.db.query<{owner:string;firm_id:string;revision:number;utterances:unknown}>(`WITH ownership AS (UPDATE meeting_recordings r SET crm_capture_owner_user_id=COALESCE(r.crm_capture_owner_user_id,f.assigned_user_id) FROM meeting_transcripts t,meetings m,firms f WHERE t.workspace_id=$1 AND t.id=$2 AND r.workspace_id=t.workspace_id AND r.id=t.recording_id AND m.workspace_id=r.workspace_id AND m.id=r.meeting_id AND f.workspace_id=m.workspace_id AND f.id=m.firm_id RETURNING r.id,r.workspace_id,r.crm_capture_owner_user_id) SELECT o.crm_capture_owner_user_id AS owner,m.firm_id,t.version AS revision,t.utterances FROM ownership o JOIN meeting_transcripts t ON t.workspace_id=o.workspace_id AND t.recording_id=o.id JOIN meeting_recordings r ON r.workspace_id=t.workspace_id AND r.id=t.recording_id JOIN meetings m ON m.workspace_id=r.workspace_id AND m.id=r.meeting_id WHERE t.id=$2`,[context.scope.workspaceId,input.sourceId])).rows[0];
 if(row?.owner===undefined||row.owner===null)return;
 const membership=(await context.db.query<{role:'admin'|'salesperson';status:string}>('SELECT role,status FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2',[context.scope.workspaceId,row.owner])).rows[0];
 if(membership?.status!=='active')return;
 const parsed=input.kind==='call_transcript'?callTranscriptUtteranceSchema.array().max(5000).safeParse(row.utterances):meetingSpeechSchema.array().max(20000).safeParse(row.utterances);
 if(!parsed.success)return;
 const source:SourceLookup={workspaceId:context.scope.workspaceId,sourceId:input.sourceId,kind:input.kind,revision:row.revision,contentHash:createHash('sha256').update(JSON.stringify(parsed.data)).digest('hex'),locator:null};
 const contextHash=processingContextHash({personId:null,firmIds:[row.firm_id],relationships:[],review:'current'});
 // No source resolver here: capture may already hold native transcription/budget locks.
 // Its exact body-free successor acquires the ordinary authority closure separately.
 await enqueueJob(context.db,{workspaceId:context.scope.workspaceId,kind:'crm.capture_extraction',idempotencyKey:`crm-capture:${createHash('sha256').update(JSON.stringify([input.kind,input.sourceId,row.revision,source.contentHash,row.owner,configured.revision,contextHash])).digest('hex')}`,payload:{source,ownerUserId:row.owner,originalFirmId:row.firm_id,contextHash,purposeRevision:configured.revision}});
}
export async function materializeNativeCrmExtraction(context:RepositoryContext,input:{source:SourceLookup;ownerUserId:string;originalFirmId:string;contextHash:string;purposeRevision:number},fence:()=>Promise<boolean>=async()=>true):Promise<void>{
 const membership=(await context.db.query<{role:'admin'|'salesperson';status:string}>('SELECT role,status FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2',[context.scope.workspaceId,input.ownerUserId])).rows[0];
 if(membership?.status!=='active')return;
 const authorized=repositoryContext(workspaceScope(context.scope.workspaceId,{kind:'user',userId:input.ownerUserId,role:membership.role}),context.db);
 const {resolveCrmSource}=await import('./sourceResolver.ts');
 if(await resolveCrmSource(authorized,input.source)===null)return;
 const configured=(await context.db.query<{enabled:boolean;revision:number}>('SELECT enabled,revision FROM crm_extraction_purposes WHERE workspace_id=$1 FOR SHARE',[context.scope.workspaceId])).rows[0];
 if(!configured?.enabled||configured.revision!==input.purposeRevision)return;
 const current=await readProcessingContext(authorized,input.source);
 if(current===null||processingContextHash(current)!==input.contextHash||current.firmIds.length!==1||current.firmIds[0]!==input.originalFirmId)return;
 if(!await fence())return;
 await requestCrmProcessing(authorized,input.source);
}
