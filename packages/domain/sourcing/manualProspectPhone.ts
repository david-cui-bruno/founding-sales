import {qualificationEvidenceSchema,type ManualProspect} from '@fss/contracts';
import {isDeepStrictEqual} from 'node:util';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {canonicalizePhone} from '../src/rules/suppressionCanonicalization.ts';
import {MANUAL_SOURCE_LOSS_ACTION} from './manualProspectSourceLoss.ts';
import {safeManualReference,type ManualProspectRow} from './manualProspectProjection.ts';
import {scanManualLiteralPhones} from './manualProspectLiteralPhone.ts';
import {originalAuthorities,originalLineage,type ManualOriginalSnapshot} from './manualProspectOriginalAuthority.ts';

type PhoneEvidence=NonNullable<ManualProspect['phoneEvidence']>;
export interface ManualPhoneSnapshot extends Record<string,unknown>,ManualOriginalSnapshot{
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
 const runIds=initial.flatMap(snapshot=>[snapshot.id,...(snapshot.original_run_id?[snapshot.original_run_id]:[])]);
 if(runIds.length)await ctx.db.query('SELECT id FROM sourcing_qualification_runs WHERE workspace_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE',[ctx.scope.workspaceId,runIds]);
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
 const current=await readPhoneSnapshots(ctx,rows,locked.rows.map(row=>row.id));
 return current.map(snapshot=>({...snapshot,...(!isDeepStrictEqual(initial.find(before=>before.id===snapshot.id),snapshot)?{dependency_changed:true}:{})}));
}
/** Final reread cannot acquire new authority or wait on newly inserted evidence. */
export async function recheckManualPhoneSnapshots(ctx:RepositoryContext,rows:readonly ManualProspectRow[],locked:readonly ManualPhoneSnapshot[]):Promise<ManualPhoneSnapshot[]>{
 return readPhoneSnapshots(ctx,rows,locked.flatMap(snapshot=>snapshot.evidence_authorities?.map(item=>item.id)??[]));
}
async function readPhoneSnapshots(ctx:RepositoryContext,rows:readonly ManualProspectRow[],evidenceIds:readonly string[]|null):Promise<ManualPhoneSnapshot[]>{
 return (await ctx.db.query<ManualPhoneSnapshot>(`SELECT r.id,r.candidate_id,r.candidate_revision,r.observations,r.facts,c.payload,
 r.retained_identity_decision_id,d.original_run_id,d.original_revision,d.result_revision,d.candidate_id AS decision_candidate_id,
 original.candidate_id AS original_candidate_id,original.candidate_revision AS ancestor_revision,original.observations AS original_observations,
 original.reason AS original_reason,d.observation_id AS decision_observation_id,d.block_id AS decision_block_id,d.content_hash AS decision_content_hash,d.relevant_text_hash AS decision_text_hash,
 (SELECT jsonb_agg(jsonb_build_object('source',o.source,'sourceMetadata',o.source_metadata,'licenses',o.licenses,'notices',o.notices) ORDER BY o.provider,o.release,o.record_id)
  FROM sourcing_candidate_discovery_origins o WHERE o.workspace_id=c.workspace_id AND o.candidate_id=c.id) AS origins,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('id',e.id,'url',e.source_reference,'contentHash',e.content_hash,
  'retrievedAt',to_char(e.retrieved_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ORDER BY e.id)
  FROM evidence_items e WHERE e.workspace_id=c.workspace_id AND ($3::uuid[] IS NULL OR e.id=ANY($3::uuid[]))
  AND (e.terms_allow_retention OR e.retention_expires_at>clock_timestamp())
  AND EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.observations)='array' THEN r.observations ELSE '[]'::jsonb END) page WHERE e.source_reference=page->>'url' AND e.content_hash=page->>'contentHash'
   AND to_char(e.retrieved_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')=page->>'retrievedAt')),'[]') AS evidence_authorities,
 ARRAY(SELECT DISTINCT page->>'url' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.observations)='array' THEN r.observations ELSE '[]'::jsonb END) page WHERE
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
 FROM sourcing_candidates c JOIN LATERAL(SELECT * FROM sourcing_qualification_runs q WHERE q.workspace_id=c.workspace_id AND q.candidate_id=c.id ORDER BY q.requested_at DESC,q.id DESC LIMIT 1) r ON r.candidate_revision=c.revision
 LEFT JOIN sourcing_retained_identity_decisions d ON d.workspace_id=r.workspace_id AND d.candidate_id=r.candidate_id AND d.id=r.retained_identity_decision_id
 LEFT JOIN sourcing_qualification_runs original ON original.workspace_id=d.workspace_id AND original.candidate_id=d.candidate_id AND original.id=d.original_run_id
 WHERE c.workspace_id=$1 AND c.id=ANY($2::uuid[]) AND c.status<>'dismissed'
 AND COALESCE(r.reason,'') NOT IN ('source_unavailable','source_not_permitted','no_readable_text') ORDER BY c.id`,[ctx.scope.workspaceId,rows.map(row=>row.id),evidenceIds])).rows;
}

