import {saveMeetingQualificationSchema,type SaveMeetingQualification,type QualificationAnswer,type QualificationField,type QualificationEvidence,type MeetingQualificationView} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {readFirm} from '../crm/firms.ts';
import {decideFirmRead} from '../crm/authorization.ts';
import {lockSendGateForStopFact} from '../policy/sendGate.ts';
import {recordFunnelFact} from '../funnel/facts.ts';
import {recordCrmAuditEvent} from '../crm/audit.ts';
import {authoritativeAnalysis} from '../calls/proposalMeasure.ts';
import {lockAnalysisMeeting} from './analysisRequests.ts';
import {readMeetingOutcomes} from './outcomes.ts';
import type {SourcingResult} from '../sourcing/qualificationStore.ts';
const fields:QualificationField[]=['buyingParticipant','maintenanceNeed','openToPaying'];
type Row={invalidated_at:Date|null;revision:number;buying_participant:QualificationAnswer;maintenance_need:QualificationAnswer;open_to_paying:QualificationAnswer;evidence:QualificationEvidence[];command_id:string;created_by_user_id:string};
type Meeting={firm_id:string;state:string;attendance_source:string|null;attendance_confirmed_at:Date|null;notes_revision:number;transcript_source_revision:number;outcomes_review_required:boolean};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

