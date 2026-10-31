import {candidateInputSchema,discoveryCandidatePayloadSchema,type ProspectPhoneDiscoveryReason} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {readManualProspectSubject} from './manualProspectRows.ts';
import {isPublicResearchUrl} from '../research/sourcePolicy.ts';
import {readResearchSettings} from '../research/settings.ts';
import {listApplicableHolds} from '../policy/holds.ts';
import {MANUAL_SOURCE_LOSS_ACTION} from './manualProspectSourceLoss.ts';
import {readDailyCounter} from '../jobs/counters.ts';
import {RESEARCH_FIRM_RUN_COUNTER} from '../research/ceilings.ts';
import {workspaceBusinessZone} from '../research/ledger.ts';
import {localDate} from '../src/rules/localClock.ts';

export interface PhoneDiscoveryContext {website:string;sourceUrls:string[]}
export type PhoneDiscoveryAuthority=()=>Promise<boolean>;
export async function phoneDiscoveryAdmin(ctx:RepositoryContext,userId:string,lock=true):Promise<boolean>{
 const member=await ctx.db.query<{role:string;status:string}>(`SELECT role,status FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2${lock?' FOR SHARE':''}`,[ctx.scope.workspaceId,userId]);
 return member.rows[0]?.role==='admin'&&member.rows[0]?.status==='active';
}
export async function phoneDiscoveryPrincipal(ctx:RepositoryContext,authority:PhoneDiscoveryAuthority):Promise<boolean>{
 const actor=ctx.scope.actor;
 return actor.kind==='user'&&actor.role==='admin'&&await phoneDiscoveryAdmin(ctx,actor.userId)&&await authority();
}
/** Exact non-deduplicated retained candidate visibility, not a host-based grant. */
export async function phoneDiscoveryContext(ctx:RepositoryContext,candidateId:string,revision:number):Promise<PhoneDiscoveryContext|null>{
 const row=await readManualProspectSubject(ctx,{candidateId,expectedRevision:revision});
 if(!row)return null;
 const ordinary=candidateInputSchema.safeParse(row.payload),raw=discoveryCandidatePayloadSchema.safeParse(row.payload);
 const observed=ordinary.success?ordinary.data:raw.success?raw.data.row:null;
 if(!observed?.website)return null;
 if(raw.success&&raw.data.row.websiteAssociation==='ambiguous')return null;
 const website=observed.website;
 if(!isPublicResearchUrl(website))return null;
 const sourceUrls=Array.isArray(row['source_urls'])?row['source_urls'].filter((url):url is string=>typeof url==='string'):[];
 if(!sourceUrls.length||sourceUrls.length>18)return null;
 return {website,sourceUrls:[...new Set(sourceUrls)].sort()};
}
/** Shared predicate bytes; prepared batch reads bind each run's own URL group. */
export const PHONE_DISCOVERY_SOURCE_LIMIT_SQL=`SELECT
 EXISTS(SELECT 1 FROM evidence_items e WHERE e.workspace_id=$1 AND rtrim(e.source_reference,'/')=ANY($2::text[])
  AND (e.retention_expires_at<=clock_timestamp() OR (NOT e.terms_allow_retention AND e.retention_expires_at IS NULL)))
 OR EXISTS(SELECT 1 FROM audit_events a WHERE a.workspace_id=$1 AND a.action=$3 AND a.subject_kind='sourcing_source_hash'
  AND a.subject_id IN (SELECT encode(sha256(convert_to(url,'UTF8')),'hex') FROM unnest($2::text[]) url))
 OR EXISTS(SELECT 1 FROM sourcing_candidates c WHERE c.workspace_id=$1 AND c.source_check->>'state'='unavailable'
  AND c.source_check->>'reason' IN ('source_unavailable','source_not_permitted','no_readable_text')
  AND (rtrim(c.payload->>'sourceUrl','/')=ANY($2::text[]) OR rtrim(c.source_check->'lastSuccess'->>'url','/')=ANY($2::text[])
   OR EXISTS(SELECT 1 FROM sourcing_candidate_discovery_origins o WHERE o.workspace_id=c.workspace_id AND o.candidate_id=c.id AND rtrim(o.source->>'sourceUrl','/')=ANY($2::text[])))) AS denied,
 (SELECT min(e.retention_expires_at) FROM evidence_items e WHERE e.workspace_id=$1 AND rtrim(e.source_reference,'/')=ANY($2::text[])) AS expires_at`;
/** Per-URL source fences and any shorter pre-existing expiry apply to every page. */
export async function phoneDiscoverySourceLimit(ctx:RepositoryContext,urls:readonly string[]):Promise<{denied:boolean;expiresAt:Date|null}>{
 const normalized=[...new Set(urls.map(url=>url.replace(/\/+$/u,'')))];
 const result=await ctx.db.query<{denied:boolean;expires_at:Date|null}>(PHONE_DISCOVERY_SOURCE_LIMIT_SQL,[ctx.scope.workspaceId,normalized,MANUAL_SOURCE_LOSS_ACTION]);
 return {denied:result.rows[0]?.denied??true,expiresAt:result.rows[0]?.expires_at??null};
}
export async function phoneDiscoveryResearchRefusal(ctx:RepositoryContext,owner:string,countedAt?:Date):Promise<ProspectPhoneDiscoveryReason|null>{
 const settings=await readResearchSettings(ctx);
 if(!settings.enabled)return 'research_disabled';
 if((await listApplicableHolds(ctx,{actionKind:'research',channel:'research',ownerUserId:owner})).length)return 'research_held';
 if(countedAt){
  const zone=await workspaceBusinessZone(ctx),now=await phoneDiscoveryNow(ctx);
  if(localDate(countedAt.toISOString(),zone)!==localDate(now.toISOString(),zone))return 'discovery_expired';
  const used=await readDailyCounter(ctx,{subjectKind:'workspace',subjectKey:ctx.scope.workspaceId,counterKind:RESEARCH_FIRM_RUN_COUNTER,businessTimeZone:zone,at:countedAt.toISOString()});
  if(used<1||used>settings.dailyFirmCeiling)return 'daily_firm_ceiling';
 }
 return null;
}
export async function phoneDiscoveryNow(ctx:RepositoryContext):Promise<Date>{
 return (await ctx.db.query<{at:Date}>('SELECT clock_timestamp() AS at')).rows[0]!.at;
}
