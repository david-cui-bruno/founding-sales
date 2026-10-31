import {MANUAL_SOURCE_LOSS_ACTION} from './manualProspectSourceLoss.ts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {manualProspectSubjectPermitted,type ManualProspectRow,type ManualProspectSubject} from './manualProspectProjection.ts';

/** Retained inventory only. No owner/evaluation/phone or canonical keep prerequisite.
 * Known terms/source loss hides a row even if another retained observation survives.
 * No qualification horizon is invented for these raw retained records.
 */
const preparedLossSources=`prepared_lost_source_urls AS MATERIALIZED (
 SELECT DISTINCT rtrim(url,'/') AS url FROM sourcing_candidates lost
 CROSS JOIN LATERAL unnest(ARRAY[lost.payload->>'sourceUrl',lost.source_check->'lastSuccess'->>'url'] ||
 ARRAY(SELECT o.source->>'sourceUrl' FROM sourcing_candidate_discovery_origins o WHERE o.workspace_id=lost.workspace_id AND o.candidate_id=lost.id)) refs(url)
 WHERE lost.workspace_id=$1 AND lost.source_check->>'state'='unavailable'
 AND lost.source_check->>'reason' IN ('source_unavailable','source_not_permitted','no_readable_text') AND url IS NOT NULL
), `;
function permittedManualProspectsSql(exactSubject:boolean,prepared=false):string {return `WITH ${prepared?preparedLossSources:''}raw AS (
 SELECT c.id,c.workspace_id,c.payload,c.revision,c.created_at,c.status,c.source_check,
 COALESCE(s.state,'new') AS manual_state,
 CASE WHEN c.payload->>'kind'='discovery-v1' THEN c.payload->'row' ELSE c.payload END AS observed,
 (SELECT jsonb_agg(jsonb_build_object('source',o.source,'sourceMetadata',o.source_metadata,'licenses',o.licenses,'notices',o.notices) ORDER BY o.provider,o.release,o.record_id)
  FROM sourcing_candidate_discovery_origins o WHERE o.workspace_id=c.workspace_id AND o.candidate_id=c.id) AS origins
 FROM sourcing_candidates c LEFT JOIN sourcing_manual_prospect_states s ON s.workspace_id=c.workspace_id AND s.candidate_id=c.id AND s.candidate_revision=c.revision
 WHERE c.workspace_id=$1${exactSubject?' AND c.id=$2 AND c.revision=$3':''} AND c.status<>'dismissed'
 AND NOT COALESCE(c.source_check->>'state'='unavailable' AND c.source_check->>'reason' IN ('source_unavailable','source_not_permitted','no_readable_text'),false)
), referenced AS (
 SELECT raw.*,ARRAY(SELECT DISTINCT rtrim(url,'/') FROM unnest(ARRAY[payload->>'sourceUrl',source_check->'lastSuccess'->>'url'] ||
 ARRAY(SELECT o->'source'->>'sourceUrl' FROM jsonb_array_elements(COALESCE(origins,'[]')) o)) url WHERE url IS NOT NULL ORDER BY 1) AS source_urls FROM raw
), permitted AS (
 SELECT raw.* FROM referenced raw WHERE length(trim(observed->>'firmName')) BETWEEN 1 AND 300
 AND (observed->>'firmName') ~ '[[:alnum:]]'
 AND (payload->>'kind' IS DISTINCT FROM 'discovery-v1' OR (origins IS NOT NULL AND jsonb_array_length(origins)=jsonb_array_length(observed->'observations')))
 AND NOT EXISTS(SELECT 1 FROM evidence_items e WHERE e.workspace_id=raw.workspace_id
  AND rtrim(e.source_reference,'/')=ANY(raw.source_urls)
  AND (e.retention_expires_at<=clock_timestamp() OR (NOT e.terms_allow_retention AND e.retention_expires_at IS NULL)))
 AND NOT EXISTS(SELECT 1 FROM audit_events loss WHERE loss.workspace_id=raw.workspace_id
  AND loss.action='${MANUAL_SOURCE_LOSS_ACTION}' AND loss.subject_kind='sourcing_source_hash'
  AND EXISTS(SELECT 1 FROM unnest(raw.source_urls) url WHERE loss.subject_id=encode(sha256(convert_to(url,'UTF8')),'hex')))
${prepared?` AND NOT EXISTS(SELECT 1 FROM prepared_lost_source_urls lost WHERE lost.url=ANY(raw.source_urls))`:` AND NOT EXISTS(SELECT 1 FROM sourcing_candidates lost WHERE lost.workspace_id=raw.workspace_id
  AND lost.source_check->>'state'='unavailable' AND lost.source_check->>'reason' IN ('source_unavailable','source_not_permitted','no_readable_text')
  AND (rtrim(lost.payload->>'sourceUrl','/')=ANY(raw.source_urls) OR rtrim(lost.source_check->'lastSuccess'->>'url','/')=ANY(raw.source_urls)
   OR EXISTS(SELECT 1 FROM sourcing_candidate_discovery_origins o WHERE o.workspace_id=lost.workspace_id AND o.candidate_id=lost.id AND rtrim(o.source->>'sourceUrl','/')=ANY(raw.source_urls))))`}
)`;}
const rowsSql=(prepared=false)=>`${permittedManualProspectsSql(false,prepared)}, keyed AS (
 SELECT permitted.*,CASE WHEN NULLIF(trim(observed->>'website'),'') IS NULL THEN id::text
 ELSE jsonb_build_array(lower(trim(observed->>'firmName')),observed->>'website',lower(trim(observed->>'locality')),observed->>'region')::text END AS duplicate_key FROM permitted
), ranked AS (
 SELECT keyed.*,row_number() OVER(PARTITION BY duplicate_key ORDER BY created_at DESC,id DESC) AS duplicate_rank,
 (count(*) OVER(PARTITION BY duplicate_key)-1)::integer AS duplicate_count FROM keyed
) SELECT * FROM ranked WHERE duplicate_rank=1 AND ($2='all' OR manual_state=$2) ORDER BY created_at DESC,id DESC`;

