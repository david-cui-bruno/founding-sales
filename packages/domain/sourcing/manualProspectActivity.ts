import {manualProspectActivityContentSchema,manualProspectActivitySaveInputSchema,manualProspectActivityListInputSchema,manualProspectActivityReadInputSchema,manualProspectActivityListSchema,manualProspectActivityViewSchema,type ManualProspectActivitySaveInput,type ManualProspectActivityMetadata,type ManualProspectActivityView,type ManualProspectActivityList} from '@fss/contracts';
import type {z} from 'zod';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {recordCrmAuditEvent} from '../crm/audit.ts';
import {validManualActivityTime} from './manualProspectActivityTime.ts';
import {lockManualActivityCandidate,currentManualActivityAuthority,type ManualActivityAuthority} from './manualProspectActivityAccess.ts';
interface Row{[key:string]:unknown;candidate_id:string;candidate_revision:number;id:string;revision:number;content:unknown;reason:'withdrawn'|'source_changed_or_unavailable'|'candidate_revision_changed'|'removed'|null;recorded_at:Date;updated_at:Date}
const metadata=(r:Row):ManualProspectActivityMetadata=>({candidateId:r.candidate_id,candidateRevision:r.candidate_revision,attemptId:r.id,activityRevision:r.revision,recordedAt:r.recorded_at.toISOString(),updatedAt:r.updated_at.toISOString(),availability:r.reason===null?'available':r.reason==='withdrawn'?'withdrawn':'unavailable'});
async function fetchRow(ctx:RepositoryContext,id:string):Promise<Row|null>{return (await ctx.db.query<Row>('SELECT * FROM sourcing_manual_prospect_attempts WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.scope.workspaceId,id])).rows[0]??null;}
const wall=async(ctx:RepositoryContext):Promise<Date>=>(await ctx.db.query<{at:Date}>('SELECT clock_timestamp() at')).rows[0]!.at;
/** Opaque IDs/revisions only may leave this function in a command receipt. */
export async function saveManualProspectActivity(ctx:RepositoryContext,raw:ManualProspectActivitySaveInput,authority:ManualActivityAuthority){
 const parsed=manualProspectActivitySaveInputSchema.safeParse(raw);if(!parsed.success)return {ok:false as const,reason:'invalid_input'};
 const input=parsed.data;
 await lockManualActivityCandidate(ctx,input.candidateId,input.expectedCandidateRevision);
 const prior=await fetchRow(ctx,input.attemptId);
 await currentManualActivityAuthority(ctx,input.candidateId,input.expectedCandidateRevision,authority);
 if(input.operation==='create'&&prior)return {ok:false as const,reason:'already_exists'};
 if(input.operation!=='create'&&(!prior||prior.candidate_id!==input.candidateId||prior.candidate_revision!==input.expectedCandidateRevision))return {ok:false as const,reason:'not_found'};
 if(prior?.reason)return {ok:false as const,reason:'removed'};
 if(input.operation!=='create'&&prior?.revision!==input.expectedActivityRevision)return {ok:false as const,reason:'stale_revision'};
 const content=input.operation==='withdraw'?null:manualProspectActivityContentSchema.parse({performedByUser:input.performedByUser,channel:input.channel,occurrence:input.occurrence,result:input.result,note:input.note,callback:input.callback});
 if(content&&!validManualActivityTime(content,await wall(ctx)))return {ok:false as const,reason:'invalid_time'};
 const reason=input.operation==='withdraw'?'withdrawn':null;
 const row=input.operation==='create'?(await ctx.db.query<Row>(`INSERT INTO sourcing_manual_prospect_attempts(workspace_id,candidate_id,id,candidate_revision,content) VALUES($1,$2,$3,$4,$5::jsonb) RETURNING *`,[ctx.scope.workspaceId,input.candidateId,input.attemptId,input.expectedCandidateRevision,JSON.stringify(content)])).rows[0]!:
  (await ctx.db.query<Row>('UPDATE sourcing_manual_prospect_attempts SET content=$3::jsonb,reason=$4,revision=revision+1,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 RETURNING *',[ctx.scope.workspaceId,input.attemptId,content?JSON.stringify(content):null,reason])).rows[0]!;
 await recordCrmAuditEvent(ctx,{action:'sourcing.manual_activity_saved',subjectKind:'sourcing_manual_activity',subjectId:row.id,detail:{revision:row.revision}});
 // An authority/source failure throws so the caller's entire command rolls back.
 await currentManualActivityAuthority(ctx,input.candidateId,input.expectedCandidateRevision,authority);
 return {ok:true as const,value:{candidateId:row.candidate_id,candidateRevision:row.candidate_revision,attemptId:row.id,activityRevision:row.revision}};
}
export async function listManualProspectActivity(ctx:RepositoryContext,raw:z.infer<typeof manualProspectActivityListInputSchema>,authority:ManualActivityAuthority):Promise<ManualProspectActivityList>{
 const input=manualProspectActivityListInputSchema.parse(raw);await lockManualActivityCandidate(ctx,input.candidateId,input.expectedCandidateRevision);
 const rows=(await ctx.db.query<Row>('SELECT * FROM sourcing_manual_prospect_attempts WHERE workspace_id=$1 AND candidate_id=$2 AND candidate_revision=$3 AND ($4::uuid IS NULL OR id>$4) ORDER BY id LIMIT 21 FOR UPDATE',[ctx.scope.workspaceId,input.candidateId,input.expectedCandidateRevision,input.afterId??null])).rows;
 await currentManualActivityAuthority(ctx,input.candidateId,input.expectedCandidateRevision,authority);
 const activities=rows.slice(0,20).map(metadata);
 return manualProspectActivityListSchema.parse({activities,nextAfterId:rows.length>20?activities.at(-1)!.attemptId:null});
}
export async function readManualProspectActivity(ctx:RepositoryContext,raw:z.infer<typeof manualProspectActivityReadInputSchema>,authority:ManualActivityAuthority):Promise<ManualProspectActivityView|null>{
 const input=manualProspectActivityReadInputSchema.parse(raw);await lockManualActivityCandidate(ctx,input.candidateId,input.expectedCandidateRevision);
 const row=await fetchRow(ctx,input.attemptId);
 await currentManualActivityAuthority(ctx,input.candidateId,input.expectedCandidateRevision,authority);
 if(!row||row.candidate_id!==input.candidateId||row.candidate_revision!==input.expectedCandidateRevision)return null;
 const m=metadata(row);
 return manualProspectActivityViewSchema.parse(row.reason==='withdrawn'?{...m,availability:'withdrawn'}:row.reason?{...m,availability:'unavailable',reason:row.reason}:{...m,...manualProspectActivityContentSchema.parse(row.content),availability:'available',qualification:'unverified',contactAuthority:'not_granted',reportBasis:'user_reported_unverified'});
}
