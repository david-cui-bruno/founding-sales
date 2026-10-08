import type {CandidateInput,AutomaticEmailLearning} from '@fss/contracts';
import {readMeetingQualification} from '../meetings/qualification.ts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {qualifyEmailCandidate} from '../outreach/selection.ts';
import {candidateIdentity} from './qualificationDecision.ts';
import {QUALIFICATION_PROMPT_VERSION,QUALIFICATION_POLICY_VERSION} from './qualificationStore.ts';
import type {QualificationRunRow} from './qualificationStore.ts';
type Decision=AutomaticEmailLearning['decisions'][number];
/** Caller transaction. Read-only projection; historic bindings come from the
 * committed decision, never today's configuration. Missing evidence stays null. */
export async function readAutomaticEmailLearning(ctx:RepositoryContext,input:{from:string;to:string;asOf:string}):Promise<AutomaticEmailLearning>{
 const w=ctx.scope.workspaceId,actor=ctx.scope.actor,assignee=actor.kind==='user'&&actor.role!=='admin'?actor.userId:null;
 // Lock admitted firms before collecting assigned-user evidence and outcomes.
 // Reassignment/merge cannot cross the authorization check during this read.
 await ctx.db.query(`SELECT f.id FROM firms f WHERE f.workspace_id=$1 AND f.status<>'merged' AND ($2::uuid IS NULL OR f.assigned_user_id=$2) AND EXISTS(SELECT 1 FROM outreach_plans p JOIN audit_events a ON a.workspace_id=p.workspace_id AND a.subject_id=p.id::text AND a.action='outreach.email_automatically_enrolled' WHERE p.workspace_id=f.workspace_id AND p.firm_id=f.id AND a.occurred_at<=$3) ORDER BY f.id FOR SHARE OF f`,[w,assignee,input.asOf]);
 const rows=(await ctx.db.query<{occurred_at:Date;detail:Record<string,unknown>;run:QualificationRunRow;firm_id:string|null;firm_name:string;plan_id:string|null;contact_id:string|null;route_id:string|null;enrollment_id:string|null;rank:string|null}>(`SELECT DISTINCT ON(r.id) a.occurred_at,a.detail,row_to_json(r) AS run,f.id AS firm_id,c.payload->>'firmName' AS firm_name,p.id AS plan_id,e.contact_id,e.route_id,n.id AS enrollment_id,s.hypothesis AS rank
 FROM audit_events a JOIN sourcing_qualification_runs r ON r.workspace_id=a.workspace_id AND r.id::text=a.detail->>'runId'
 JOIN sourcing_candidates c ON c.workspace_id=r.workspace_id AND c.id=r.candidate_id
 LEFT JOIN outreach_email_sources e ON e.workspace_id=r.workspace_id AND e.candidate_id=r.candidate_id AND e.run_id=r.id
 LEFT JOIN outreach_plans p ON p.workspace_id=r.workspace_id AND p.candidate_id=r.candidate_id AND p.qualification_run_id=r.id
 LEFT JOIN sequence_enrollments n ON n.workspace_id=p.workspace_id AND n.outreach_plan_id=p.id
 LEFT JOIN firms f ON f.workspace_id=e.workspace_id AND f.id=e.firm_id
 LEFT JOIN sourcing_attributions s ON s.workspace_id=r.workspace_id AND s.run_id=r.id AND s.firm_id=f.id
 WHERE a.workspace_id=$1 AND a.action IN ('outreach.email_automatically_enrolled','outreach.email_admission_decided','outreach.email_automatic_refused')
 AND a.occurred_at>=$3 AND a.occurred_at<$4 AND a.occurred_at<=$5
 AND ($2::uuid IS NULL OR f.assigned_user_id=$2) AND (f.id IS NULL OR f.status<>'merged')
 ORDER BY r.id,(a.action='outreach.email_automatically_enrolled' OR a.detail->>'reason'='enrolled') DESC,a.occurred_at DESC,(a.action='outreach.email_admission_decided') DESC,a.id DESC`,[w,assignee,input.from,input.to,input.asOf])).rows;
 const decisions:Decision[]=rows.map(row=>{
  const d=row.detail,str=(key:string)=>typeof d[key]==='string'?d[key] as string:null;
  const enrolled=row.enrollment_id!==null&&(d['enrollmentId']===row.enrollment_id||d['reason']==='enrolled');
  const reason=enrolled?'enrolled':str('reason')??'unavailable';
  return {candidateId:row.run.candidate_id,runId:row.run.id,candidateRevision:row.run.candidate_revision,firmName:row.firm_name,reason,status:enrolled?'enrolled':d['status']==='held'?'held':d['status']==='exhausted'?'exhausted':'deferred',checks:typeof d['checks']==='number'?d['checks']:1,retryAt:str('retryAt'),decidedAt:row.occurred_at.toISOString(),
   firmId:enrolled?row.firm_id:null,contactId:enrolled?row.contact_id:null,routeId:enrolled?row.route_id:null,planId:enrolled?row.plan_id:null,enrollmentId:enrolled?row.enrollment_id:null,
   ownerUserId:str('ownerUserId'),mailboxId:str('mailboxId'),sequenceVersionId:str('sequenceVersionId'),controlRevision:typeof d['controlRevision']==='number'?d['controlRevision']:0,
   rank:str('rank')??(enrolled?row.rank:null),policyVersion:str('policyVersion'),promptVersion:str('promptVersion'),evaluationSha256:str('evaluationSha256'),implementationCommit:str('implementationCommit'),configurationSha256:str('configurationSha256'),
   evidence:row.run.observations.map(o=>({observationId:o.id,url:o.url,blockIds:row.run.facts.filter(f=>f.observationId===o.id).map(f=>f.blockId),retrievedAt:o.retrievedAt,contentHash:o.contentHash}))};
 });
 const ids=[...new Set(decisions.flatMap(d=>d.enrollmentId?[d.enrollmentId]:[]))];
 const messages=(await ctx.db.query<{attempts:number;sent:number;unsettled:number}>(`SELECT count(*) FILTER(WHERE attempt_token IS NOT NULL AND dispatch_started_at<=$3)::int AS attempts,count(*) FILTER(WHERE state='sent' AND sent_at<=$3)::int AS sent,count(*) FILTER(WHERE state IN ('dispatching','reconciling','unknown_terminal') AND dispatch_started_at<=$3)::int AS unsettled FROM outbound_messages WHERE workspace_id=$1 AND enrollment_id=ANY($2::uuid[])`,[w,ids,input.asOf])).rows[0]!;
 const discovery=await readDiscovery(ctx,input,assignee);
 const outcomes={admissions:ids.length,attempts:messages.attempts,sent:messages.sent,unsettled:messages.unsettled,replies:0,deliveryFailures:0,optOuts:0,booked:0,heldQualified:0,unknownQualification:0};
 const attention:AutomaticEmailLearning['attention']=[];
 for(const firmId of new Set(decisions.flatMap(d=>d.firmId?[d.firmId]:[]))){
  const mail=(await ctx.db.query<{replies:number;failures:number;opt_outs:number;needs_reply:number}>(`SELECT
   count(DISTINCT m.id) FILTER(WHERE c.class='human' OR q.disposition IN ('interested','not_interested','follow_up_later'))::int AS replies,
   count(DISTINCT m.id) FILTER(WHERE c.class='bounce')::int AS failures,
   count(DISTINCT m.id) FILTER(WHERE c.class='opt_out' OR q.disposition='opt_out')::int AS opt_outs,
   count(DISTINCT m.id) FILTER(WHERE c.class='human' AND q.id IS NULL)::int AS needs_reply
   FROM mail_messages m JOIN mail_message_matches x ON x.workspace_id=m.workspace_id AND x.mail_message_id=m.id
   LEFT JOIN mail_message_classifications c ON c.workspace_id=m.workspace_id AND c.mail_message_id=m.id AND c.layer='deterministic'
   LEFT JOIN mail_reply_confirmations q ON q.workspace_id=m.workspace_id AND q.mail_message_id=m.id AND q.firm_id=x.firm_id AND q.created_at<=$3
   WHERE m.workspace_id=$1 AND x.firm_id=$2 AND m.direction='incoming' AND NOT x.ambiguous AND m.internal_date<=$3
   AND (SELECT count(DISTINCT y.firm_id) FROM mail_message_matches y WHERE y.workspace_id=m.workspace_id AND y.mail_message_id=m.id)=1`,[w,firmId,input.asOf])).rows[0]!;
  outcomes.replies+=mail.replies;outcomes.deliveryFailures+=mail.failures;outcomes.optOuts+=mail.opt_outs;
  const meetings=(await ctx.db.query<{id:string;attendance_confirmed_at:Date|null;qualification_at:Date|null}>(`SELECT m.id,m.attendance_confirmed_at,(SELECT max(q.created_at) FROM meeting_qualification_revisions q WHERE q.workspace_id=m.workspace_id AND q.meeting_id=m.id) AS qualification_at FROM meetings m WHERE m.workspace_id=$1 AND m.firm_id=$2 AND m.created_at<=$3`,[w,firmId,input.asOf])).rows;
  let heldQualified=0;
  for(const m of meetings){const q=await readMeetingQualification(ctx,m.id);if(!q||!m.qualification_at||m.qualification_at.getTime()>Date.parse(input.asOf)||[q.buyingParticipant,q.maintenanceNeed,q.openToPaying].includes('unknown'))outcomes.unknownQualification++;if(q?.qualified&&m.attendance_confirmed_at&&m.attendance_confirmed_at.getTime()<=Date.parse(input.asOf)&&m.qualification_at&&m.qualification_at.getTime()<=Date.parse(input.asOf))heldQualified++;}
  outcomes.booked+=meetings.length;outcomes.heldQualified+=heldQualified;
  if(mail.needs_reply||meetings.length)attention.push({firmId,firmName:decisions.find(d=>d.firmId===firmId)!.firmName,needsReply:mail.needs_reply,bookings:meetings.length,heldQualified});
 }
 const setting=(await ctx.db.query<{enabled:boolean;revision:number}>(`SELECT enabled,revision FROM outreach_email_admission_settings WHERE workspace_id=$1 AND ($2::uuid IS NULL OR owner_user_id=$2)`,[w,assignee])).rows[0];
 const batch=assignee===null||setting?(await ctx.db.query<{occurred_at:Date;detail:{reason:string|null;controlRevision:number}}>(`SELECT occurred_at,detail FROM audit_events WHERE workspace_id=$1 AND action='outreach.email_admission_batch' AND occurred_at<=$2 ORDER BY occurred_at DESC,id DESC LIMIT 1`,[w,input.asOf])).rows[0]:null;
 const control=assignee===null||setting?{enabled:setting?.enabled??false,revision:setting?.revision??0,lastBatchAt:batch?.occurred_at.toISOString()??null,lastBatchReason:batch?.detail.reason??null,lastBatchControlRevision:batch?.detail.controlRevision??null}:null;
 return {control,discovery,outcomes,attention,decisions};
}