async function evidenceCurrent(ctx:RepositoryContext,meetingId:string,meeting:Meeting,e:QualificationEvidence,commandId:string,revision:number):Promise<boolean>{
 if(e.sourceKind==='user_confirmation')return e.sourceId===commandId&&e.sourceRevision===revision;
 const w=ctx.scope.workspaceId;
 if(e.sourceKind==='user_note')return e.sourceId===meetingId&&e.sourceRevision===meeting.notes_revision&&(await ctx.db.query("SELECT 1 FROM meeting_note_revisions WHERE workspace_id=$1 AND meeting_id=$2 AND revision=$3 AND length(btrim(debrief))>0",[w,meetingId,e.sourceRevision])).rows.length===1;
 const slash=e.sourceId.indexOf('/');if(slash<0)return false;
 const analysisId=e.sourceId.slice(0,slash),itemId=e.sourceId.slice(slash+1);if(!uuid.test(analysisId)||!itemId)return false;
 if(e.sourceKind==='meeting_item'){
  const view=await readMeetingOutcomes(ctx,{meetingId});
  if(!view||view.state!=='current'||view.analysisId!==analysisId||view.notes.revision!==e.sourceRevision||meeting.outcomes_review_required)return false;
  return view.items.some(i=>i.id===itemId&&i.provenance==='stated'&&!i.reviewReasons.length)&&view.notes.itemOverrides.some(o=>o.itemId===itemId&&o.decision==='confirmed');
 }
 const located=(await ctx.db.query<{call_session_id:string}>(`SELECT a.call_session_id FROM call_analyses a JOIN call_sessions s ON s.workspace_id=a.workspace_id AND s.id=a.call_session_id WHERE a.workspace_id=$1 AND a.id=$2 AND s.firm_id=$3`,[w,analysisId,meeting.firm_id])).rows[0];
 if(!located)return false;
 const analysis=await authoritativeAnalysis(ctx,located.call_session_id);if(!analysis||analysis.id!==analysisId||analysis.version!==e.sourceRevision||!analysis.proposals.some(p=>p.key===itemId))return false;
 const latest=(await ctx.db.query<{action:string;detail:{result?:string}}>(`SELECT action,detail FROM audit_events WHERE workspace_id=$1 AND subject_id=$2 AND subject_kind='call_analysis' AND action IN ('call.proposal_decided','call.proposal_corrected') AND detail->>'key'=$3 ORDER BY occurred_at DESC,id DESC LIMIT 1`,[w,analysisId,itemId])).rows[0];
 if(latest?.action!=='call.proposal_decided'||latest.detail.result!=='unchanged')return false;
 // Even a form correction after an accepted proposal makes that source require confirmation again.
 return !(await ctx.db.query(`SELECT 1 FROM call_sessions s JOIN audit_events a ON a.workspace_id=s.workspace_id AND a.subject_id=s.call_log_id::text AND a.action='call.outcome_corrected' WHERE s.workspace_id=$1 AND s.id=$2`,[w,located.call_session_id])).rows.length;
}
async function locate(ctx:RepositoryContext,id:string){return (await ctx.db.query<Meeting>('SELECT firm_id,state,attendance_source,attendance_confirmed_at,notes_revision,transcript_source_revision,outcomes_review_required FROM meetings WHERE workspace_id=$1 AND id=$2 AND firm_id IS NOT NULL',[ctx.scope.workspaceId,id])).rows[0];}
export async function readMeetingQualification(ctx:RepositoryContext,meetingId:string):Promise<MeetingQualificationView|null>{
 const meeting=await locate(ctx,meetingId);if(!meeting)return null;
 const firm=await readFirm(ctx,meeting.firm_id);if(!firm||firm.status==='merged'||decideFirmRead(ctx,firm)!=='assigned_or_admin')return null;
 const row=(await ctx.db.query<Row>('SELECT * FROM meeting_qualification_revisions WHERE workspace_id=$1 AND meeting_id=$2 ORDER BY revision DESC LIMIT 1',[ctx.scope.workspaceId,meetingId])).rows[0];
 const answers:Record<QualificationField,QualificationAnswer>={buyingParticipant:row?.buying_participant??'unknown',maintenanceNeed:row?.maintenance_need??'unknown',openToPaying:row?.open_to_paying??'unknown'};
 const staleFields:QualificationField[]=[];
 if(row)for(const field of fields){if(answers[field]==='unknown')continue;const evidence=row.evidence.find(e=>e.field===field);if(row.invalidated_at!==null||!evidence||!await evidenceCurrent(ctx,meetingId,meeting,evidence,row.command_id,row.revision)){answers[field]='unknown';staleFields.push(field);}}
 const sourceLinks:MeetingQualificationView['sourceLinks']=[];
 for(const evidence of row?.evidence??[]){
  if(evidence.sourceKind==='user_note'||evidence.sourceKind==='meeting_item')sourceLinks.push({field:evidence.field,target:'meeting_notes',id:meetingId});
  if(evidence.sourceKind==='call_item'){
   const analysisId=evidence.sourceId.split('/')[0]??'';if(!uuid.test(analysisId))continue;
   const source=(await ctx.db.query<{call_session_id:string}>(`SELECT a.call_session_id FROM call_analyses a JOIN call_sessions s ON s.workspace_id=a.workspace_id AND s.id=a.call_session_id WHERE a.workspace_id=$1 AND a.id=$2 AND s.firm_id=$3`,[ctx.scope.workspaceId,analysisId,firm.id])).rows[0];
   if(source)sourceLinks.push({field:evidence.field,target:'call',id:source.call_session_id});
  }
 }
 const final=await locate(ctx,meetingId),finalFirm=await readFirm(ctx,meeting.firm_id);
 if(!final||!finalFirm||finalFirm.status==='merged'||decideFirmRead(ctx,finalFirm)!=='assigned_or_admin'||JSON.stringify(final)!==JSON.stringify(meeting))return null;
 const currentRevision=(await ctx.db.query<{revision:number}>('SELECT revision FROM meeting_qualification_revisions WHERE workspace_id=$1 AND meeting_id=$2 ORDER BY revision DESC LIMIT 1',[ctx.scope.workspaceId,meetingId])).rows[0]?.revision??0;
 if(currentRevision!==(row?.revision??0))return null;
 const attendanceConfirmed=meeting.state==='held'&&['manual','recording'].includes(meeting.attendance_source??'')&&meeting.attendance_confirmed_at!==null;
 return {meetingId,revision:currentRevision,...answers,sourceLinks,attendanceConfirmed,qualified:attendanceConfirmed&&fields.every(f=>answers[f]==='yes'),evidence:row?.evidence??[],staleFields};
}
export async function saveMeetingQualification(ctx:RepositoryContext,input:SaveMeetingQualification):Promise<SourcingResult<{revision:number;qualified:boolean}>>{
 if(ctx.scope.actor.kind!=='user'||!saveMeetingQualificationSchema.safeParse(input).success)return {ok:false,reason:'invalid_input'};
 await lockSendGateForStopFact(ctx);
 const firmId=await lockAnalysisMeeting(ctx,input.meetingId);if(!firmId)return {ok:false,reason:'meeting_unknown'};
 const meeting=(await locate(ctx,input.meetingId))!;
 const latest=(await ctx.db.query<{revision:number}>('SELECT revision FROM meeting_qualification_revisions WHERE workspace_id=$1 AND meeting_id=$2 ORDER BY revision DESC LIMIT 1',[ctx.scope.workspaceId,input.meetingId])).rows[0]?.revision??0;
 if(latest!==input.expectedRevision)return {ok:false,reason:'qualification_changed'};
 const revision=latest+1;
 for(const field of fields){
  const e=input.evidence.find(e=>e.field===field);if(input[field]==='unknown'){if(e)return {ok:false,reason:'invalid_input'};continue;}
  if(!e)return {ok:false,reason:'evidence_required'};
  if(!await evidenceCurrent(ctx,input.meetingId,meeting,e,input.commandId,revision))return {ok:false,reason:'source_changed'};
 }
 await ctx.db.query(`INSERT INTO meeting_qualification_revisions(workspace_id,meeting_id,firm_id,revision,buying_participant,maintenance_need,open_to_paying,evidence,command_id,created_by_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`,[ctx.scope.workspaceId,input.meetingId,firmId,revision,input.buyingParticipant,input.maintenanceNeed,input.openToPaying,JSON.stringify(input.evidence),input.commandId,ctx.scope.actor.userId]);
 // This is a saved revision, not a permanent assertion that the meeting remains qualified.
 await recordFunnelFact(ctx,{kind:'meeting.qualification_saved',source:'calendar',dedupeKey:`${input.meetingId}:${revision}`,firmId,detail:{meetingId:input.meetingId,revision}});
 await recordCrmAuditEvent(ctx,{action:'meeting.qualification_saved',subjectKind:'meeting',subjectId:input.meetingId,detail:{revision,commandId:input.commandId}});
 const view=await readMeetingQualification(ctx,input.meetingId);if(!view)throw new Error('qualification_readback_missing');
 return {ok:true,value:{revision,qualified:view.qualified}};
}

