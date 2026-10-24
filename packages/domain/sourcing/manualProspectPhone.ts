import {qualificationEvidenceSchema,type ManualProspect} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {canonicalizePhone} from '../src/rules/suppressionCanonicalization.ts';
import {MANUAL_SOURCE_LOSS_ACTION} from './manualProspectSourceLoss.ts';
import {safeManualReference,type ManualProspectRow} from './manualProspectProjection.ts';

type PhoneEvidence=NonNullable<ManualProspect['phoneEvidence']>;
export interface ManualPhoneSnapshot extends Record<string,unknown>{
 candidate_id:string;candidate_revision:number;id:string;observations:unknown;facts:unknown;permitted_urls:string[];
}
/** Each observation has its OWN retention/source-loss fence. A qualification read
 * alone is not permission. A source is retained either by the raw candidate's
 * exact source association or matching retained evidence (URL, hash and time).
 * No website-host inference, new acquisition, qualification or eligibility gate.
 */
export async function manualPhoneSnapshots(ctx:RepositoryContext,rows:readonly ManualProspectRow[]):Promise<ManualPhoneSnapshot[]>{
 if(rows.length===0)return [];
 const initial=await readPhoneSnapshots(ctx,rows,null);
 // The run lock is not retention authority. CRM deletion independently deletes
 // evidence_items, so lock exact supporting rows in global ID order and retain
 // only those IDs as authority. Re-read AFTER waits: a deletion/update that won
 // first must not leave its old permission snapshot usable. A later insertion
 // cannot silently become an unlocked source of authority in this read.
 const observations=initial.flatMap(snapshot=>Array.isArray(snapshot.observations)?snapshot.observations:[]);
 const locked=await ctx.db.query<{id:string}>(`SELECT e.id FROM evidence_items e WHERE e.workspace_id=$1
  AND EXISTS(SELECT 1 FROM jsonb_array_elements($2::jsonb) page
   WHERE e.source_reference=page->>'url' AND e.content_hash=page->>'contentHash'
   AND to_char(e.retrieved_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')=page->>'retrievedAt')
  AND (e.terms_allow_retention OR e.retention_expires_at>clock_timestamp())
  ORDER BY e.id FOR SHARE OF e`,[ctx.scope.workspaceId,JSON.stringify(observations)]);
 return readPhoneSnapshots(ctx,rows,locked.rows.map(row=>row.id));
}
async function readPhoneSnapshots(ctx:RepositoryContext,rows:readonly ManualProspectRow[],evidenceIds:readonly string[]|null):Promise<ManualPhoneSnapshot[]>{
 return (await ctx.db.query<ManualPhoneSnapshot>(`SELECT r.id,r.candidate_id,r.candidate_revision,r.observations,r.facts,
 ARRAY(SELECT DISTINCT page->>'url' FROM jsonb_array_elements(r.observations) page WHERE
  (EXISTS(SELECT 1 FROM sourcing_candidates retained WHERE retained.workspace_id=r.workspace_id AND retained.id=r.candidate_id
    AND rtrim(retained.payload->>'sourceUrl','/')=rtrim(page->>'url','/'))
   OR EXISTS(SELECT 1 FROM sourcing_candidate_discovery_origins o WHERE o.workspace_id=r.workspace_id AND o.candidate_id=r.candidate_id
    AND rtrim(o.source->>'sourceUrl','/')=rtrim(page->>'url','/'))
   OR EXISTS(SELECT 1 FROM evidence_items e WHERE e.workspace_id=r.workspace_id AND ($3::uuid[] IS NULL OR e.id=ANY($3::uuid[])) AND e.source_reference=page->>'url'
    AND e.content_hash=page->>'contentHash'
    AND to_char(e.retrieved_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')=page->>'retrievedAt'
    AND (e.terms_allow_retention OR e.retention_expires_at>clock_timestamp())))
  AND NOT EXISTS(SELECT 1 FROM evidence_items e WHERE e.workspace_id=r.workspace_id AND rtrim(e.source_reference,'/')=rtrim(page->>'url','/')
    AND (e.retention_expires_at<=clock_timestamp() OR (NOT e.terms_allow_retention AND e.retention_expires_at IS NULL)))
  AND NOT EXISTS(SELECT 1 FROM audit_events loss WHERE loss.workspace_id=r.workspace_id AND loss.action='${MANUAL_SOURCE_LOSS_ACTION}'
    AND loss.subject_kind='sourcing_source_hash' AND loss.subject_id=encode(sha256(convert_to(rtrim(page->>'url','/'),'UTF8')),'hex'))
  AND NOT EXISTS(SELECT 1 FROM sourcing_candidates lost WHERE lost.workspace_id=r.workspace_id
    AND lost.source_check->>'state'='unavailable' AND lost.source_check->>'reason' IN ('source_unavailable','source_not_permitted','no_readable_text')
    AND (rtrim(lost.payload->>'sourceUrl','/')=rtrim(page->>'url','/') OR rtrim(lost.source_check->'lastSuccess'->>'url','/')=rtrim(page->>'url','/')
      OR EXISTS(SELECT 1 FROM sourcing_candidate_discovery_origins o WHERE o.workspace_id=lost.workspace_id AND o.candidate_id=lost.id AND rtrim(o.source->>'sourceUrl','/')=rtrim(page->>'url','/'))))
 ORDER BY 1) AS permitted_urls
 FROM sourcing_candidates c JOIN LATERAL(SELECT * FROM sourcing_qualification_runs q WHERE q.workspace_id=c.workspace_id AND q.candidate_id=c.id ORDER BY q.requested_at DESC,q.id DESC LIMIT 1 FOR SHARE) r ON r.candidate_revision=c.revision
 WHERE c.workspace_id=$1 AND c.id=ANY($2::uuid[]) AND c.status<>'dismissed'
 AND COALESCE(r.reason,'') NOT IN ('source_unavailable','source_not_permitted','no_readable_text') ORDER BY c.id`,[ctx.scope.workspaceId,rows.map(row=>row.id),evidenceIds])).rows;
}