async function readDiscovery(ctx:RepositoryContext,input:{from:string;to:string;asOf:string},assignee:string|null):Promise<AutomaticEmailLearning['discovery']>{
 const w=ctx.scope.workspaceId,values=[w,assignee,input.from,input.to,input.asOf];
 const visible=`($2::uuid IS NULL OR EXISTS(SELECT 1 FROM firms f WHERE f.workspace_id=c.workspace_id AND f.status<>'merged' AND f.assigned_user_id=$2 AND (EXISTS(SELECT 1 FROM outreach_email_sources e WHERE e.workspace_id=c.workspace_id AND e.candidate_id=c.id AND e.firm_id=f.id) OR EXISTS(SELECT 1 FROM sourcing_admissions a WHERE a.workspace_id=c.workspace_id AND a.candidate_id=c.id AND a.firm_id=f.id))))`;
 const hits=(await ctx.db.query<{n:number}>(`SELECT count(*)::int AS n FROM sourcing_discovery_hits h LEFT JOIN sourcing_candidates c ON c.workspace_id=h.workspace_id AND c.id=h.candidate_id WHERE h.workspace_id=$1 AND h.retrieved_at>=$3 AND h.retrieved_at<$4 AND h.retrieved_at<=$5 AND ${visible}`,values)).rows[0]!.n;
 const candidates=(await ctx.db.query<{payload:CandidateInput;revision:number;status:string;qualification_blocked:boolean;run:QualificationRunRow|null;discovered:boolean;in_interval:boolean;admitted:boolean}>(`SELECT c.payload,c.revision,c.status,c.qualification_blocked,row_to_json(r) AS run,
 EXISTS(SELECT 1 FROM sourcing_discovery_hits h WHERE h.workspace_id=c.workspace_id AND h.candidate_id=c.id AND h.retrieved_at<=$5) AS discovered,
 EXISTS(SELECT 1 FROM sourcing_discovery_hits h WHERE h.workspace_id=c.workspace_id AND h.candidate_id=c.id AND h.retrieved_at>=$3 AND h.retrieved_at<$4 AND h.retrieved_at<=$5) AS in_interval,
 (EXISTS(SELECT 1 FROM outreach_email_sources e WHERE e.workspace_id=c.workspace_id AND e.candidate_id=c.id AND NOT e.association_review_required AND e.created_at<=$5) OR EXISTS(SELECT 1 FROM sourcing_admissions a WHERE a.workspace_id=c.workspace_id AND a.candidate_id=c.id AND NOT a.association_review_required AND a.admitted_at<=$5)) AS admitted
 FROM sourcing_candidates c LEFT JOIN LATERAL(SELECT * FROM sourcing_qualification_runs r WHERE r.workspace_id=c.workspace_id AND r.candidate_id=c.id AND r.requested_at<=$5 ORDER BY r.requested_at DESC,r.id DESC LIMIT 1) r ON true
 WHERE c.workspace_id=$1 AND c.created_at<=$5 AND (c.created_at>=$3 AND c.created_at<$4 OR EXISTS(SELECT 1 FROM sourcing_discovery_hits h WHERE h.workspace_id=c.workspace_id AND h.candidate_id=c.id AND h.retrieved_at>=$3 AND h.retrieved_at<$4 AND h.retrieved_at<=$5)) AND ${visible}`,values)).rows;
 const result={retainedHits:hits,supportedProspects:0,admissions:0,manualStaged:0,unavailable:0};
 for(const c of candidates){
  if(!c.discovered){result.manualStaged++;continue;}if(!c.in_interval)continue;
  if(c.admitted)result.admissions++;
  const r=c.run;if(!r||r.state==='unavailable'){result.unavailable++;continue;}
  if(c.qualification_blocked||c.status==='dismissed'||r.candidate_revision!==c.revision||r.reason!==null||!['eligible','review','admitted'].includes(r.state)||r.prompt_version!==QUALIFICATION_PROMPT_VERSION||r.policy_version!==QUALIFICATION_POLICY_VERSION)continue;
  if(qualifyEmailCandidate({identity:candidateIdentity(c.payload,r.facts,r.observations),facts:r.facts,observations:r.observations,now:input.asOf}).decision==='eligible')result.supportedProspects++;
 }
 return result;
}
