import type {RepositoryContext} from '../db/workspaceScope.ts';
import {activeIdentityActor} from '../crm/identityAccess.ts';
import {phoneDiscoverySourceLimit} from './prospectPhoneDiscoveryAuthority.ts';
import {isDeepStrictEqual} from 'node:util';

/** Reuse the existing per-URL denial/retention owner; this is no phone grant.
 * The caller separately checks current run, research settings, holds and budget.
 * The adapter still owns URL/DNS/robots checks before every actual request. */
export async function preparedCaptureSourcesAvailable(ctx:RepositoryContext,urls:readonly string[]):Promise<boolean> {
 if(ctx.scope.actor.kind==='user'&&!await activeIdentityActor(ctx))return false;
 return !(await phoneDiscoverySourceLimit(ctx,urls)).denied;
}
/** Internal capture-stage witness, never a contract/model field. A later source
 * deletion before a manifest exists must not disappear from the final check. */
export interface PreparedCaptureSourceWitness {url:string;denied:boolean;expiresAt:string|null;evidence:Record<string,unknown>[];sourceStates:Record<string,unknown>[]}
export async function preparedCaptureSourceWitness(ctx:RepositoryContext,url:string):Promise<PreparedCaptureSourceWitness>{
 const key=url.replace(/\/+$/u,''),limit=await phoneDiscoverySourceLimit(ctx,[url]);
 const evidence=(await ctx.db.query('SELECT id,source_reference,content_hash,retrieved_at,terms_allow_retention,retention_expires_at FROM evidence_items WHERE workspace_id=$1 AND rtrim(source_reference,\'/\')=$2 ORDER BY id',[ctx.scope.workspaceId,key])).rows;
 // Relevant source-check generations and origin semantics prevent an in-flight
 // unavailable→fresh-pending transition from reviving an older capture. Ignore
 // admission/update timestamps and every unrelated candidate/source row.
 const sourceStates=(await ctx.db.query(`SELECT c.id,c.revision,rtrim(c.payload->>'sourceUrl','/') AS source_url,
 rtrim(c.source_check->'lastSuccess'->>'url','/') AS last_success_url,
 encode(sha256(convert_to(COALESCE(c.source_check::text,''),'UTF8')),'hex') AS source_check_key,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('provider',o.provider,'release',o.release,'recordId',o.record_id,
 'sourceKey',encode(sha256(convert_to(jsonb_build_array(o.source,o.source_metadata,o.licenses,o.notices)::text,'UTF8')),'hex')) ORDER BY o.provider,o.release,o.record_id)
 FROM sourcing_candidate_discovery_origins o WHERE o.workspace_id=c.workspace_id AND o.candidate_id=c.id AND rtrim(o.source->>'sourceUrl','/')=$2),'[]'::jsonb) AS origins
 FROM sourcing_candidates c WHERE c.workspace_id=$1 AND (rtrim(c.payload->>'sourceUrl','/')=$2 OR rtrim(c.source_check->'lastSuccess'->>'url','/')=$2
 OR EXISTS(SELECT 1 FROM sourcing_candidate_discovery_origins o WHERE o.workspace_id=c.workspace_id AND o.candidate_id=c.id AND rtrim(o.source->>'sourceUrl','/')=$2)) ORDER BY c.id`,[ctx.scope.workspaceId,key])).rows;
 const active=ctx.scope.actor.kind!=='user'||await activeIdentityActor(ctx);
 return {url:key,denied:limit.denied||!active,expiresAt:limit.expiresAt?.toISOString()??null,evidence,sourceStates};
}
export async function preparedCaptureWitnessesCurrent(ctx:RepositoryContext,urls:readonly string[],witnesses:readonly PreparedCaptureSourceWitness[]|undefined):Promise<boolean>{
 const keys=[...new Set(urls.map(url=>url.replace(/\/+$/u,'')))].sort();
 if(!witnesses||witnesses.length!==keys.length||new Set(witnesses.map(w=>w.url)).size!==keys.length)return false;
 for(const key of keys){const before=witnesses.find(w=>w.url===key);if(!before||before.denied||!isDeepStrictEqual(before,await preparedCaptureSourceWitness(ctx,key)))return false;}
 return true;
}
