import type {CandidateInput} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {readResearchSettings} from '../research/settings.ts';
import {listApplicableHolds} from '../policy/holds.ts';
import {validVerifiedFirmAttestation,type VerifiedFirmAttestation} from './verifiedFirmPolicy.ts';
import {automaticResearchSourceSnapshot} from './automaticResearchAuthority.ts';
import {retainedCandidateOnly} from './retainedAcquisition.ts';

/** Plain reads: callers may already hold candidate/run locks. Never acquire owner locks in reverse order. */
export async function preparedIdentityCurrentSource(ctx:RepositoryContext,candidateId:string,revision:number,candidate:CandidateInput):Promise<boolean> {
 if(await retainedCandidateOnly(ctx,candidateId))return false;
 const settings=(await ctx.db.query<{owner_user_id:string;role:string;status:string;qualification_evaluation:VerifiedFirmAttestation|null}>(`SELECT s.owner_user_id,s.qualification_evaluation,m.role,m.status FROM sourcing_discovery_settings s
 JOIN workspace_memberships m ON m.workspace_id=s.workspace_id AND m.user_id=s.owner_user_id
 WHERE s.workspace_id=$1 AND s.enabled AND s.auto_admission_enabled`,[ctx.scope.workspaceId])).rows[0];
 if(!settings||settings.role!=='admin'||settings.status!=='active'||!validVerifiedFirmAttestation(settings.qualification_evaluation)||!(await readResearchSettings(ctx)).enabled)return false;
 if((await listApplicableHolds(ctx,{actionKind:'research',channel:'research',ownerUserId:settings.owner_user_id})).length)return false;
 // An eventual search-hit association does not turn an existing manual/edited draft into automatic intake.
 const intake=(await ctx.db.query(`SELECT 1 FROM sourcing_candidates c JOIN sourcing_discovery_hits h ON h.workspace_id=c.workspace_id AND h.candidate_id=c.id
 JOIN sourcing_discovery_attempts a ON a.workspace_id=h.workspace_id AND a.id=h.attempt_id
 WHERE c.workspace_id=$1 AND c.id=$2 AND c.revision=$3 AND c.revision=1 AND c.status='needs_review' AND NOT c.qualification_blocked
 AND h.retrieved_at=c.created_at AND h.source_url=c.payload->>'sourceUrl' AND h.source_url=c.payload->>'website'
 AND a.state='complete' AND a.query=c.payload->>'discoveryQuery' LIMIT 1`,[ctx.scope.workspaceId,candidateId,revision])).rows.length>0;
 if(!intake)return false;
 const source=await automaticResearchSourceSnapshot(ctx,candidateId,revision,candidate);
 return source?.value.source.kind==='search_hit';
}
/** Only a NEW ordinary automatic worker/scheduler request can select the new producer. */
export async function preparedIdentityProducerAuthority(ctx:RepositoryContext,candidateId:string,revision:number,candidate:CandidateInput):Promise<boolean> {
 const actor=ctx.scope.actor;
 return actor.kind==='system'&&['worker','scheduler'].includes(actor.component)&&await preparedIdentityCurrentSource(ctx,candidateId,revision,candidate);
}
