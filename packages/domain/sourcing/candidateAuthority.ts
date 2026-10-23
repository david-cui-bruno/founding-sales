import {isDeepStrictEqual} from 'node:util';
import {candidateAuthorityReadSchema,candidateAuthorityViewSchema,candidateInputSchema,type CandidateAuthorityRead,type CandidateAuthorityView} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {activeIdentityActor} from '../crm/identityAccess.ts';
import {readResearchSettings} from '../research/settings.ts';
import {listApplicableHolds} from '../policy/holds.ts';
import {automaticResearchNow,automaticResearchSource} from './automaticResearchAuthority.ts';
import {verifiedFirmOwner} from './verifiedFirmPolicy.ts';

type CandidateRow={revision:number;payload:unknown;status:string;qualification_blocked:boolean};
type Snapshot={candidate:CandidateRow|null;[key:string]:unknown};
/** One statement observes all dependencies, including absent rows and unavailable lineage.
 * xmin also fences same-value rewrites. No private snapshot data leaves this reader.
 * Caller owns a normal READ COMMITTED transaction, not a read-only transaction:
 * verifiedFirmOwner takes FOR SHARE locks and may wait for an owner change.
 */
async function snapshot(ctx:RepositoryContext,candidateId:string):Promise<Snapshot|null>{
 const row=(await ctx.db.query<{snapshot:Snapshot}>(`SELECT jsonb_build_object(
 'candidate',(SELECT to_jsonb(c)||jsonb_build_object('_version',c.xmin::text) FROM sourcing_candidates c WHERE c.workspace_id=$1 AND c.id=$2),
 'discoverySettings',(SELECT to_jsonb(s)||jsonb_build_object('_version',s.xmin::text) FROM sourcing_discovery_settings s WHERE s.workspace_id=$1),
 'targeting',(SELECT to_jsonb(v)||jsonb_build_object('_version',v.xmin::text) FROM sourcing_targeting_versions v JOIN sourcing_discovery_settings s ON s.workspace_id=v.workspace_id AND s.targeting_version=v.version WHERE s.workspace_id=$1),
 'hits',(SELECT jsonb_agg(jsonb_build_object('hit',to_jsonb(h),'attempt',to_jsonb(a),'hv',h.xmin::text,'av',a.xmin::text) ORDER BY h.source_url) FROM sourcing_discovery_hits h LEFT JOIN sourcing_discovery_attempts a ON a.workspace_id=h.workspace_id AND a.id=h.attempt_id WHERE h.workspace_id=$1 AND h.candidate_id=$2),
 'origins',(SELECT jsonb_agg(jsonb_build_object('origin',to_jsonb(o),'attempt',to_jsonb(a),'ov',o.xmin::text,'av',a.xmin::text) ORDER BY o.candidate_revision) FROM sourcing_apollo_candidate_origins o LEFT JOIN sourcing_apollo_attempts a ON a.workspace_id=o.workspace_id AND a.id=o.attempt_id WHERE o.workspace_id=$1 AND o.candidate_id=$2),
 'memberships',(SELECT jsonb_agg(to_jsonb(m)||jsonb_build_object('_version',m.xmin::text) ORDER BY m.user_id) FROM workspace_memberships m WHERE m.workspace_id=$1 AND (m.user_id=$3 OR m.user_id=(SELECT s.owner_user_id FROM sourcing_discovery_settings s WHERE s.workspace_id=$1))),
 'researchSettings',(SELECT to_jsonb(r)||jsonb_build_object('_version',r.xmin::text) FROM research_settings r WHERE r.workspace_id=$1),
 'holds',(SELECT jsonb_agg(to_jsonb(h)||jsonb_build_object('_version',h.xmin::text) ORDER BY h.id) FROM active_holds h WHERE h.workspace_id=$1 AND h.released_at IS NULL AND 'research'=ANY(h.blocked_action_kinds))
 ) AS snapshot`,[ctx.scope.workspaceId,candidateId,ctx.scope.actor.kind==='user'?ctx.scope.actor.userId:null])).rows[0];
 return row?.snapshot??null;
}
export type CandidateAuthorityResult={ok:true;value:CandidateAuthorityView}|{ok:false;reason:'admin_only'|'candidate_unavailable'|'authority_changed'|'invalid_input'};
/** Metadata observation only. No qualification run, provider port or write owner is used. */
export async function readCandidateAuthority(ctx:RepositoryContext,input:CandidateAuthorityRead):Promise<CandidateAuthorityResult>{
 if(ctx.scope.actor.kind!=='user'||ctx.scope.actor.role!=='admin'||!await activeIdentityActor(ctx))return {ok:false,reason:'admin_only'};
 const parsed=candidateAuthorityReadSchema.safeParse(input);if(!parsed.success)return {ok:false,reason:'invalid_input'};
 const initial=await snapshot(ctx,input.candidateId),row=initial?.candidate;
 if(!row||row.revision!==input.expectedRevision||row.status==='dismissed'||row.qualification_blocked)return {ok:false,reason:'candidate_unavailable'};
 const candidate=candidateInputSchema.safeParse(row.payload);if(!candidate.success)return {ok:false,reason:'candidate_unavailable'};
 const source=await automaticResearchSource(ctx,input.candidateId,row.revision,candidate.data);
 const attested=await verifiedFirmOwner(ctx);
 const member=attested?(await ctx.db.query<{role:string;status:string}>('SELECT role,status FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 FOR SHARE',[ctx.scope.workspaceId,attested])).rows[0]:null;
 const owner=attested&&member?.role==='admin'&&member.status==='active'?attested:null;
 const settings=await readResearchSettings(ctx);
 const holds=owner?await listApplicableHolds(ctx,{actionKind:'research',channel:'research',ownerUserId:owner}):null;
 const checkedAt=await automaticResearchNow(ctx);
 if(!await activeIdentityActor(ctx)||!isDeepStrictEqual(initial,await snapshot(ctx,input.candidateId)))return {ok:false,reason:'authority_changed'};
 return {ok:true,value:candidateAuthorityViewSchema.parse({candidateId:input.candidateId,candidateRevision:row.revision,checkedAt,source:source?{status:'matched',kind:source.source.kind,attemptId:source.source.attemptId}:{status:'unavailable'},owner:owner?'current_admin':'unavailable',researchEnabled:settings.enabled,holds:holds===null?'unknown':holds.length?'held':'clear',authority:'not_granted'})};
}
