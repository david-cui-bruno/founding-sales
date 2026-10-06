import {createHash} from 'node:crypto';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {loadFirmForUpdate,readFirm} from '../crm/firms.ts';
import {decideFirmMutation,decideFirmRead} from '../crm/authorization.ts';
import {recordFunnelFact} from '../funnel/facts.ts';
import type {SourcingResult} from './qualificationStore.ts';

export type Acquisition='cold_sourced'|'warm_intro'|'manual'|'unknown';
export type InteractionKind='call'|'email'|'meeting'|'deal';
interface AttributionInput {
 firmId:string;candidateId:string|null;qualificationRunId:string|null;queryId:string|null;
 hypothesis:string;policyVersion:string;acquisition:Acquisition;
}
type AttributionRow = {
 id:string;firm_id:string;candidate_id:string|null;run_id:string|null;query_id:string|null;
 hypothesis:string;policy_version:string;acquisition:Acquisition;created_at:Date;source_available:boolean;
}
type InteractionSource = {firm_id:string;subject_id:string;revision:number;occurred_at:Date;outbound:boolean}
export interface InteractionInput {attributionId:string;kind:InteractionKind;subjectId:string;sourceRevision:number}
const deny=(reason:string):SourcingResult<{id:string}>=>({ok:false,reason});

/** Caller transaction. An explicit admission is the only link from a candidate to a firm. */
export async function attachSourcingAttribution(ctx:RepositoryContext,input:AttributionInput):Promise<SourcingResult<{id:string}>> {
 const firm=await loadFirmForUpdate(ctx,input.firmId);if(!firm)return deny('not_found');
 const permit=decideFirmMutation(ctx,firm);if(!permit.permitted)return deny(permit.reason);
 if(!['cold_sourced','warm_intro','manual','unknown'].includes(input.acquisition)||!input.hypothesis.match(/^[a-z0-9_.:-]{1,80}$/u)||!input.policyVersion.match(/^[a-z0-9_.:-]{1,80}$/u)||(input.queryId!==null&&(!input.queryId.length||input.queryId.length>100)))return deny('invalid_input');
 const w=ctx.scope.workspaceId;
 if(input.candidateId!==null||input.qualificationRunId!==null){
  const linked=await ctx.db.query(`SELECT r.id FROM sourcing_qualification_runs r JOIN sourcing_admissions a
   ON a.workspace_id=r.workspace_id AND a.candidate_id=r.candidate_id
   WHERE r.workspace_id=$1 AND r.id=$2 AND r.candidate_id=$3 AND a.firm_id=$4
   AND NOT a.association_review_required AND r.reason IS NULL`,[w,input.qualificationRunId,input.candidateId,input.firmId]);
  if(!linked.rows.length)return deny('source_mismatch');
 }else if(input.acquisition==='cold_sourced')return deny('source_required');
 const key=createHash('sha256').update(JSON.stringify([input.candidateId,input.qualificationRunId,input.queryId,input.hypothesis,input.policyVersion,input.acquisition])).digest('hex');
 const row=(await ctx.db.query<{id:string}>(`INSERT INTO sourcing_attributions(workspace_id,firm_id,candidate_id,run_id,source_key,query_id,hypothesis,policy_version,acquisition)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(workspace_id,firm_id,source_key) DO UPDATE SET source_key=EXCLUDED.source_key RETURNING id`,[w,input.firmId,input.candidateId,input.qualificationRunId,key,input.queryId,input.hypothesis,input.policyVersion,input.acquisition])).rows[0]!;
 if(input.acquisition==='cold_sourced')await preserveLegacyFirstCall(ctx,input.firmId);
 return {ok:true,value:row};
}

/** The canonical call is the session when there is one, otherwise the manually logged call. */
async function interactionSource(ctx:RepositoryContext,kind:InteractionKind,id:string):Promise<InteractionSource|null>{
 const w=ctx.scope.workspaceId;
 if(kind==='call')return (await ctx.db.query<InteractionSource>(`WITH located AS (
   SELECT s.firm_id,s.id AS subject_id,s.call_log_id AS log_id,COALESCE(s.consumed_at,l.occurred_at) AS occurred_at,true AS outbound
   FROM call_sessions s LEFT JOIN call_logs l ON l.workspace_id=s.workspace_id AND l.id=s.call_log_id
   WHERE s.workspace_id=$1 AND (s.id=$2 OR s.call_log_id=$2) AND (s.consumed_at IS NOT NULL OR l.id IS NOT NULL)
   UNION ALL SELECT l.firm_id,l.id,l.id,l.occurred_at,l.direction='outbound' FROM call_logs l
   WHERE l.workspace_id=$1 AND l.id=$2 AND NOT EXISTS(SELECT 1 FROM call_sessions s WHERE s.workspace_id=l.workspace_id AND s.call_log_id=l.id)
  ) SELECT x.*,(SELECT count(*)::int FROM audit_events a WHERE a.workspace_id=$1 AND a.subject_kind='call_log' AND a.subject_id=x.log_id::text AND a.action='call.outcome_corrected') AS revision FROM located x`,[w,id])).rows[0]??null;
 if(kind==='meeting')return (await ctx.db.query<InteractionSource>(`SELECT firm_id,id AS subject_id,notes_revision AS revision,created_at AS occurred_at,false AS outbound FROM meetings WHERE workspace_id=$1 AND id=$2 AND firm_id IS NOT NULL`,[w,id])).rows[0]??null;
 if(kind==='deal')return (await ctx.db.query<InteractionSource>(`SELECT o.firm_id,o.id AS subject_id,(SELECT count(*)::int FROM opportunity_stage_events e WHERE e.workspace_id=o.workspace_id AND e.opportunity_id=o.id) AS revision,o.updated_at AS occurred_at,false AS outbound FROM opportunities o WHERE o.workspace_id=$1 AND o.id=$2`,[w,id])).rows[0]??null;
 // Email attribution is added with the outreach release; an arbitrary UUID cannot manufacture contact.
 return null;
}