/** Only whole structured business_phone fact values are normalized. No mining
 * notices, URLs, text blocks or prose, and no bare assertion without a citation. */
export function projectManualPhone(snapshot:ManualPhoneSnapshot|undefined,now=Date.now()):PhoneEvidence{
 const missing:PhoneEvidence={state:'not_extracted',reason:'no_current_permitted_phone_evidence'};
 if(!snapshot)return missing;
 if(snapshot.dependency_changed)return changedManualPhone();
 const lineage=originalLineage(snapshot);
 if(!lineage)return {state:'not_extracted',reason:'retained_ancestry_unavailable',coverage:{parser:'manual-literal-phone-v1',state:'unavailable',observations:0,blocks:0}};
 const factEvidence=projectFactPhone(snapshot,now);
 // Untagged legacy fact provenance remains compatible. First-party originals,
 // however, are parsed independently even when model facts were malformed.
 const hasOriginal=Array.isArray(snapshot.observations)&&snapshot.observations.some(value=>value&&typeof value==='object'&&'firstParty' in value&&value.firstParty===true);
 if(!hasOriginal)return factEvidence;
 const scan=scanManualLiteralPhones({runId:snapshot.id,observations:snapshot.observations,...originalAuthorities(snapshot),lineage,now});
 if(scan.reason)return {state:'not_extracted',reason:scan.reason,coverage:scan.coverage};
 const factSources=factEvidence.state==='observed'||factEvidence.state==='conflicting'?factEvidence.sources:[];
 const sources=[...factSources,...scan.sources];
 if(sources.length>16)return {state:'not_extracted',reason:'bounded_scan_incomplete',coverage:{...scan.coverage,state:'bounded'}};
 const values=new Set(scan.sources.flatMap(source=>source.normalizedValue?[source.normalizedValue]:[]));
 if(factEvidence.state==='observed')values.add(factEvidence.value);
 if(factEvidence.state==='conflicting'||values.size>1)return {state:'conflicting',reason:'multiple_retained_numbers',sources,coverage:scan.coverage};
 if(scan.unresolved)return {state:'conflicting',reason:'unresolved_retained_literal',sources,coverage:scan.coverage};
 if(values.size===1)return {state:'observed',value:[...values][0]!,sources,coverage:scan.coverage};
 return {state:'not_extracted',reason:'retained_text_not_extracted',coverage:scan.coverage};
}
export function changedManualPhone():PhoneEvidence{return {state:'not_extracted',reason:'optional_source_changed',coverage:{parser:'manual-literal-phone-v1',state:'changed',observations:0,blocks:0}};}
/** Preserve existing whole-fact behavior, never promote narrative model text to a literal. */
function projectFactPhone(snapshot:ManualPhoneSnapshot,now:number):PhoneEvidence{
 const missing:PhoneEvidence={state:'not_extracted',reason:'no_current_permitted_phone_evidence'};
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
