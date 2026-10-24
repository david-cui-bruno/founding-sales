import type {RepositoryContext} from '../db/workspaceScope.ts';
import type {ManualProspectRow} from './manualProspectProjection.ts';

/** Retained inventory only. No owner/evaluation/phone or canonical keep prerequisite.
 * Known terms/source loss hides a row even if another retained observation survives.
 * No qualification horizon is invented for these raw retained records.
 */
export const MANUAL_PROSPECT_ROWS_SQL=`WITH raw AS (
 SELECT c.id,c.workspace_id,c.payload,c.revision,c.created_at,c.status,
 COALESCE(s.state,'new') AS manual_state,
 CASE WHEN c.payload->>'kind'='discovery-v1' THEN c.payload->'row' ELSE c.payload END AS observed,
 (SELECT jsonb_agg(jsonb_build_object('source',o.source,'sourceMetadata',o.source_metadata,'licenses',o.licenses,'notices',o.notices) ORDER BY o.provider,o.release,o.record_id)
  FROM sourcing_candidate_discovery_origins o WHERE o.workspace_id=c.workspace_id AND o.candidate_id=c.id) AS origins
 FROM sourcing_candidates c LEFT JOIN sourcing_manual_prospect_states s ON s.workspace_id=c.workspace_id AND s.candidate_id=c.id AND s.candidate_revision=c.revision
 WHERE c.workspace_id=$1 AND c.status<>'dismissed'
 AND NOT COALESCE(c.source_check->>'state'='unavailable' AND c.source_check->>'reason' IN ('source_unavailable','source_not_permitted','no_readable_text'),false)
), permitted AS (
 SELECT raw.* FROM raw WHERE length(trim(observed->>'firmName')) BETWEEN 1 AND 300
 AND (observed->>'firmName') ~ '[[:alnum:]]'
 AND (payload->>'kind' IS DISTINCT FROM 'discovery-v1' OR (origins IS NOT NULL AND jsonb_array_length(origins)=jsonb_array_length(observed->'observations')))
 AND NOT EXISTS(SELECT 1 FROM evidence_items e WHERE e.workspace_id=raw.workspace_id
  AND (rtrim(e.source_reference,'/')=rtrim(payload->>'sourceUrl','/') OR EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(origins,'[]')) o WHERE rtrim(e.source_reference,'/')=rtrim(o->'source'->>'sourceUrl','/')))
  AND (e.retention_expires_at<=clock_timestamp() OR (NOT e.terms_allow_retention AND e.retention_expires_at IS NULL)))
 AND NOT EXISTS(SELECT 1 FROM sourcing_candidates lost WHERE lost.workspace_id=raw.workspace_id
  AND lost.source_check->>'state'='unavailable' AND lost.source_check->>'reason' IN ('source_unavailable','source_not_permitted','no_readable_text')
  AND EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(origins,'[]')) o WHERE rtrim(o->'source'->>'sourceUrl','/') IN (rtrim(lost.payload->>'sourceUrl','/'),rtrim(lost.source_check->'lastSuccess'->>'url','/'))))
), keyed AS (
 SELECT permitted.*,CASE WHEN NULLIF(trim(observed->>'website'),'') IS NULL THEN id::text
 ELSE jsonb_build_array(lower(trim(observed->>'firmName')),observed->>'website',lower(trim(observed->>'locality')),observed->>'region')::text END AS duplicate_key FROM permitted
), ranked AS (
 SELECT keyed.*,row_number() OVER(PARTITION BY duplicate_key ORDER BY created_at DESC,id DESC) AS duplicate_rank,
 (count(*) OVER(PARTITION BY duplicate_key)-1)::integer AS duplicate_count FROM keyed
) SELECT * FROM ranked WHERE duplicate_rank=1 AND ($2='all' OR manual_state=$2) ORDER BY created_at DESC,id DESC`;

export async function manualProspectRows(ctx:RepositoryContext,state:string,offset:number):Promise<ManualProspectRow[]> {
 return (await ctx.db.query<ManualProspectRow>(`${MANUAL_PROSPECT_ROWS_SQL} LIMIT 51 OFFSET $3`,[ctx.scope.workspaceId,state,offset])).rows;
}