/** Only whole structured business_phone fact values are normalized. No mining
 * notices, URLs, text blocks or prose, and no bare assertion without a citation. */
export function projectManualPhone(snapshot:ManualPhoneSnapshot|undefined,now=Date.now()):PhoneEvidence{
 const missing:PhoneEvidence={state:'not_extracted',reason:'no_current_permitted_phone_evidence'};
 if(!snapshot)return missing;
 const parsed=qualificationEvidenceSchema.safeParse({observations:snapshot.observations,facts:snapshot.facts});
 if(!parsed.success)return missing;
 const observations=parsed.data.observations.filter(source=>safeManualReference(source.url)!==null&&snapshot.permitted_urls.includes(source.url)&&Date.parse(source.retrievedAt)<=now);
 const sources:Extract<PhoneEvidence,{state:'observed'}>['sources']=[],numbers=new Set<string>();
 for(const fact of parsed.data.facts){
  if(fact.kind!=='business_phone')continue;
  const source=observations.find(item=>item.id===fact.observationId);
  if(!source)continue;
  const number=canonicalizePhone(fact.value);if(!number.ok)continue;
  numbers.add(number.handle.value);sources.push({runId:snapshot.id,observationId:source.id,blockId:fact.blockId,url:source.url,retrievedAt:source.retrievedAt});
 }
 const unique=[...new Map(sources.map(source=>[JSON.stringify(source),source])).values()].slice(0,16);
 if(numbers.size>1)return {state:'conflicting',reason:'multiple_retained_numbers',sources:unique};
 if(numbers.size===1)return {state:'observed',value:[...numbers][0]!,sources:unique};
 return observations.length?{state:'not_extracted',reason:'retained_text_not_extracted'}:missing;
}
