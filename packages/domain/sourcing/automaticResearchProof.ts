import {candidateInputSchema,type CandidateInput} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {canonicalWebsite,firmNameKey,websiteDomain,workspaceIndex} from '../crm/import.ts';
import {nativeFirmCitations,identityFold} from './nativeFirmEligibility.ts';
import {qualifyEmailCandidate} from '../outreach/selection.ts';
import {QUALIFICATION_POLICY_VERSION,QUALIFICATION_PROMPT_VERSION,type QualificationRunRow} from './qualificationStore.ts';
import {researchFingerprint} from './qualifiedResearchProof.ts';
import {automaticResearchNow,automaticResearchOwner,automaticResearchSourceSnapshot} from './automaticResearchAuthority.ts';
import {retainedCandidateOnly} from './retainedAcquisition.ts';
import {currentUSPreparedEmailFit} from './currentPreparedEmailFit.ts';
import {LEGACY_QUALIFICATION_PRODUCER,hasPreparedIdentity,effectivePreparedCandidate} from './preparedIdentity.ts';
import {preparedIdentityCurrentSource} from './preparedIdentityAuthority.ts';

/** Reuse the CRM alias index, but explicitly bind the sourcing owner, not a forged user scope. */
export async function automaticResearchIdentity(ctx:RepositoryContext,candidate:CandidateInput,owner:string):Promise<{firmId:string|null}|null>{
 const index=await workspaceIndex(ctx),domain=websiteDomain(candidate.website);
 const ids=[...new Set([...(index.byName.get(firmNameKey(candidate.firmName))??[]),...(domain===null?[]:index.byDomain.get(domain)??[])].map(f=>f.id))];
 if(ids.length>1)return null;if(!ids.length)return {firmId:null};
 const firm=(await ctx.db.query<{id:string;name:string;website:string|null;assigned_user_id:string|null;status:string;locality:string|null;region_code:string|null}>('SELECT id,name,website,assigned_user_id,status,locality,region_code FROM firms WHERE workspace_id=$1 AND id=$2',[ctx.scope.workspaceId,ids[0]])).rows[0];
 return firm&&firm.status==='active'&&firm.assigned_user_id===owner&&firm.name===candidate.firmName.trim().replaceAll(/\s+/gu,' ')&&firm.website===canonicalWebsite(candidate.website)&&identityFold(firm.locality??'')===identityFold(candidate.locality)&&firm.region_code===candidate.region?{firmId:firm.id}:null;
}
/** This snapshot never writes or calls a provider. Every caller rechecks after its waits. */
export async function automaticResearchProof(ctx:RepositoryContext,candidateId:string){
 if(await retainedCandidateOnly(ctx,candidateId))return null;
 const owner=await automaticResearchOwner(ctx);if(!owner)return null;
 const row=(await ctx.db.query<{id:string;revision:number;status:string;qualification_blocked:boolean;payload:unknown}>('SELECT id,revision,status,qualification_blocked,payload FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2',[ctx.scope.workspaceId,candidateId])).rows[0];
 if(!row||row.qualification_blocked||row.status==='dismissed')return null;
 const parsed=candidateInputSchema.safeParse(row.payload);if(!parsed.success)return null;
 const originalCandidate=parsed.data,snapshot=await automaticResearchSourceSnapshot(ctx,candidateId,row.revision,originalCandidate);if(!snapshot)return null;
 const {value:source,targetingVersion}=snapshot;
 const run=(await ctx.db.query<QualificationRunRow>('SELECT * FROM sourcing_qualification_runs WHERE workspace_id=$1 AND candidate_id=$2 ORDER BY requested_at DESC,id DESC LIMIT 1',[ctx.scope.workspaceId,candidateId])).rows[0];
 if(!run||run.candidate_revision!==row.revision||run.prompt_version!==QUALIFICATION_PROMPT_VERSION||run.policy_version!==QUALIFICATION_POLICY_VERSION||run.reason!==null||!['review','eligible','admitted'].includes(run.state))return null;
 const now=await automaticResearchNow(ctx),proofBearing=hasPreparedIdentity(run),producer=run['producer_version']===undefined?LEGACY_QUALIFICATION_PRODUCER:run['producer_version'];
 if(proofBearing&&!await preparedIdentityCurrentSource(ctx,candidateId,row.revision,originalCandidate))return null;
 const candidate=effectivePreparedCandidate(originalCandidate,run.facts,run.observations,producer,run['prepared_identity'],now);if(!candidate)return null;
 const native=nativeFirmCitations({candidate,facts:run.facts,observations:run.observations,now});if('status' in native)return null;
 const identity={status:'resolved' as const,name:candidate.firmName,website:candidate.website,locality:candidate.locality,region:candidate.region};
 const email=native.policyVersion==='native-firm-eligibility-us-v1'
  ?currentUSPreparedEmailFit({candidate,facts:run.facts,observations:run.observations,now},native)
  :(()=>{const legacy=qualifyEmailCandidate({identity,facts:run.facts,observations:run.observations,now});return {eligible:legacy.decision==='eligible',route:legacy.route};})();
 if(!email.eligible||!email.route)return null;
 const emailSource=run.observations.find(s=>s.id===email.route!.sourceObservationId);if(!emailSource)return null;
 const validUntil=new Date(Math.min(Date.parse(native.validUntil),Date.parse(emailSource.retrievedAt)+7*86400000)).toISOString();
 if(Date.parse(now)>=Date.parse(validUntil))return null;
 const citations=native.citations.map(c=>{const observation=run.observations.find(s=>s.id===c.observationId)!;return {...c,url:observation.url,contentHash:observation.contentHash,retrievedAt:observation.retrievedAt,quote:observation.blocks.find(b=>b.id===c.blockId)!.text};});
 const fingerprint=researchFingerprint({candidateId,candidateRevision:row.revision,runId:run.id,owner,candidate,source,policyVersion:run.policy_version,promptVersion:run.prompt_version,facts:run.facts,observations:run.observations,policy:'automatic-research-v1',...(proofBearing?{originalCandidate,producerVersion:producer,preparedIdentity:run['prepared_identity']}:{}),...(native.policyVersion==='native-firm-eligibility-us-v1'?{nativePolicyVersion:native.policyVersion}:{})});
 return {candidateId,candidateRevision:row.revision,candidate,runId:run.id,owner,source,targetingVersion,fingerprint,citations,validUntil,route:email.route,nativePolicyVersion:native.policyVersion};
}
