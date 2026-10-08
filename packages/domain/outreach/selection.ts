import {EMAIL_FIT_POLICY_VERSION} from './emailFitPolicy.ts';
export {EMAIL_FIT_POLICY_VERSION} from './emailFitPolicy.ts';
import {existingEmailRoute} from './existingEmail.ts';
import {officeContactContext} from './contactContext.ts';
import {decideAdminOnly} from '../crm/authorization.ts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {databaseNow} from '../policy/clock.ts';
import {candidateIdentity} from '../sourcing/qualificationDecision.ts';
import {qualifyCandidate,supportedBusinessPhone} from '../sourcing/qualificationPolicy.ts';
import type {QualificationRunRow} from '../sourcing/qualificationStore.ts';
import {firmNameKey,websiteDomain} from '../crm/import.ts';
import {firstSuppressed} from '../suppression/effective.ts';
import {qualificationEvidenceSchema,type CandidateInput,type QualificationFact,type SourceObservation} from '@fss/contracts';
import type {SourcingIdentity} from '../sourcing/qualificationPolicy.ts';
export interface EmailEvidenceRoute {address:string;sourceObservationId:string;blockId:string;identityKind:'named'|'role';displayName:string}
const fold=(s:string)=>s.normalize('NFKC').replace(/\s+/gu,' ').trim().toLowerCase();
const host=(s:string)=>{try{return new URL(s).hostname.toLowerCase().replace(/^www\./u,'');}catch{return '';}};
const consumer=new Set(['gmail.com','googlemail.com','yahoo.com','outlook.com','hotmail.com','icloud.com','aol.com','proton.me','protonmail.com','live.com']);
/** An explicit first-party address, associated with this office; never an inferred naming pattern. */
export function supportedBusinessEmail(input:{facts:readonly QualificationFact[];observations:readonly SourceObservation[];identity:SourcingIdentity;now:string}):EmailEvidenceRoute|null{
 if(input.identity.status!=='resolved'||!qualificationEvidenceSchema.safeParse({facts:input.facts,observations:input.observations}).success)return null;
 const now=Date.parse(input.now),domain=host(input.identity.website);if(!domain||!Number.isFinite(now))return null;
 const routes=new Map<string,EmailEvidenceRoute>();
 for(const f of input.facts.filter(v=>v.kind==='business_email')){
  const source=input.observations.find(s=>s.id===f.observationId);if(!source||!source.firstParty||source.truncated||host(source.url)!==domain)continue;
  const age=now-Date.parse(source.retrievedAt);if(age<0||age>7*86400000)continue;
  let evidenceText=f.value,officeCard=false;
  const associated=(text:string)=>text.includes(fold(input.identity.name))&&text.includes(fold(input.identity.locality))&&new RegExp(`\\b${input.identity.region.toLowerCase()}\\b`,'u').test(text);
  if(!associated(fold(evidenceText))){
   const context=officeContactContext(source,f,input.identity);if(!context)continue;
   evidenceText=context;officeCard=true;
  }
  const text=fold(evidenceText);
  if(/\b(?:suggested|guess|example address|referral|vendor|web designer|powered by|on behalf of|try emailing)\b/u.test(text))continue;
  const addresses=[...f.value.matchAll(/\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu)].map(m=>m[0].toLowerCase());
  if(addresses.length!==1)continue;const address=addresses[0]!;const [local,emailDomain]=address.split('@');
  if(!emailDomain||consumer.has(emailDomain)||emailDomain!==domain)continue;
  // A published office card establishes a company contact, never a person's name.
  const role=officeCard||/^(?:info|hello|office|contact|management|leasing|maintenance|support|admin|team)$/u.test(local??'');
  const person=/\bcontact\s+([A-Z][a-z]+(?:[-'][A-Z]?[a-z]+)?\s+[A-Z][a-z]+(?:[-'][A-Z]?[a-z]+)?)\s+(?:at|email:?)/u.exec(f.value)?.[1];
  if(!role&&(!person||evidenceText!==f.value))continue;
  routes.set(address,{address,sourceObservationId:source.id,blockId:f.blockId,identityKind:role?'role':'named',displayName:role?'Office':person!});
 }
 return routes.size===1?[...routes.values()][0]!:null;
}

/** This email policy is evaluated separately from the call-first policy. An
 * email-fit pass establishes contact eligibility, never an unmet maintenance need.
 */
export function qualifyEmailCandidate(input: Parameters<typeof qualifyCandidate>[0]) {
 const phoneVerdict=qualifyCandidate(input);
 const optional=new Set(['business_phone_unresolved','maintenance_need_unconfirmed','help_date_unknown','help_needs_revalidation','job_date_unknown','growth_date_unknown','event_needs_revalidation']);
 const unknowns=phoneVerdict.unknowns.filter(reason=>!optional.has(reason));
 const route=supportedBusinessEmail(input);
 if(!route)unknowns.push('business_email_unresolved');
 const uncertainRanking=phoneVerdict.unknowns.some(reason=>optional.has(reason)&&reason!=='business_phone_unresolved'&&reason!=='maintenance_need_unconfirmed');
 return {
  ...phoneVerdict,
  decision: unknowns.length===0?'eligible' as const:'review' as const,
  rank: uncertainRanking?'fit_only' as const:phoneVerdict.rank,
  reasons: uncertainRanking?[]:phoneVerdict.reasons,
  unknowns,
  policyVersion: EMAIL_FIT_POLICY_VERSION,
  route,
 };
}

