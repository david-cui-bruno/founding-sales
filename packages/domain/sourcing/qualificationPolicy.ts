import {qualificationEvidenceSchema,type QualificationFact,type SourceObservation,type QualificationVerdict} from '@fss/contracts';
import {canonicalizePhone} from '../src/rules/suppressionCanonicalization.ts';
import {QUALIFICATION_POLICY_VERSION} from './qualificationStore.ts';
export interface SourcingIdentity {status:'resolved'|'ambiguous'|'unknown';name:string;website:string;locality:string;region:string;existingFirmId?:string}
const fold=(s:string)=>s.normalize('NFKC').replace(/\s+/gu,' ').trim().toLowerCase();
const day=86400000;
const maintenance=/\b(?:maintenance|vendor|repair|tenant calls|after.hours)\b/iu;
const negated=/\b(?:not|no longer|never|don't|do not|doesn't|does not|without)\b/iu;
const noncurrent=/\b(?:if|unless|would|could|might|hypothetically|previously|formerly|historically|resolved|used to|no longer|last year|years ago|were|was)\b/iu;
const attribution=/\b(?:customer says|review|testimonial|residents?:|tenants?:|responsibilities:|duties:|we (?:offer|provide|help)|our clients|property managers who|you(?:'re| are))\b/iu;
const unmet=/\b(?:we|our team|our staff|our property managers)\b.{0,50}\b(?:need|seeking|looking for|struggling|overwhelmed|overloaded|backlog|spend too much|cannot keep up|can't keep up)\b/iu;
const help=/\b(?:we|our team|our staff)\b.{0,30}\b(?:need|seeking|looking for)\b.{0,60}\b(?:help|support|assistance|solution|provider|service)\b/iu;
const workload=/\b(?:our team|our staff|we|our property managers)\b.{0,60}\b(?:overwhelmed|overloaded|struggling|backlog|spend too much|cannot keep up|can't keep up)\b/iu;
const targetAreas:Record<string,readonly string[]>={RI:['providence','warwick','cranston','pawtucket','east providence','north providence','johnston'],MA:['boston','cambridge','somerville','quincy','brookline','newton','medford','malden','everett','revere','chelsea','waltham','watertown']};
const stateNames:Record<string,string>={TX:'texas',RI:'rhode island',MA:'massachusetts'};
export function supportedBusinessPhone(facts:readonly QualificationFact[],identity:SourcingIdentity):string|null {
 const numbers=new Set<string>();
 for(const fact of facts.filter(f=>f.kind==='business_phone')){
  const text=fold(fact.value);
  if(!text.includes(fold(identity.name))||/\b(?:website|web design|powered by|police|fire department|emergency services)\b/u.test(text))continue;
  for(const match of fact.value.matchAll(/(?:\+?1[ .-]?)?\(?[2-9]\d{2}\)?[ .-]?\d{3}[ .-]?\d{4}/gu)){
   const normalized=canonicalizePhone(match[0]);if(normalized.ok)numbers.add(normalized.handle.value);
  }
 }
 return numbers.size===1?[...numbers][0]!:null;
}
/** Narrow textual rules deliberately leave unfamiliar language in review. A selected quote is not proof of its interpretation. */
export function qualifyCandidate(input:{facts:readonly QualificationFact[];observations:readonly SourceObservation[];identity:SourcingIdentity;now:string}):QualificationVerdict {
 const reasons:string[]=[],unknowns:string[]=[],evidenceIds=new Set<string>();
 const result=(rank:QualificationVerdict['rank']='fit_only'):QualificationVerdict=>({decision:unknowns.length===0?'eligible':'review',rank,reasons,evidenceIds:[...evidenceIds],unknowns:[...new Set(unknowns)],policyVersion:QUALIFICATION_POLICY_VERSION});
 const validated=qualificationEvidenceSchema.safeParse({facts:input.facts,observations:input.observations});
 const now=Date.parse(input.now);
 if(!validated.success||!Number.isFinite(now)){unknowns.push('invalid_evidence');return result();}
 if(input.identity.status!=='resolved')unknowns.push('identity_unresolved');
 const byId=new Map(input.observations.map(o=>[o.id,o]));
 const sourceFor=(fact:QualificationFact)=>byId.get(fact.observationId)!;
 const current=input.facts.filter(fact=>{
  const source=sourceFor(fact),age=now-Date.parse(source.retrievedAt);
  if(age<0||age>7*day){unknowns.push('evidence_needs_refresh');return false;}
  let matchingHost=false;
  try{matchingHost=new URL(source.url).hostname.replace(/^www\./u,'')===new URL(input.identity.website).hostname.replace(/^www\./u,'');}catch{/* Unresolved site stays reviewable. */}
  return source.firstParty&&!source.truncated&&matchingHost;
 });
 if(current.length<input.facts.length)unknowns.push('source_incomplete_or_unverified');
 const any=(kind:QualificationFact['kind'],test:(text:string)=>boolean)=>current.some(f=>f.kind===kind&&test(fold(f.value)));
 if(!any('firm_identity',text=>text.includes(fold(input.identity.name))))unknowns.push('firm_identity_unsupported');
 if(!any('residential_management',text=>/\b(?:residential|single.family|homes|houses|apartments)\b/u.test(text)&&/\b(?:property manag|manage)/u.test(text)))unknowns.push('residential_fit_unknown');
 const region=input.identity.region.toUpperCase(),city=fold(input.identity.locality);
 const target=region==='TX'||targetAreas[region]?.includes(city)===true;
 if(!target||!any('service_area',text=>text.includes(city)&&(text.includes(stateNames[region]??'__unknown__')||new RegExp(`\\b${region.toLowerCase()}\\b`,'u').test(text))))unknowns.push('target_geography_unsupported');
 if(!supportedBusinessPhone(current,input.identity))unknowns.push('business_phone_unresolved');
 const credible=(fact:QualificationFact)=>{
  const text=fact.value;
  return maintenance.test(text)&&unmet.test(text)&&!noncurrent.test(text)&&!attribution.test(text)&&!negated.test(text);
 };
 const contradictions=current.some(f=>['help_request','operational_burden','existing_support'].includes(f.kind)&&maintenance.test(f.value)&&/\b(?:do not|don't|no longer) need|\bnot (?:overwhelmed|overloaded|struggling)\b/iu.test(f.value));
 if(contradictions)unknowns.push('need_evidence_conflicts');
 const helps=current.filter(f=>f.kind==='help_request'&&credible(f)&&help.test(f.value));
 const recentHelp=helps.filter(f=>{
  const date=sourceFor(f).publishedAt;
  if(date===null){unknowns.push('help_date_unknown');return false;}
  const age=now-Date.parse(date);
  if(age<0||age>30*day){unknowns.push('help_needs_revalidation');return false;}
  return true;
 });
 const burdens=current.filter(f=>{
  if(f.kind!=='operational_burden'||!credible(f)||!workload.test(f.value))return false;
  const date=sourceFor(f).publishedAt;if(date!==null&&(now-Date.parse(date)>90*day||now<Date.parse(date))){unknowns.push('event_needs_revalidation');return false;}return true;
 });
 if(recentHelp.length||burdens.length){
  for(const fact of [...recentHelp,...burdens])evidenceIds.add(fact.observationId);
  reasons.push(recentHelp.length?'explicit_maintenance_help':'explicit_maintenance_burden');
  return result(recentHelp.length?'help_request':'operational_burden');
 }
 unknowns.push('maintenance_need_unconfirmed');
 const investigation=current.some(f=>f.kind==='coordination_job'&&/\b(?:coordinator|coordination|dispatch)\b/iu.test(f.value)&&/\b(?:(?:we(?:'re| are)|now) hiring|job opening|open position|current opening|vacancy|apply (?:now|for))\b/iu.test(f.value)&&!negated.test(f.value)&&!noncurrent.test(f.value));
 for(const fact of current.filter(f=>f.kind==='growth'||f.kind==='coordination_job')){
  const source=sourceFor(fact);
  if(source.publishedAt===null)unknowns.push(fact.kind==='growth'?'growth_date_unknown':'job_date_unknown');
  else if(now-Date.parse(source.publishedAt)<0||now-Date.parse(source.publishedAt)>90*day)unknowns.push('event_needs_revalidation');
 }
 if(investigation)reasons.push('coordination_role_for_review');
 return result(investigation?'investigation':'fit_only');
}
export interface RankedQualifiedLead {id:string;firmName:string;rank:QualificationVerdict['rank'];corroboratingSources:number;observedAt:string;namedContact:boolean}
const ranks={help_request:0,operational_burden:1,investigation:2,fit_only:3};
export function rankQualifiedLeads(a:RankedQualifiedLead,b:RankedQualifiedLead):number {
 return ranks[a.rank]-ranks[b.rank]||Math.min(2,b.corroboratingSources)-Math.min(2,a.corroboratingSources)||Date.parse(b.observedAt)-Date.parse(a.observedAt)||Number(b.namedContact)-Number(a.namedContact)||a.firmName.localeCompare(b.firmName,'en')||a.id.localeCompare(b.id,'en');
}
export const NEUTRAL_MAINTENANCE_QUESTION='How does your team handle maintenance calls and vendor follow-up today?';
