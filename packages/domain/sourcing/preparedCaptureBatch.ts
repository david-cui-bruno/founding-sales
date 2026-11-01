import {isDeepStrictEqual} from 'node:util';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {activeIdentityActor} from '../crm/identityAccess.ts';
import type {ManualPhoneSnapshot} from './manualProspectPhone.ts';
import {PHONE_DISCOVERY_SOURCE_LIMIT_SQL} from './prospectPhoneDiscoveryAuthority.ts';
import {MANUAL_SOURCE_LOSS_ACTION} from './manualProspectSourceLoss.ts';
import {PREPARED_CAPTURE_POLICY,preparedCaptureManifest} from './preparedCapture.ts';

type Evidence=Record<string,unknown>&{id:string;source_reference:string};
type Dependency={id:string;dependencyUrls:string[];groups:Set<string>};
/** One fresh prepared-only batch per existing read phase. Each run retains its
 * own URL/denial/expiry/evidence set; the union is only a database transport bound.
 * Principal/lifecycle are common to this single context, never cached across calls.
 * Shared manual/phone grants and permitted_urls are neither changed nor reused. */
export interface PreparedCaptureCustody {
 /** The principal whose authority a captured dependency needs, when it is not the reading actor (a preparation's preparer). */
 principal:boolean;
 /** A nonlocking projection read: no lifecycle lock is held, so none is required of it. */
 lockless?:boolean;
}
export async function withPreparedCaptureSnapshots(ctx:RepositoryContext,snapshots:readonly ManualPhoneSnapshot[],custody?:PreparedCaptureCustody):Promise<ManualPhoneSnapshot[]>{
 if(!snapshots.length)return [];
 const captures=(await ctx.db.query<{id:string;candidate_id:string;candidate_revision:number;capture_policy_version:string;capture_state:string;prepared_capture:unknown;payload:unknown}>(`SELECT r.id,r.candidate_id,r.candidate_revision,r.capture_policy_version,r.state AS capture_state,r.prepared_capture,c.payload
 FROM sourcing_qualification_runs r JOIN sourcing_candidates c ON c.workspace_id=r.workspace_id AND c.id=r.candidate_id AND c.revision=r.candidate_revision
 WHERE r.workspace_id=$1 AND r.id=ANY($2::uuid[]) AND c.status<>'dismissed'
 AND NOT EXISTS(SELECT 1 FROM sourcing_qualification_runs newer WHERE newer.workspace_id=r.workspace_id AND newer.candidate_id=r.candidate_id AND (newer.requested_at,newer.id)>(r.requested_at,r.id)) ORDER BY r.id`,[ctx.scope.workspaceId,snapshots.map(s=>s.id)])).rows;
 const current=snapshots.map(snapshot=>{
  const capture=captures.find(row=>row.id===snapshot.id&&row.candidate_id===snapshot.candidate_id&&row.candidate_revision===snapshot.candidate_revision&&isDeepStrictEqual(row.payload,snapshot.payload));
  return {...snapshot,capture_policy_version:capture?.capture_policy_version??'legacy',capture_state:capture?.capture_state??null,prepared_capture:capture?.prepared_capture??null};
 });
 const dependencies=new Map<string,Dependency>();
 for(const snapshot of current){
  const manifest=preparedCaptureManifest(snapshot);if(manifest?.version!==PREPARED_CAPTURE_POLICY)continue;
  const dependencyUrls=[...new Set(manifest.pages.flatMap(page=>page.redirectUrls))].sort();
  dependencies.set(snapshot.id,{id:snapshot.id,dependencyUrls,groups:new Set(dependencyUrls.map(url=>url.replace(/\/+$/u,'')))});
 }
 if(!dependencies.size)return current;
 // Reuse the exact shared source-limit predicate, replacing only the second
 // parameter with this row's bound text[]. No whole-batch grant is computed.
 const limits=(await ctx.db.query<{id:string;denied:boolean;expires_at:Date|null}>(`WITH requested AS (
 SELECT value->>'id' AS id,ARRAY(SELECT jsonb_array_elements_text(value->'urls')) AS urls FROM jsonb_array_elements($2::jsonb)
 ) SELECT requested.id,limits.denied,limits.expires_at FROM requested CROSS JOIN LATERAL (
 ${PHONE_DISCOVERY_SOURCE_LIMIT_SQL.replaceAll('$2','requested.urls')}
 ) limits ORDER BY requested.id`,[ctx.scope.workspaceId,JSON.stringify([...dependencies.values()].map(d=>({id:d.id,urls:[...d.groups]}))),MANUAL_SOURCE_LOSS_ACTION])).rows;
 const union=[...new Set([...dependencies.values()].flatMap(d=>[...d.groups]))];
 const evidence=(await ctx.db.query<Evidence>("SELECT id,source_reference,content_hash,retrieved_at,terms_allow_retention,retention_expires_at FROM evidence_items WHERE workspace_id=$1 AND rtrim(source_reference,'/')=ANY($2::text[]) ORDER BY id",[ctx.scope.workspaceId,union])).rows;
 const lifecycle=(await ctx.db.query<{held:boolean}>("SELECT calling_preparation_lock_held('sourcing-discovery-review:'||$1::text,'ExclusiveLock') AS held",[ctx.scope.workspaceId])).rows[0]?.held===true;
 const principal=(lifecycle||custody?.lockless===true)&&(custody?custody.principal:ctx.scope.actor.kind==='user'&&ctx.scope.actor.role==='admin'&&await activeIdentityActor(ctx));
 return current.map(snapshot=>{
  const dependency=dependencies.get(snapshot.id);if(!dependency)return snapshot;
  const limit=limits.find(row=>row.id===snapshot.id);
  return {...snapshot,prepared_capture_authority:{dependencyUrls:dependency.dependencyUrls,denied:!limit||limit.denied||!principal,validUntil:limit?.expires_at?.toISOString()??null,
   evidence:evidence.filter(row=>dependency.groups.has(row.source_reference.replace(/\/+$/u,'')))}};
 });
}