/** Both firms/meetings are locked by the booking fold. Retain history; do not inherit qualification. */
export async function foldMeetingQualification(ctx:RepositoryContext,sourceId:string,targetId:string):Promise<void>{
 const w=ctx.scope.workspaceId;
 const target=(await ctx.db.query<{firm_id:string|null}>('SELECT firm_id FROM meetings WHERE workspace_id=$1 AND id=$2',[w,targetId])).rows[0];if(!target?.firm_id)return;
 const offset=(await ctx.db.query<{revision:number}>('SELECT COALESCE(max(revision),0)::int AS revision FROM meeting_qualification_revisions WHERE workspace_id=$1 AND meeting_id=$2',[w,targetId])).rows[0]!.revision;
 await ctx.db.query(`UPDATE meeting_qualification_revisions SET invalidated_at=now() WHERE workspace_id=$1 AND meeting_id=ANY($2::uuid[])`,[w,[sourceId,targetId]]);
 await ctx.db.query(`UPDATE meeting_qualification_revisions SET original_meeting_id=COALESCE(original_meeting_id,meeting_id),original_revision=COALESCE(original_revision,revision),meeting_id=$3,firm_id=$4,revision=revision+$5 WHERE workspace_id=$1 AND meeting_id=$2`,[w,sourceId,targetId,target.firm_id,offset]);
}