// Database assessment is repeated inside admission/plan creation under the shared
// send/identity locks. It does not itself create a prospect or authorize contact.

export interface EmailAssessment {firmId:string|null;route:EmailEvidenceRoute;lane:'call_first'|'email_first';rank:'help_request'|'operational_burden'|'investigation'|'fit_only';emailRank:'help_request'|'operational_burden'|'investigation'|'fit_only';reviewRequired:boolean;verifiedFit:boolean}
export async function assessEmailCandidate(ctx:RepositoryContext,input:{candidateId:string;qualificationRunId:string}):Promise<{ok:true;value:EmailAssessment}|{ok:false;reason:string}>{
 if(!decideAdminOnly(ctx).permitted)return {ok:false,reason:'admin_required'};
 const w=ctx.scope.workspaceId;
 const candidate=(await ctx.db.query<{payload:CandidateInput;revision:number;status:string;qualification_blocked:boolean}>('SELECT payload,revision,status,qualification_blocked FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2',[w,input.candidateId])).rows[0];
 const run=(await ctx.db.query<QualificationRunRow>('SELECT * FROM sourcing_qualification_runs WHERE workspace_id=$1 AND id=$2 AND candidate_id=$3',[w,input.qualificationRunId,input.candidateId])).rows[0];
 if(!candidate||!run)return {ok:false,reason:'not_found'};
 if(candidate.qualification_blocked||candidate.status==='dismissed'||candidate.revision!==run.candidate_revision)return {ok:false,reason:'candidate_changed'};
 if(!['eligible','review','admitted'].includes(run.state)||run.reason)return {ok:false,reason:'evidence_unavailable'};
 const identity=candidateIdentity(candidate.payload,run.facts,run.observations),now=await databaseNow(ctx);
 const verdict=qualifyCandidate({identity,facts:run.facts,observations:run.observations,now});
 const emailVerdict=qualifyEmailCandidate({identity,facts:run.facts,observations:run.observations,now});
 if(emailVerdict.unknowns.includes('need_evidence_conflicts'))return {ok:false,reason:'need_evidence_conflicts'};
 const reviewable=new Set(['business_phone_unresolved','maintenance_need_unconfirmed','help_date_unknown','help_needs_revalidation','need_evidence_conflicts','job_date_unknown','growth_date_unknown','event_needs_revalidation']);
 const invalid=verdict.unknowns.find(r=>!reviewable.has(r));if(invalid)return {ok:false,reason:invalid};
 const route=supportedBusinessEmail({identity,facts:run.facts,observations:run.observations,now});if(!route)return {ok:false,reason:'business_email_unresolved'};
 const domain=websiteDomain(candidate.payload.website),name=firmNameKey(candidate.payload.firmName);
 const matches=(await ctx.db.query<{id:string;name:string;website:string|null;locality:string|null;region_code:string|null;status:string;assigned_user_id:string|null}>(`SELECT id,name,website,locality,region_code,status,assigned_user_id FROM firms WHERE workspace_id=$1 AND (lower(regexp_replace(trim(name),'\\s+',' ','g'))=$2 OR regexp_replace(lower(split_part(website,'/',3)),'^www\\.','')=$3)`,[w,name,domain])).rows;
 const exact=matches.filter(f=>firmNameKey(f.name)===name&&fold(f.locality??'')===fold(candidate.payload.locality)&&f.region_code===candidate.payload.region&&websiteDomain(f.website)===domain);
 if(exact.length>1||(exact.length===0&&matches.length>0))return {ok:false,reason:'firm_identity_ambiguous'};
 const firm=exact[0];if(firm?.status==='merged')return {ok:false,reason:'firm_merged'};
 if(ctx.scope.actor.kind==='user'&&firm&&firm.assigned_user_id!==ctx.scope.actor.userId)return {ok:false,reason:'firm_assigned_elsewhere'};
 if(await firstSuppressed(ctx,[{scope:'handle',canonicalKey:route.address},...(firm?[{scope:'firm' as const,canonicalKey:firm.id}]:[])],'email'))return {ok:false,reason:'email_or_firm_stopped'};
 if(firm&&(await ctx.db.query('SELECT id FROM sequence_enrollments WHERE workspace_id=$1 AND firm_id=$2 AND ended_at IS NULL LIMIT 1',[w,firm.id])).rows.length)return {ok:false,reason:'firm_already_enrolled'};
 if((await ctx.db.query(`SELECT id FROM email_addresses WHERE workspace_id=$1 AND address=$2 AND firm_id<>COALESCE($3::uuid,'00000000-0000-0000-0000-000000000000') AND retired_at IS NULL`,[w,route.address,firm?.id??null])).rows.length)return {ok:false,reason:'email_association_ambiguous'};
 const existing=firm?await existingEmailRoute(ctx,firm.id,route.address,input):{ok:true as const,value:null};
 if(!existing.ok)return existing;
 const phone=supportedBusinessPhone(run.facts,identity);
 return {ok:true,value:{firmId:firm?.id??null,route,verifiedFit:emailVerdict.decision==='eligible',lane:phone&&['help_request','operational_burden'].includes(verdict.rank)?'call_first':'email_first',rank:verdict.rank,emailRank:emailVerdict.rank,reviewRequired:(existing.value!==null&&!existing.value.attributed)||verdict.unknowns.some(r=>r!=='business_phone_unresolved')}};
}
