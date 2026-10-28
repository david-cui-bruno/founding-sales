import type {RepositoryContext} from '../db/workspaceScope.ts';
import type {FirmRow} from '../crm/types.ts';
import {readPreparationSource,preparationSelection} from './preparationSource.ts';
import {phoneDiscoveryAdmin} from '../sourcing/prospectPhoneDiscoveryAuthority.ts';
import type {PreparationRow} from './preparationStore.ts';
export const SOURCE_UNAVAILABLE_COMPANY='[source unavailable company]';
export interface PreparedProjection {readonly current:boolean;readonly expiresAt:number;readonly profile?:Readonly<Record<string,unknown>>;readonly route?:{id:string;value:string;version:number}}
/** Nonlocking current reads reuse the retained-source rules. They acquire no
 * lifecycle/member locks underneath ordinary CRM row owners and grant no execution.
 * Execution separately retains upfront lifecycle custody through its gate/commit.
 */
export async function readPreparedProjections(ctx:RepositoryContext,firmIds:readonly string[]):Promise<ReadonlyMap<string,PreparedProjection>>{
 const states=new Map<string,PreparedProjection>();if(!firmIds.length)return states;
 const rows=(await ctx.db.query<PreparationRow>('SELECT * FROM calling_preparations WHERE workspace_id=$1 AND firm_ref=ANY($2::uuid[])',[ctx.scope.workspaceId,[...firmIds]])).rows;
 for(const p of rows){
  const input=preparationSelection(p.candidate_ref,p.candidate_revision,p.choice),until=p.source_expires_at.getTime();
  states.set(p.firm_ref,{current:false,expiresAt:until});
  if(p.state!=='live'||!input||until<=Date.now()||!await phoneDiscoveryAdmin(ctx,p.prepared_by_ref,false))continue;
  const source=await readPreparationSource(ctx,input,async()=>true,true);
  if(!source.ok||source.value.run.id!==p.discovery_run_ref||source.value.run.creator_user_id!==p.source_creator_ref)continue;
  const exact=(await ctx.db.query(`SELECT f.name,f.website,f.address_line,f.locality,f.region_code,f.postal_code,f.country_code,f.time_zone,f.time_zone_confidence,f.time_zone_source,f.time_zone_unresolved_reason,r.id route_id,r.e164,r.version FROM firms f JOIN phone_routes r ON r.workspace_id=f.workspace_id AND r.firm_id=f.id
   WHERE f.workspace_id=$1 AND f.id=$2 AND f.calling_preparation_id=$3 AND f.calling_preparation_erased_at IS NULL
   AND r.id=$4 AND r.calling_preparation_id=$3 AND r.calling_preparation_erased_at IS NULL AND r.e164=$5 AND r.version=$6
   AND calling_preparation_profile_hash($1,$2)=$7
   AND EXISTS(SELECT 1 FROM calling_preparations current WHERE current.workspace_id=f.workspace_id AND current.id=$3 AND current.state='live' AND current.revision=$8)`,[ctx.scope.workspaceId,p.firm_ref,p.id,p.route_ref,source.value.phone.value,p.route_version,p.profile_hash,p.revision])).rows[0];
  states.set(p.firm_ref,{current:!!exact,expiresAt:Math.min(until,Date.parse(source.value.phone.expiresAt)),...(exact?{profile:{name:exact['name'],website:exact['website'],addressLine:exact['address_line'],locality:exact['locality'],regionCode:exact['region_code'],postalCode:exact['postal_code'],countryCode:exact['country_code'],timeZone:exact['time_zone'],timeZoneConfidence:exact['time_zone_confidence'],timeZoneSource:exact['time_zone_source'],timeZoneUnresolvedReason:exact['time_zone_unresolved_reason']},route:{id:String(exact['route_id']),value:String(exact['e164']),version:Number(exact['version'])}}:{})});
 }
 return states;
}
export function preparedProjectionUnavailable(states:ReadonlyMap<string,PreparedProjection>,firmId:string,now=Date.now()):boolean{
 const state=states.get(firmId);return !!state&&(!state.current||state.expiresAt<=now);
}
export function projectPreparedFirm<T extends FirmRow>(row:T,states:ReadonlyMap<string,PreparedProjection>):T{
 if(!preparedProjectionUnavailable(states,row.id))return row;
 return {...row,name:row.name==='[deleted]'?'[deleted]':SOURCE_UNAVAILABLE_COMPANY,website:null,address_line:null,locality:null,region_code:null,postal_code:null,country_code:'ZZ',
  time_zone:null,time_zone_confidence:null,time_zone_source:null,time_zone_rule_version:null,time_zone_unresolved_reason:null};
}

/** Action labels authored by people remain independent. Only current company
 * names on reply/meeting targets and explicit company associations are projected. */
export async function projectPreparedActionSubjects<T extends {subject:string;target:{kind:string;firmId?:string|undefined};callingPreparationExpiresAt?:string|undefined;firms?:readonly {id:string;name:string;callingPreparationExpiresAt?:string|undefined}[]|null|undefined}>(ctx:RepositoryContext,actions:readonly T[],includeLease=false):Promise<T[]>{
 const ids=actions.flatMap(a=>[...((a.target.kind==='reply'||a.target.kind==='meeting')&&a.target.firmId?[a.target.firmId]:[]),...(a.firms??[]).map(f=>f.id)]);
 const states=await readPreparedProjections(ctx,ids);
 return actions.map(a=>{
  const projected={...a,subject:(a.target.kind==='reply'||a.target.kind==='meeting')&&a.target.firmId&&preparedProjectionUnavailable(states,a.target.firmId)?SOURCE_UNAVAILABLE_COMPANY:a.subject,
   ...(a.firms?{firms:a.firms.map(f=>{const {callingPreparationExpiresAt:_old,...identity}=f;return {...identity,name:preparedProjectionUnavailable(states,f.id)?SOURCE_UNAVAILABLE_COMPANY:f.name,...preparedCallingLease(states,f.id,includeLease)};})}:{})};
  delete projected.callingPreparationExpiresAt;
  if((a.target.kind==='reply'||a.target.kind==='meeting')&&a.target.firmId)Object.assign(projected,preparedCallingLease(states,a.target.firmId,includeLease));
  return projected;
 });
}

/** Explicit opt-in only: the original source deadline never grants execution. */
export function preparedCallingLease(states:ReadonlyMap<string,PreparedProjection>,firmId:string,include=false):{callingPreparationExpiresAt?:string}{
 const p=states.get(firmId);return include&&p?.current&&p.expiresAt>Date.now()?{callingPreparationExpiresAt:new Date(p.expiresAt).toISOString()}:{};
}
