import type {RepositoryContext} from '../db/workspaceScope.ts';
import type {ManualProspectRow} from './manualProspectProjection.ts';
import type {ManualPhoneSnapshot} from './manualProspectPhone.ts';
import {PREPARED_CAPTURE_POLICY,preparedCaptureManifest} from './preparedCapture.ts';

/** Candidate/source lifecycle is already held by the prepared read owner. Lock
 * ancestors before descendants, then ONE globally sorted evidence union before
 * the shared exact reader can lock a higher-ID final-page row. No grant is made. */
export async function lockPreparedCaptureDependencies(ctx:RepositoryContext,rows:readonly ManualProspectRow[]):Promise<void>{
 if(!rows.length)return;
 const raw=(await ctx.db.query<ManualPhoneSnapshot&{original_run_id:string|null}>(`SELECT r.id,r.candidate_id,r.candidate_revision,r.observations,r.retained_identity_decision_id,
 r.capture_policy_version,r.state AS capture_state,r.prepared_capture,c.payload,d.original_run_id
 FROM sourcing_candidates c JOIN LATERAL(SELECT * FROM sourcing_qualification_runs q WHERE q.workspace_id=c.workspace_id AND q.candidate_id=c.id ORDER BY q.requested_at DESC,q.id DESC LIMIT 1) r ON r.candidate_revision=c.revision
 LEFT JOIN sourcing_retained_identity_decisions d ON d.workspace_id=r.workspace_id AND d.candidate_id=r.candidate_id AND d.id=r.retained_identity_decision_id
 WHERE c.workspace_id=$1 AND c.id=ANY($2::uuid[]) ORDER BY c.id`,[ctx.scope.workspaceId,rows.map(r=>r.id)])).rows;
 const ancestors=[...new Set(raw.flatMap(r=>r.original_run_id?[r.original_run_id]:[]))],descendants=raw.map(r=>r.id).filter(id=>!ancestors.includes(id));
 for(const ids of [ancestors,descendants])if(ids.length)await ctx.db.query('SELECT id FROM sourcing_qualification_runs WHERE workspace_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE',[ctx.scope.workspaceId,ids]);
 const pages=raw.flatMap(r=>Array.isArray(r.observations)?r.observations:[]);
 const dependencies=[...new Set(raw.flatMap(r=>r['capture_policy_version']===PREPARED_CAPTURE_POLICY?preparedCaptureManifest(r)?.pages.flatMap(p=>p.redirectUrls)??[]:[]))].map(url=>url.replace(/\/+$/u,''));
 await ctx.db.query(`SELECT e.id FROM evidence_items e WHERE e.workspace_id=$1 AND (
 EXISTS(SELECT 1 FROM jsonb_array_elements($2::jsonb) page WHERE e.source_reference=page->>'url' AND e.content_hash=page->>'contentHash'
 AND to_char(e.retrieved_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')=page->>'retrievedAt'
 AND (e.terms_allow_retention OR e.retention_expires_at>clock_timestamp()))
 OR rtrim(e.source_reference,'/')=ANY($3::text[])) ORDER BY e.id FOR SHARE OF e`,[ctx.scope.workspaceId,JSON.stringify(pages),dependencies]);
}