export async function attributeInteraction(ctx:RepositoryContext,input:InteractionInput):Promise<SourcingResult<{id:string}>>{
 const w=ctx.scope.workspaceId;
 const source=(await ctx.db.query<{firm_id:string}>('SELECT firm_id FROM sourcing_attributions WHERE workspace_id=$1 AND id=$2',[w,input.attributionId])).rows[0];if(!source)return deny('not_found');
 const firm=await loadFirmForUpdate(ctx,source.firm_id);if(!firm)return deny('not_found');
 const permit=decideFirmMutation(ctx,firm);if(!permit.permitted)return deny(permit.reason);
 const interaction=await interactionSource(ctx,input.kind,input.subjectId);
 if(!interaction||interaction.firm_id!==firm.id)return deny('interaction_mismatch');
 if(input.sourceRevision!==interaction.revision)return deny('source_changed');
 const row=(await ctx.db.query<{id:string;attribution_id:string}>(`INSERT INTO sourcing_interactions(workspace_id,attribution_id,kind,subject_id,source_revision,occurred_at,outbound)
  VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(workspace_id,kind,subject_id,source_revision) DO UPDATE SET subject_id=EXCLUDED.subject_id RETURNING id,attribution_id`,[w,input.attributionId,input.kind,interaction.subject_id,input.sourceRevision,interaction.occurred_at,interaction.outbound])).rows[0]!;
 if(interaction.outbound)await ctx.db.query(`INSERT INTO sourcing_first_touches(workspace_id,firm_id,attribution_id,occurred_at) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[w,firm.id,row.attribution_id,interaction.occurred_at]);
 await recordFunnelFact(ctx,{kind:'sourcing.interaction_attributed',source:'sourcing',dedupeKey:row.id,firmId:firm.id,occurredAt:interaction.occurred_at.toISOString(),detail:{attributionId:row.attribution_id,kind:input.kind,subjectId:interaction.subject_id,revision:input.sourceRevision}});
 return {ok:true,value:{id:row.id}};
}

/** Used by existing accepted business transactions, without new required call paperwork. */
export async function attributeFirmInteraction(ctx:RepositoryContext,input:{firmId:string;kind:InteractionKind;subjectId:string;sourceRevision?:number}):Promise<void>{
 const firm=await loadFirmForUpdate(ctx,input.firmId);if(!firm||!decideFirmMutation(ctx,firm).permitted)return;
 const current=await interactionSource(ctx,input.kind,input.subjectId);if(!current||current.firm_id!==firm.id)return;
 await preserveLegacyFirstCall(ctx,firm.id,current.subject_id);
 let id=(await ctx.db.query<{id:string}>(`SELECT attribution_id AS id FROM sourcing_interactions WHERE workspace_id=$1 AND kind=$2 AND subject_id=$3 ORDER BY source_revision LIMIT 1`,[ctx.scope.workspaceId,input.kind,current.subject_id])).rows[0]?.id;
 if(!id)id=(await ctx.db.query<{id:string}>("SELECT id FROM sourcing_attributions WHERE workspace_id=$1 AND firm_id=$2 AND date_trunc('milliseconds',created_at)<=$3 ORDER BY created_at DESC,id DESC LIMIT 1",[ctx.scope.workspaceId,firm.id,current.occurred_at])).rows[0]?.id;
 if(!id){const made=await attachSourcingAttribution(ctx,{firmId:firm.id,candidateId:null,qualificationRunId:null,queryId:null,hypothesis:'unknown',policyVersion:'unknown',acquisition:'unknown'});if(!made.ok)throw new Error(`attribution_${made.reason}`);id=made.value.id;}
 const result=await attributeInteraction(ctx,{attributionId:id,kind:input.kind,subjectId:current.subject_id,sourceRevision:input.sourceRevision??current.revision});if(!result.ok)throw new Error(`attribution_${result.reason}`);
}

export async function readFirmSourcing(ctx:RepositoryContext,firmId:string){
 const firm=await readFirm(ctx,firmId);if(!firm||firm.status==='merged'||decideFirmRead(ctx,firm)!=='assigned_or_admin')return null;
 const w=ctx.scope.workspaceId;
 const sources=(await ctx.db.query<AttributionRow>(`SELECT a.*,CASE WHEN a.acquisition<>'cold_sourced' THEN true ELSE
   a.candidate_id IS NOT NULL AND a.run_id IS NOT NULL AND r.reason IS NULL AND NOT COALESCE(c.qualification_blocked,true) AND NOT COALESCE(d.association_review_required,true) END AS source_available
   FROM sourcing_attributions a LEFT JOIN sourcing_qualification_runs r ON r.workspace_id=a.workspace_id AND r.id=a.run_id
   LEFT JOIN sourcing_candidates c ON c.workspace_id=a.workspace_id AND c.id=a.candidate_id
   LEFT JOIN sourcing_admissions d ON d.workspace_id=a.workspace_id AND d.candidate_id=a.candidate_id AND d.firm_id=a.firm_id
   WHERE a.workspace_id=$1 AND a.firm_id=$2 ORDER BY a.created_at,a.id`,[w,firmId])).rows;
 const first=(await ctx.db.query<{attribution_id:string;occurred_at:Date}>('SELECT attribution_id,occurred_at FROM sourcing_first_touches WHERE workspace_id=$1 AND firm_id=$2',[w,firmId])).rows[0];
 const mapped=sources.map(s=>({id:s.id,candidateId:s.candidate_id,qualificationRunId:s.run_id,queryId:s.query_id,hypothesis:s.source_available?s.hypothesis:'unknown',policyVersion:s.policy_version,acquisition:s.source_available?s.acquisition:'unknown',sourceAvailable:s.source_available}));
 const interactions=(await ctx.db.query<{id:string;kind:InteractionKind;subject_id:string;source_revision:number}>(`SELECT i.id,i.kind,i.subject_id,i.source_revision FROM sourcing_interactions i JOIN sourcing_attributions a ON a.workspace_id=i.workspace_id AND a.id=i.attribution_id WHERE i.workspace_id=$1 AND a.firm_id=$2 ORDER BY i.occurred_at,i.id`,[w,firmId])).rows;
 const finalFirm=await readFirm(ctx,firmId);if(!finalFirm||finalFirm.status==='merged'||decideFirmRead(ctx,finalFirm)!=='assigned_or_admin')return null;
 return {primary:mapped.find(s=>s.id===first?.attribution_id)??null,firstContactedAt:first?.occurred_at.toISOString()??null,sources:mapped,interactions};
}

/** Called after both firms are locked. Earliest frozen first touch wins after a merge. */
export async function mergeSourcingAttribution(ctx:RepositoryContext,sourceId:string,targetId:string):Promise<void>{
 const w=ctx.scope.workspaceId;
 await ctx.db.query(`INSERT INTO sourcing_first_touches(workspace_id,firm_id,attribution_id,occurred_at)
 SELECT workspace_id,$3,attribution_id,occurred_at FROM sourcing_first_touches WHERE workspace_id=$1 AND firm_id=$2
 ON CONFLICT(workspace_id,firm_id) DO UPDATE SET attribution_id=EXCLUDED.attribution_id,occurred_at=EXCLUDED.occurred_at WHERE EXCLUDED.occurred_at<sourcing_first_touches.occurred_at`,[w,sourceId,targetId]);
 await ctx.db.query('DELETE FROM sourcing_first_touches WHERE workspace_id=$1 AND firm_id=$2',[w,sourceId]);
 // Preserve distinct historical sources even when both records were labelled manual/unknown.
 await ctx.db.query("UPDATE sourcing_attributions SET firm_id=$3,source_key=id::text WHERE workspace_id=$1 AND firm_id=$2",[w,sourceId,targetId]);
}

/** Research attached later cannot turn an already-contacted firm into a newly sourced lead. */
async function preserveLegacyFirstCall(ctx:RepositoryContext,firmId:string,currentSubjectId?:string):Promise<void>{
 const w=ctx.scope.workspaceId;
 if((await ctx.db.query('SELECT 1 FROM sourcing_first_touches WHERE workspace_id=$1 AND firm_id=$2',[w,firmId])).rows.length)return;
 const old=(await ctx.db.query<{id:string}>(`SELECT id FROM (
  SELECT id,consumed_at AS at FROM call_sessions WHERE workspace_id=$1 AND firm_id=$2 AND consumed_at IS NOT NULL
  UNION ALL SELECT l.id,l.occurred_at FROM call_logs l WHERE l.workspace_id=$1 AND l.firm_id=$2 AND l.direction='outbound'
   AND NOT EXISTS(SELECT 1 FROM call_sessions s WHERE s.workspace_id=l.workspace_id AND s.call_log_id=l.id)
 ) x ORDER BY at,id LIMIT 1`,[w,firmId])).rows[0];
 if(old&&old.id!==currentSubjectId)await attributeFirmInteraction(ctx,{firmId,kind:'call',subjectId:old.id});
}
