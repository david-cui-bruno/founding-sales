import type {CallingPreparationProfile} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {FIRM_ZONE_RULE_VERSION} from '../src/rules/statePosture.ts';
export interface PreparationRow extends Record<string,unknown>{
 id:string;candidate_ref:string;candidate_revision:number;discovery_run_ref:string;source_creator_ref:string;prepared_by_ref:string;
 firm_ref:string;route_ref:string;revision:number;route_version:number;state:'live'|'erased';choice:unknown;
 source_expires_at:Date;profile_hash:string|null;
}
export async function preparationForCandidate(ctx:RepositoryContext,candidateId:string):Promise<PreparationRow|null>{
 return (await ctx.db.query<PreparationRow>('SELECT * FROM calling_preparations WHERE workspace_id=$1 AND candidate_ref=$2',[ctx.scope.workspaceId,candidateId])).rows[0]??null;
}
export async function preparationForFirm(ctx:RepositoryContext,firmId:string):Promise<PreparationRow|null>{
 return (await ctx.db.query<PreparationRow>('SELECT * FROM calling_preparations WHERE workspace_id=$1 AND firm_ref=$2',[ctx.scope.workspaceId,firmId])).rows[0]??null;
}
export function profileValues(profile:CallingPreparationProfile):unknown[]{
 const zone=profile.timeZone.kind==='reviewed'?profile.timeZone.timeZone:null;
 return [profile.companyName,profile.website,profile.addressLine,profile.locality,profile.regionCode,profile.postalCode,profile.countryCode,
  zone,zone?'high':null,zone?'recorded':null,zone?FIRM_ZONE_RULE_VERSION:null,null];
}
export async function plannedProfileHash(ctx:RepositoryContext,profile:CallingPreparationProfile):Promise<string>{
 const result=await ctx.db.query<{hash:string}>("SELECT encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') AS hash",[JSON.stringify(profileValues(profile))]);
 return result.rows[0]!.hash;
}
export async function writePreparedProfile(ctx:RepositoryContext,firmId:string,profile:CallingPreparationProfile):Promise<void>{
 await ctx.db.query(`UPDATE firms SET name=$3,website=$4,address_line=$5,locality=$6,region_code=$7,postal_code=$8,country_code=$9,
  time_zone=$10,time_zone_confidence=$11,time_zone_source=$12,time_zone_rule_version=$13,time_zone_unresolved_reason=$14,updated_at=clock_timestamp()
  WHERE workspace_id=$1 AND id=$2`,[ctx.scope.workspaceId,firmId,...profileValues(profile)]);
}
export async function storedPreparedProfile(ctx:RepositoryContext,firmId:string):Promise<CallingPreparationProfile|null>{
 const row=(await ctx.db.query<{name:string;website:string|null;address_line:string|null;locality:string|null;region_code:string|null;postal_code:string|null;country_code:string;time_zone:string|null}>(
  'SELECT name,website,address_line,locality,region_code,postal_code,country_code,time_zone FROM firms WHERE workspace_id=$1 AND id=$2',[ctx.scope.workspaceId,firmId])).rows[0];
 return row&&row.country_code==='US'?{companyName:row.name,website:row.website,addressLine:row.address_line,locality:row.locality,regionCode:row.region_code,
  postalCode:row.postal_code,countryCode:'US',timeZone:row.time_zone?{kind:'reviewed',timeZone:row.time_zone}:{kind:'unknown'}}:null;
}
/** Known committed matches only; no automatic links or global entity resolution. */
export async function preparationDuplicates(ctx:RepositoryContext,profile:CallingPreparationProfile,e164:string,exceptFirm:string|null):Promise<string[]>{
 const domain=profile.website?new URL(profile.website).hostname.toLowerCase().replace(/^www\./u,''):null;
 return (await ctx.db.query<{id:string}>(`SELECT f.id FROM firms f WHERE f.workspace_id=$1 AND f.status='active' AND($2::uuid IS NULL OR f.id<>$2)
  AND((lower(regexp_replace(trim(f.name),'\\s+',' ','g'))=$3 AND lower(f.locality) IS NOT DISTINCT FROM $4::text AND f.region_code IS NOT DISTINCT FROM $5::text)
   OR($6::text IS NOT NULL AND regexp_replace(lower(split_part(f.website,'/',3)),'^www\\.','')=$6)
   OR EXISTS(SELECT 1 FROM phone_routes r WHERE r.workspace_id=f.workspace_id AND r.firm_id=f.id AND r.e164=$7)) ORDER BY f.id`,
 [ctx.scope.workspaceId,exceptFirm,profile.companyName.normalize('NFKC').trim().replace(/\s+/gu,' ').toLowerCase(),profile.locality?.toLowerCase()??null,profile.regionCode,domain,e164])).rows.map(row=>row.id);
}
