import type {CandidateInput} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {readResearchSettings} from '../research/settings.ts';
import {listApplicableHolds} from '../policy/holds.ts';
import {verifiedFirmOwner} from './verifiedFirmPolicy.ts';
import {readTargetingPolicy} from './targetingProposals.ts';
import {isTargetGeography} from './qualificationPolicy.ts';
import {identityFold} from './nativeFirmEligibility.ts';

/** Wall time, not transaction-start now(): evidence can expire while a lock waits. */
export async function automaticResearchNow(ctx:RepositoryContext):Promise<string>{
 const row=(await ctx.db.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0];
 if(!row)throw new Error('database clock unavailable');return row.now.toISOString();
}
export async function automaticResearchOwner(ctx:RepositoryContext):Promise<string|null>{
 const owner=await verifiedFirmOwner(ctx);if(!owner)return null;
 const member=(await ctx.db.query<{role:string;status:string}>('SELECT role,status FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 FOR SHARE',[ctx.scope.workspaceId,owner])).rows[0];
 if(member?.role!=='admin'||member.status!=='active'||!(await readResearchSettings(ctx)).enabled||(await listApplicableHolds(ctx,{actionKind:'research',channel:'research'})).length)return null;
 return owner;
}
export type AutomaticSource={kind:'search_hit'|'apollo_organization';attemptId:string;sourceUrl:string};
/** Exact retained source association. A label or same-name result is never provenance. */
export async function automaticResearchSource(ctx:RepositoryContext,candidateId:string,revision:number,candidate:CandidateInput):Promise<{source:AutomaticSource;binding:unknown;originRevision:number|null}|null>{
 if(!isTargetGeography(candidate.region,candidate.locality))return null;
 const policy=await readTargetingPolicy(ctx);
 const hits=(await ctx.db.query<{attempt_id:string;source_url:string;query_id:string;query:string;policy_version:string;native_result:{url?:string}}>(`SELECT h.attempt_id,h.source_url,h.native_result,a.query_id,a.query,a.policy_version FROM sourcing_discovery_hits h JOIN sourcing_discovery_attempts a ON a.workspace_id=h.workspace_id AND a.id=h.attempt_id WHERE h.workspace_id=$1 AND h.candidate_id=$2 AND a.state='complete' AND h.source_url=$3`,[ctx.scope.workspaceId,candidateId,candidate.website])).rows;
 const origins=(await ctx.db.query<{attempt_id:string;candidate_revision:number;organization_name:string;domain:string;hq_city:string;hq_state:string;region:string}>(`SELECT o.*,a.region FROM sourcing_apollo_candidate_origins o JOIN sourcing_apollo_attempts a ON a.workspace_id=o.workspace_id AND a.id=o.attempt_id WHERE o.workspace_id=$1 AND o.candidate_id=$2 AND o.candidate_revision<=$3 AND a.state='complete'`,[ctx.scope.workspaceId,candidateId,revision])).rows;
 const sources:{source:AutomaticSource;binding:unknown;originRevision:number|null}[]=[];
 for(const hit of hits){
  const query=policy.queries.find(q=>q.id===hit.query_id&&q.query===hit.query&&q.region===candidate.region&&identityFold(q.locality)===identityFold(candidate.locality));
  if(query&&hit.policy_version===policy.version&&candidate.discoveryQuery===hit.query&&candidate.sourceUrl===hit.source_url&&hit.native_result.url===hit.source_url)sources.push({source:{kind:'search_hit',attemptId:hit.attempt_id,sourceUrl:hit.source_url},binding:{hit,policy},originRevision:null});
 }
 for(const origin of origins){
  const site=`https://${origin.domain}/`;
  if(candidate.website===site&&candidate.sourceUrl===site&&origin.organization_name===candidate.firmName&&origin.hq_city===candidate.locality&&origin.hq_state===candidate.region&&origin.region===candidate.region)sources.push({source:{kind:'apollo_organization',attemptId:origin.attempt_id,sourceUrl:site},binding:{origin,policy},originRevision:origin.candidate_revision});
 }
 return sources.length===1?sources[0]!:null;
}
