import {hasPreparedIdentity} from './preparedIdentity.ts';
import {qualificationEvidenceSchema,nativeFirmEligibilitySchema,type NativeFirmEligibility,type QualificationFact,type SourceObservation} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {databaseNow} from '../policy/clock.ts';
import {qualificationCitationRoles,type QualificationCandidateContext} from './qualificationCitationRoles.ts';
import {deniesManagedResidences,supportsResidentialManagement,type SourcingIdentity} from './qualificationPolicy.ts';
import {isDiscoveryDirectory} from './discoveryIdentity.ts';
import {readCurrentDiscoveryResearchFirm} from './discoveryResearchFirm.ts';
import type {QualificationRunRow} from './qualificationStore.ts';
import {QUALIFICATION_POLICY_VERSION,QUALIFICATION_PROMPT_VERSION} from './qualificationVersions.ts';
import type {NativeFirmPolicyVersion} from '../../contracts/src/usBusinessGeography.ts';
import {supportsScopedServiceArea as serviceArea} from './scopedServiceArea.ts';
import {currentNativeFirmPolicy,supportsCurrentUSServiceLocation} from './currentUSBusinessGeography.ts';

export const identityFold=(value:string):string=>value.normalize('NFKC').replace(/\s+/gu,' ').trim().toLowerCase();
/** Branch paths and only known non-identity tracking queries are supported. */
export function verifiedWebsiteKey(value:string|null):string|null {
 try{const url=new URL(value??'');const trackingOnly=[...url.searchParams.keys()].every(key=>/^(?:utm_(?:source|medium|campaign|term|content|id)|gclid|fbclid)$/u.test(key));return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&trackingOnly?`${url.hostname.toLowerCase().replace(/^www\./u,'')}${url.pathname.replace(/\/+$/u,'')}`:null;}catch{return null;}
}
const sourceHost=(value:string)=>{try{return verifiedWebsiteKey(value)===null?null:new URL(value).hostname.toLowerCase().replace(/^www\./u,'');}catch{return null;}};
const stateNames:Record<string,string>={TX:'texas',RI:'rhode island',MA:'massachusetts'};
function deniesResidential(text:string):boolean {
 return deniesManagedResidences(text)||/\b(?:do\s+not|does\s+not|don['’]t|doesn['’]t|never|no\s+longer)\s+(?:\w+\s+){0,3}(?:manage|offer|provide|handle|speciali[sz]e)\b[^.!?\n]{0,100}\bresidential\b/iu.test(text)
  || /\b(?:commercial|industrial)\b[^.!?\n]{0,80}\b(?:only|exclusively)\b|\b(?:only|exclusively)\b[^.!?\n]{0,80}\b(?:commercial|industrial)\b/iu.test(text);
}
export type NativeEvidenceInput={candidate:QualificationCandidateContext;facts:readonly QualificationFact[];observations:readonly SourceObservation[];now:string};
type Core={kind:'verified';identity:SourcingIdentity}|{kind:'pending'|'unclear';reason:string};
/** Behavior-identical pre-phone portion of verified-firm-v3. No channel authority. */
function nativeFirmEvidenceCore(input:NativeEvidenceInput,currentUS:boolean):Core {
 const {candidate}=input,now=Date.parse(input.now),host=sourceHost(candidate.website);
 if(!Number.isFinite(now)||!host||!qualificationEvidenceSchema.safeParse({facts:input.facts,observations:input.observations}).success)return {kind:'pending',reason:'invalid_evidence'};
 if(isDiscoveryDirectory(candidate.website))return {kind:'unclear',reason:'identity_unresolved'};
 const sources=new Map(input.observations.filter(s=>s.firstParty&&!s.truncated&&sourceHost(s.url)===host&&now>=Date.parse(s.retrievedAt)&&now-Date.parse(s.retrievedAt)<=7*86400000).map(s=>[s.id,s]));
 if(sources.size===0)return {kind:'pending',reason:'source_incomplete_or_unverified'};
 const facts=input.facts.filter(f=>sources.has(f.observationId));
 const name=identityFold(candidate.firmName),identities=facts.filter(f=>f.kind==='firm_identity');
 const matches=(value:string,part:string)=>` ${identityFold(value).replace(/[^\p{L}\p{N}]+/gu,' ')} `.includes(` ${identityFold(part).replace(/[^\p{L}\p{N}]+/gu,' ')} `);
 if(name.length<4||/^(?:property management|property manager|rentals|home|contact|about us)$/u.test(name)||identities.length===0)return {kind:'unclear',reason:'identity_unresolved'};
 if(identities.some(f=>!matches(f.value,name)||/\b(?:powered by|website by|web design|testimonial|customer review)\b/iu.test(f.value)))return {kind:'unclear',reason:'firm_identity_ambiguous'};
 const state=stateNames[candidate.region];
 const geography=facts.some(f=>f.kind==='service_area'&&(currentUS?supportsCurrentUSServiceLocation(f.value,candidate.region,candidate.locality)
  :matches(f.value,candidate.locality)&&(matches(f.value,candidate.region)||matches(f.value,state??'__unknown__'))));
 if(!geography)return {kind:'unclear',reason:'identity_unresolved'};
 if([...sources.values()].some(source=>source.blocks.some(block=>deniesResidential(block.text)))||!facts.some(f=>f.kind==='residential_management'&&supportsResidentialManagement(f.value)))return {kind:'pending',reason:'residential_fit_unknown'};
 return {kind:'verified',identity:{status:'resolved',name:candidate.firmName,website:candidate.website,locality:candidate.locality,region:candidate.region}};
}
/** Frozen default used by strict verified/calling wrappers. */
export function nativeFirmEvidence(input:NativeEvidenceInput):Core {return nativeFirmEvidenceCore(input,false);}
const literal=(value:string,part:string)=>` ${identityFold(value).replace(/[^\p{L}\p{N}]+/gu,' ')} `.includes(` ${identityFold(part).replace(/[^\p{L}\p{N}]+/gu,' ')} `);
function contradictsServiceArea(value:string,candidate:QualificationCandidateContext):boolean {
 return value.split(/[.!?\n]+/u).some(sentence=>literal(sentence,candidate.locality)
  &&(literal(sentence,candidate.firmName)||/\b(?:we|our|us)\b/iu.test(sentence))
  &&(/\b(?:do\s+not|does\s+not|don['’]t|doesn['’]t|never|no\s+longer|not\s+currently|cannot|can['’]t|ceased|stopped)\b[^.!?\n]{0,120}\b(?:serv\w*|manag\w*|operat\w*|cover\w*|offer\w*|provid\w*)\b/iu.test(sentence)
   ||/\b(?:not|no\s+longer)\b[^.!?\n]{0,80}\b(?:available|offered|provided|supported|served|covered)\b/iu.test(sentence)
   ||/\b(?:outside|excluded\s+from|not\s+(?:in|within|part\s+of))\b[^.!?\n]{0,80}\b(?:service|coverage|operating)\s+area\b/iu.test(sentence)
   ||/\b(?:withdrawn|discontinued|ended|ceased|stopped)\b[^.!?\n]{0,80}\b(?:service|operations|coverage)\b/iu.test(sentence)));
}

const unavailable=(reason:Extract<NativeFirmEligibility,{status:'unavailable'}>['reason']):NativeFirmEligibility=>({status:'unavailable',reason,channelAuthority:'not_granted'});
/** Extra read-adapter defenses are intentionally NOT injected into the calling wrapper. */
export function nativeFirmCitations(input:NativeEvidenceInput):{citations:Extract<NativeFirmEligibility,{status:'verified'}>['citations'];validUntil:string;policyVersion:NativeFirmPolicyVersion}|NativeFirmEligibility {
 if(!qualificationEvidenceSchema.safeParse({facts:input.facts,observations:input.observations}).success)return unavailable('evidence_invalid');
 const roles=qualificationCitationRoles(input.candidate,input.facts,input.observations);
 if(!roles.ok)return unavailable('evidence_invalid');
 const policyVersion=currentNativeFirmPolicy(input.candidate.region,input.candidate.locality);
 if(!policyVersion)return unavailable('geography_unsupported');
 const currentUS=policyVersion==='native-firm-eligibility-us-v1';
 if(currentUS&&!input.facts.some(f=>f.kind==='service_area'&&supportsCurrentUSServiceLocation(f.value,input.candidate.region,input.candidate.locality)))return unavailable('geography_unsupported');
 const core=currentUS?nativeFirmEvidenceCore(input,true):nativeFirmEvidence(input);
 if(core.kind!=='verified')return unavailable(core.reason==='residential_fit_unknown'?'residential_fit_unresolved':core.reason==='firm_identity_ambiguous'?'identity_ambiguous':core.reason==='source_incomplete_or_unverified'?'evidence_expired':'identity_unresolved');
 const now=Date.parse(input.now),host=sourceHost(input.candidate.website);
 const usable=input.observations.filter(s=>s.firstParty&&!s.truncated&&sourceHost(s.url)===host&&now>=Date.parse(s.retrievedAt)&&now-Date.parse(s.retrievedAt)<7*86400000);
 if(usable.some(source=>source.blocks.some(block=>contradictsServiceArea(block.text,input.candidate))))return unavailable('service_area_unresolved');
 // Use only retained facts, not role validator's optional supplements.
 const selected=input.facts.filter(f=>['firm_identity','service_area','residential_management'].includes(f.kind)&&usable.some(s=>s.id===f.observationId));
 const citations:Extract<NativeFirmEligibility,{status:'verified'}>['citations']=[];
 for(const kind of ['firm_identity','service_area','residential_management'] as const){
  const fact=selected.find(f=>f.kind===kind&&(kind!=='residential_management'||supportsResidentialManagement(f.value))&&(kind!=='service_area'||serviceArea(f.value,input.candidate,currentUS)));
  if(!fact)return unavailable(kind==='service_area'?'service_area_unresolved':kind==='firm_identity'?'identity_unresolved':'residential_fit_unresolved');
  citations.push({kind,observationId:fact.observationId,blockId:fact.blockId});
 }
 const validUntil=new Date(Math.min(...citations.map(c=>Date.parse(usable.find(s=>s.id===c.observationId)!.retrievedAt)+7*86400000))).toISOString();
 return {citations,validUntil,policyVersion};
}

/** Current read only. Never enqueues, writes, selects by name, or grants a channel. */
export async function readNativeFirmEligibility(ctx:RepositoryContext,firmId:string):Promise<NativeFirmEligibility> {
 const lineage=await readCurrentDiscoveryResearchFirm(ctx,{firmId});
 if(!lineage)return unavailable('lineage_changed');
 const {candidate,firm}=lineage;
 if((firm.locality!==null&&identityFold(firm.locality)!==identityFold(candidate.payload.locality))||(firm.region_code!==null&&firm.region_code!==candidate.payload.region))return unavailable('lineage_changed');
 if(candidate.qualification_blocked)return unavailable('identity_unresolved');
 const run=(await ctx.db.query<QualificationRunRow>('SELECT * FROM sourcing_qualification_runs WHERE workspace_id=$1 AND candidate_id=$2 ORDER BY requested_at DESC,id DESC LIMIT 1',[ctx.scope.workspaceId,candidate.id])).rows[0];
 if(!run)return {status:'pending',reason:'evidence_pending',channelAuthority:'not_granted'};
 if(hasPreparedIdentity(run))return unavailable('latest_run_unavailable');
 if(run.candidate_revision!==candidate.revision||run.prompt_version!==QUALIFICATION_PROMPT_VERSION||run.policy_version!==QUALIFICATION_POLICY_VERSION)return unavailable('latest_run_unavailable');
 if(['pending','running'].includes(run.state))return {status:'pending',reason:'latest_run_pending',channelAuthority:'not_granted'};
 if(run.reason!==null||!['review','eligible','admitted'].includes(run.state))return unavailable('latest_run_unavailable');
 const now=await databaseNow(ctx),proof=nativeFirmCitations({candidate:candidate.payload,facts:run.facts,observations:run.observations,now});
 if('status' in proof)return proof;
 // Recheck all current owner/source/candidate and latest-run bindings at response boundary.
 const current=await readCurrentDiscoveryResearchFirm(ctx,{firmId});
 const latest=(await ctx.db.query<QualificationRunRow>('SELECT * FROM sourcing_qualification_runs WHERE workspace_id=$1 AND candidate_id=$2 ORDER BY requested_at DESC,id DESC LIMIT 1',[ctx.scope.workspaceId,candidate.id])).rows[0];
 if(!current||JSON.stringify(current)!==JSON.stringify(lineage)||JSON.stringify(latest)!==JSON.stringify(run))return unavailable('lineage_changed');
 const checkedAt=await databaseNow(ctx);if(Date.parse(checkedAt)>=Date.parse(proof.validUntil))return unavailable('evidence_expired');
 return nativeFirmEligibilitySchema.parse({status:'verified',policyVersion:proof.policyVersion,promotionId:lineage.promotionId,discoveryCandidateId:lineage.discoveryCandidateId,discoveryRevision:lineage.discoveryRevision,candidateId:candidate.id,candidateRevision:candidate.revision,runId:run.id,firmId,ownerUserId:firm.assigned_user_id,checkedAt,validUntil:proof.validUntil,citations:proof.citations,channelAuthority:'not_granted'});
}
