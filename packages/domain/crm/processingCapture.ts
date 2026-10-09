import {createHash} from 'node:crypto';
import {callTranscriptUtteranceSchema,meetingSpeechSchema} from '@fss/contracts';
import {repositoryContext,workspaceScope,type RepositoryContext} from '../db/workspaceScope.ts';
import {requestCrmProcessing} from './processing.ts';
/** Called within the successful original transcript transaction; a failed intent rolls capture back. */
export async function enqueueNativeCrmExtraction(context:RepositoryContext,input:{kind:'call_transcript'|'meeting_transcript';sourceId:string}):Promise<void>{
 const configured=(await context.db.query<{enabled:boolean}>('SELECT enabled FROM crm_extraction_purposes WHERE workspace_id=$1',[context.scope.workspaceId])).rows[0];
 if(!configured?.enabled)return;
 const row=input.kind==='call_transcript'?(await context.db.query<{owner:string;revision:number;utterances:unknown}>(`SELECT c.actor_user_id AS owner,t.crm_revision AS revision,t.utterances FROM call_transcripts t JOIN call_sessions c ON c.workspace_id=t.workspace_id AND c.id=t.call_session_id WHERE t.workspace_id=$1 AND t.call_session_id=$2`,[context.scope.workspaceId,input.sourceId])).rows[0]:
  (await context.db.query<{owner:string;revision:number;utterances:unknown}>(`WITH ownership AS (UPDATE meeting_recordings r SET crm_capture_owner_user_id=COALESCE(r.crm_capture_owner_user_id,f.assigned_user_id) FROM meeting_transcripts t,meetings m,firms f WHERE t.workspace_id=$1 AND t.id=$2 AND r.workspace_id=t.workspace_id AND r.id=t.recording_id AND m.workspace_id=r.workspace_id AND m.id=r.meeting_id AND f.workspace_id=m.workspace_id AND f.id=m.firm_id RETURNING r.id,r.workspace_id,r.crm_capture_owner_user_id) SELECT o.crm_capture_owner_user_id AS owner,t.version AS revision,t.utterances FROM ownership o JOIN meeting_transcripts t ON t.workspace_id=o.workspace_id AND t.recording_id=o.id WHERE t.id=$2`,[context.scope.workspaceId,input.sourceId])).rows[0];
 if(row?.owner===undefined||row.owner===null)return;
 const membership=(await context.db.query<{role:'admin'|'salesperson';status:string}>('SELECT role,status FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2',[context.scope.workspaceId,row.owner])).rows[0];
 if(membership?.status!=='active')return;
 const parsed=input.kind==='call_transcript'?callTranscriptUtteranceSchema.array().max(5000).safeParse(row.utterances):meetingSpeechSchema.array().max(20000).safeParse(row.utterances);
 if(!parsed.success)return;
 const authorized=repositoryContext(workspaceScope(context.scope.workspaceId,{kind:'user',userId:row.owner,role:membership.role}),context.db);
 const result=await requestCrmProcessing(authorized,{workspaceId:context.scope.workspaceId,sourceId:input.sourceId,kind:input.kind,revision:row.revision,contentHash:createHash('sha256').update(JSON.stringify(parsed.data)).digest('hex'),locator:null});
 if(!result.ok)return;
}
