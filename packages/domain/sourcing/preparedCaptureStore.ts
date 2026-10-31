import type {RepositoryContext} from '../db/workspaceScope.ts';
import type {ManualPhoneSnapshot} from './manualProspectPhone.ts';
import {isDeepStrictEqual} from 'node:util';
import {activeIdentityActor} from '../crm/identityAccess.ts';
import {phoneDiscoverySourceLimit} from './prospectPhoneDiscoveryAuthority.ts';
import {PREPARED_CAPTURE_POLICY,preparedCaptureManifest} from './preparedCapture.ts';

/** Called only by prepared research after the shared reader has locked current
 * candidates and runs. Repeating this with every source recheck makes manifest
 * erasure/state changes part of the same post-wait snapshot comparison. */
export async function withPreparedCaptureSnapshots(ctx:RepositoryContext,snapshots:readonly ManualPhoneSnapshot[]):Promise<ManualPhoneSnapshot[]> {
 if(!snapshots.length)return [];
 const captures=(await ctx.db.query<{id:string;candidate_id:string;candidate_revision:number;capture_policy_version:string;capture_state:string;prepared_capture:unknown;payload:unknown}>(`SELECT r.id,r.candidate_id,r.candidate_revision,r.capture_policy_version,r.state AS capture_state,r.prepared_capture,c.payload
 FROM sourcing_qualification_runs r JOIN sourcing_candidates c ON c.workspace_id=r.workspace_id AND c.id=r.candidate_id AND c.revision=r.candidate_revision
 WHERE r.workspace_id=$1 AND r.id=ANY($2::uuid[]) AND c.status<>'dismissed'
 AND NOT EXISTS(SELECT 1 FROM sourcing_qualification_runs newer WHERE newer.workspace_id=r.workspace_id AND newer.candidate_id=r.candidate_id AND (newer.requested_at,newer.id)>(r.requested_at,r.id)) ORDER BY r.id`,[ctx.scope.workspaceId,snapshots.map(s=>s.id)])).rows;
 const result:ManualPhoneSnapshot[]=[];
 for(const snapshot of snapshots){
  const capture=captures.find(row=>row.id===snapshot.id&&row.candidate_id===snapshot.candidate_id&&row.candidate_revision===snapshot.candidate_revision&&isDeepStrictEqual(row.payload,snapshot.payload));
  const current={...snapshot,capture_policy_version:capture?.capture_policy_version??'legacy',capture_state:capture?.capture_state??null,prepared_capture:capture?.prepared_capture??null};
  const manifest=preparedCaptureManifest(current);
  if(manifest?.version===PREPARED_CAPTURE_POLICY){
   const dependencyUrls=[...new Set(manifest.pages.flatMap(page=>page.redirectUrls))].sort(),groups=[...new Set(dependencyUrls.map(url=>url.replace(/\/+$/u,'')))];
   const limit=await phoneDiscoverySourceLimit(ctx,dependencyUrls);
   const evidence=(await ctx.db.query(`SELECT id,source_reference,content_hash,retrieved_at,terms_allow_retention,retention_expires_at FROM evidence_items WHERE workspace_id=$1 AND rtrim(source_reference,'/')=ANY($2::text[]) ORDER BY id`,[ctx.scope.workspaceId,groups])).rows;
   const lifecycle=(await ctx.db.query<{held:boolean}>("SELECT calling_preparation_lock_held('sourcing-discovery-review:'||$1::text,'ExclusiveLock') AS held",[ctx.scope.workspaceId])).rows[0]?.held===true;
   const principal=lifecycle&&ctx.scope.actor.kind==='user'&&ctx.scope.actor.role==='admin'&&await activeIdentityActor(ctx);
   result.push({...current,prepared_capture_authority:{dependencyUrls,denied:limit.denied||!principal,validUntil:limit.expiresAt?.toISOString()??null,evidence}});
  }else result.push(current);
 }
 return result;
}