export const MANUAL_PROSPECT_ROWS_SQL=rowsSql();
/** Same prepared permissions/dedup, with the workspace-wide cross-record loss set
 * materialized once per statement instead of scanning every candidate per row. */
export const PREPARED_PROSPECT_ROWS_SQL=rowsSql(true);

export async function manualProspectRows(ctx:RepositoryContext,state:string,offset:number,exact?:{candidateId:string;expectedRevision:number}):Promise<ManualProspectRow[]> {
 if(exact)return (await ctx.db.query<ManualProspectRow>(`SELECT * FROM (${MANUAL_PROSPECT_ROWS_SQL}) current_rows WHERE id=$3 AND revision=$4`,[ctx.scope.workspaceId,state,exact.candidateId,exact.expectedRevision])).rows;
 return (await ctx.db.query<ManualProspectRow>(`${MANUAL_PROSPECT_ROWS_SQL} LIMIT 51 OFFSET $3`,[ctx.scope.workspaceId,state,offset])).rows;
}

/** Exact raw subject only, never a deduplicated inventory winner. Only the outer
 * candidate is narrowed: same-workspace source-loss vetoes still see all records.
 * Caller retains the existing lifecycle locks and post-wait authority checks. */
export async function readManualProspectSubject(ctx:RepositoryContext,input:{candidateId:string;expectedRevision:number}):Promise<ManualProspectSubject|null> {
 const row=(await ctx.db.query<ManualProspectSubject>(`${permittedManualProspectsSql(true)} SELECT * FROM permitted`,[ctx.scope.workspaceId,input.candidateId,input.expectedRevision])).rows[0];
 return row&&manualProspectSubjectPermitted(row)?row:null;
}

/** Source identity keeps PostgreSQL JSONB canonical bytes and SQL NULL handling.
 * Unlike presentation authority, this also fingerprints SQL-permitted malformed
 * observations; command owners separately require a projectable subject. */
export async function readManualProspectSubjectSourceKey(ctx:RepositoryContext,input:{candidateId:string;expectedRevision:number}):Promise<string|null> {
 return (await ctx.db.query<{key:string}>(`${permittedManualProspectsSql(true)}
 SELECT encode(sha256(convert_to(p.payload::text||COALESCE(p.origins::text,'')||COALESCE(p.source_check::text,''),'UTF8')),'hex') AS key FROM permitted p`,[ctx.scope.workspaceId,input.candidateId,input.expectedRevision])).rows[0]?.key??null;
}
