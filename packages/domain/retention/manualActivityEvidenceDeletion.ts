import type {RepositoryContext} from '../db/workspaceScope.ts';
import {rememberExpiredManualSources} from '../sourcing/manualProspectSourceLoss.ts';
/** Caller holds the raw source lifecycle lock BEFORE the deletion lock hierarchy.
 * DELETE classifies expiry at the actual removal, not an earlier preview. Its
 * denied source hashes and physical activity erasure commit atomically with it,
 * while the lifecycle lock excludes fresh activity reads/saves and retention.
 * Only URLs that participate in raw authority are fenced. Optional qualification
 * observations and unrelated evidence are not raw granting sources.
 */
export async function deleteManualActivityEvidence(ctx:RepositoryContext,scope:{firmId:string;contactId:string|null}):Promise<number>{
 const deleted=await ctx.db.query<{source_reference:string;denied:boolean}>(`DELETE FROM evidence_items
 WHERE workspace_id=$1 AND firm_id=$2 AND ($3::uuid IS NULL OR contact_id=$3)
 RETURNING source_reference,(retention_expires_at<=clock_timestamp() OR (NOT terms_allow_retention AND retention_expires_at IS NULL)) IS TRUE AS denied`,[ctx.scope.workspaceId,scope.firmId,scope.contactId]);
 const denied=deleted.rows.filter(r=>r.denied).map(r=>r.source_reference);
 if(denied.length){
  const associated=await ctx.db.query<{url:string}>(`SELECT DISTINCT url FROM unnest($2::text[]) url
 WHERE EXISTS(SELECT 1 FROM sourcing_candidates c WHERE c.workspace_id=$1 AND
 (rtrim(c.payload->>'sourceUrl','/')=rtrim(url,'/') OR rtrim(c.source_check->'lastSuccess'->>'url','/')=rtrim(url,'/')
 OR EXISTS(SELECT 1 FROM sourcing_candidate_discovery_origins o WHERE o.workspace_id=c.workspace_id AND o.candidate_id=c.id AND rtrim(o.source->>'sourceUrl','/')=rtrim(url,'/'))))`,[ctx.scope.workspaceId,denied]);
  await rememberExpiredManualSources(ctx,associated.rows.map(r=>r.url));
 }
 return deleted.rowCount??0;
}
