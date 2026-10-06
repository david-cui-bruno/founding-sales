import type {LearningReport,LearningCohort} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {readFirmSourcing} from './attribution.ts';
import {readMeetingQualification} from '../meetings/qualification.ts';
import {providerFunding} from '../settings/funding.ts';
export function learningRatio(numerator:number,denominator:number):number|null{return denominator>0?numerator/denominator:null;}
const reachedOutcomes=new Set(['interested','referral_or_wrong_person','callback_requested','not_interested','do_not_call']);
/** Caller transaction. Counts current accepted facts whose occurrence is at/before asOf,
 * not a reconstruction of what an old UI believed. Firm locks protect assigned-user reads.
 * The first-contact interval is [from,to); repeated touches never add cohort members.
 */
export async function readSourcingLearning(ctx:RepositoryContext,input:{from:string;to:string;asOf:string}):Promise<LearningReport>{
 const {from,to,asOf}=input;
 if(![from,to,asOf].every(v=>Number.isFinite(Date.parse(v)))||Date.parse(from)>Date.parse(to))throw new Error('invalid_learning_interval');
 const w=ctx.scope.workspaceId,actor=ctx.scope.actor,assignee=actor.kind==='user'&&actor.role!=='admin'?actor.userId:null;
 const report:LearningReport={from,to,asOf,cohorts:[],maturity:['0–6 days','7–13 days','14–29 days','30+ days'].map(ageBand=>({ageBand,firms:0})),firms:[],coverage:{candidates:0,qualified:0,admitted:0,unavailable:0},search:{attempts:0,creditsReserved:0}};
 const firms=(await ctx.db.query<{id:string;name:string;occurred_at:Date}>(`SELECT f.id,f.name,t.occurred_at FROM firms f JOIN sourcing_first_touches t ON t.workspace_id=f.workspace_id AND t.firm_id=f.id WHERE f.workspace_id=$1 AND f.status<>'merged' AND ($2::uuid IS NULL OR f.assigned_user_id=$2) AND t.occurred_at>=$3 AND t.occurred_at<$4 AND t.occurred_at<=$5 ORDER BY f.id FOR SHARE OF f`,[w,assignee,from,to,asOf])).rows;
 const cohorts=new Map<string,LearningCohort>();
 for(const firm of firms){
  const source=await readFirmSourcing(ctx,firm.id);if(!source?.primary)continue;
  const primary=source.primary,key=JSON.stringify([primary.hypothesis,primary.policyVersion,primary.acquisition]);
  let c=cohorts.get(key);if(!c){c={hypothesis:primary.hypothesis,policyVersion:primary.policyVersion,acquisition:primary.acquisition,firms:0,contacted:0,reached:0,confirmedPain:0,booked:0,held:0,qualified:0,won:0,unreached:0,unknownQualification:0,interactions:{answeredCalls:0,confirmedPainCalls:0},researchGrossCents:0,researchCashCents:0};cohorts.set(key,c);}
  c.firms++;c.contacted++;
  const candidateRevision=primary.candidateId?(await ctx.db.query<{revision:number}>('SELECT revision FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2',[w,primary.candidateId])).rows[0]?.revision??null:null;
  report.firms.push({firmId:firm.id,firmName:firm.name,candidateId:primary.sourceAvailable?primary.candidateId:null,candidateRevision,hypothesis:c.hypothesis,policyVersion:c.policyVersion,acquisition:c.acquisition,firstContactedAt:firm.occurred_at.toISOString()});
  const days=(Date.parse(asOf)-firm.occurred_at.getTime())/86400000;report.maturity[days<7?0:days<14?1:days<30?2:3]!.firms++;
  // Include pre-feature logs, but sessions and their outcome logs are one call.
  const calls=(await ctx.db.query<{id:string;outcome:string|null}>(`SELECT s.id,l.outcome FROM call_sessions s LEFT JOIN call_logs l ON l.workspace_id=s.workspace_id AND l.id=s.call_log_id AND l.occurred_at<=$3 WHERE s.workspace_id=$1 AND s.firm_id=$2 AND s.consumed_at<=$3
   UNION ALL SELECT l.id,l.outcome FROM call_logs l WHERE l.workspace_id=$1 AND l.firm_id=$2 AND l.occurred_at<=$3 AND NOT EXISTS(SELECT 1 FROM call_sessions s WHERE s.workspace_id=l.workspace_id AND s.call_log_id=l.id)`,[w,firm.id,asOf])).rows;
  const answered=new Set(calls.filter(call=>reachedOutcomes.has(call.outcome??'')).map(call=>call.id));c.interactions.answeredCalls+=answered.size;if(answered.size)c.reached++;else c.unreached++;
  const feedback=(await ctx.db.query<{code:string}>(`SELECT x.code FROM sourcing_feedback x JOIN sourcing_admissions a ON a.workspace_id=x.workspace_id AND a.candidate_id=x.candidate_id WHERE x.workspace_id=$1 AND a.firm_id=$2 AND NOT a.association_review_required AND x.created_at<=$3 ORDER BY x.created_at DESC,x.id DESC LIMIT 1`,[w,firm.id,asOf])).rows[0];
  let pain=feedback?.code==='real_pain',held=false,qualified=false,unknown=false;
  const painCalls=new Set<string>();
  const meetings=(await ctx.db.query<{id:string;attendance_confirmed_at:Date|null;qualification_at:Date|null}>(`SELECT m.id,m.attendance_confirmed_at,(SELECT max(q.created_at) FROM meeting_qualification_revisions q WHERE q.workspace_id=m.workspace_id AND q.meeting_id=m.id) AS qualification_at FROM meetings m WHERE m.workspace_id=$1 AND m.firm_id=$2 AND m.created_at<=$3`,[w,firm.id,asOf])).rows;
  if(meetings.length)c.booked++;
  for(const meeting of meetings){
   const q=await readMeetingQualification(ctx,meeting.id);if(!q)continue;
   const attendanceInRange=meeting.attendance_confirmed_at!==null&&meeting.attendance_confirmed_at.getTime()<=Date.parse(asOf);
   held ||= q.attendanceConfirmed&&attendanceInRange;
   if(meeting.qualification_at===null||meeting.qualification_at.getTime()>Date.parse(asOf)){unknown=true;continue;}
   qualified ||= q.qualified&&attendanceInRange;
   unknown ||= [q.buyingParticipant,q.maintenanceNeed,q.openToPaying].includes('unknown');
   if(q.maintenanceNeed==='yes'){
    pain=true;
    for(const link of q.sourceLinks)if(link.field==='maintenanceNeed'&&link.target==='call'&&answered.has(link.id))painCalls.add(link.id);
   }
  }
  if(pain)c.confirmedPain++;if(held)c.held++;if(qualified)c.qualified++;if(unknown&&!qualified)c.unknownQualification++;c.interactions.confirmedPainCalls+=painCalls.size;
  const won=await ctx.db.query(`SELECT 1 FROM (SELECT DISTINCT ON(e.opportunity_id) e.to_stage_id,e.actor_kind FROM opportunity_stage_events e WHERE e.workspace_id=$1 AND e.firm_id=$2 AND e.occurred_at<=$3 ORDER BY e.opportunity_id,e.occurred_at DESC,e.id DESC) latest JOIN pipeline_stages s ON s.workspace_id=$1 AND s.id=latest.to_stage_id WHERE s.terminal_kind='won' AND latest.actor_kind IN ('user','admin') LIMIT 1`,[w,firm.id,asOf]);if(won.rows.length)c.won++;
  const costs=(await ctx.db.query<{provider_key:string;settled_cents:number}>(`SELECT p.provider_key,p.settled_cents FROM provider_reservations p WHERE p.workspace_id=$1 AND p.settled_at<=$3 AND p.state IN ('settled','estimated') AND (
   (p.subject_kind='research_run' AND EXISTS(SELECT 1 FROM research_runs r WHERE r.workspace_id=p.workspace_id AND r.id=p.subject_id AND r.firm_id=$2)) OR
   (p.subject_kind='sourcing_qualification' AND EXISTS(SELECT 1 FROM sourcing_qualification_runs r JOIN sourcing_admissions a ON a.workspace_id=r.workspace_id AND a.candidate_id=r.candidate_id WHERE r.workspace_id=p.workspace_id AND r.id=p.subject_id AND a.firm_id=$2)))`,[w,firm.id,asOf])).rows;
  for(const cost of costs){c.researchGrossCents+=cost.settled_cents;if(providerFunding(cost.provider_key)==='cash')c.researchCashCents+=cost.settled_cents;}
 }
 report.cohorts=[...cohorts.values()].sort((a,b)=>a.acquisition.localeCompare(b.acquisition)||a.hypothesis.localeCompare(b.hypothesis)||a.policyVersion.localeCompare(b.policyVersion));
 // Candidates have no assignee until admission. Non-admins see only admitted, assigned firms.
 const coverage=(await ctx.db.query<{status:string;state:string|null;admitted:boolean}>(`SELECT c.status,r.state,a.firm_id IS NOT NULL AS admitted FROM sourcing_candidates c LEFT JOIN LATERAL(SELECT state FROM sourcing_qualification_runs WHERE workspace_id=c.workspace_id AND candidate_id=c.id AND requested_at<=$3 ORDER BY requested_at DESC,id DESC LIMIT 1) r ON true LEFT JOIN sourcing_admissions a ON a.workspace_id=c.workspace_id AND a.candidate_id=c.id LEFT JOIN firms f ON f.workspace_id=a.workspace_id AND f.id=a.firm_id WHERE c.workspace_id=$1 AND ($2::uuid IS NULL OR f.assigned_user_id=$2) AND c.created_at<=$3`,[w,assignee,asOf])).rows;
 for(const row of coverage){report.coverage.candidates++;if(['eligible','admitted'].includes(row.state??''))report.coverage.qualified++;if(row.admitted)report.coverage.admitted++;if(row.state==='unavailable')report.coverage.unavailable++;}
 if(assignee===null){const count=(await ctx.db.query<{n:number}>('SELECT count(*)::int AS n FROM sourcing_discovery_attempts WHERE workspace_id=$1 AND created_at>=$2 AND created_at<=$3',[w,from,asOf])).rows[0]?.n??0;report.search={attempts:count,creditsReserved:count};}
 return report;
}
