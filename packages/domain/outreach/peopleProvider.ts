import {parseEmailAddress} from '../crm/routeValidation.ts';
import {personFirstNameOf} from '../sequences/variables.ts';
import {CONSUMER_EMAIL_DOMAINS} from './consumerEmailDomains.ts';

/** ADR0036. The seam a people-data provider fills: given a company's website host, find ONE named decision-maker and the provider's
 * verified personal email for them. Apollo is the first adapter (search is free, one enrichment costs at most one credit); Hunter's
 * domain-search `type=personal&decision_maker=true` is the intended second. Adapters never retry and never expose response bodies; the
 * domain, not the adapter, decides whether an answer is acceptable (`acceptablePerson`) and what it may spend. */
export type PeopleEmailStatus='verified'|'unverified'|'unavailable';
export type PeopleMatchConfidence='high'|'medium'|'low'|'none';
export interface ProviderPerson {providerPersonId:string;firstName:string;lastName:string;title:string;email:string|null;emailStatus:PeopleEmailStatus;matchConfidence:PeopleMatchConfidence|null}
/** A failure halts the pass. `mayHaveCharged` is true only when the paid call went out and no usable answer came back (timeout, transport,
 * invalid body): that company is never retried automatically. A refusal (bad key, no plan or quota, rate limit) and any failure of the
 * free search charged nothing, so the company is tried again after a short cool-down. */
export type PeopleLookup={ok:true;person:ProviderPerson|null;creditsUsed:number}|{ok:false;code:'auth_failed'|'quota_exhausted'|'rate_limited'|'unavailable'|'invalid_response';mayHaveCharged:boolean};
export interface PeopleProvider {providerKey:string;/** The most credits one lookup can spend; the domain reserves exactly this before the call. */maxCreditsPerLookup:number;findDecisionMaker(input:{domain:string;companyName:string}):Promise<PeopleLookup>}

/** Lower is better; null is never a decision-maker. Owners and principals first, then brokers in charge, then property managers. */
const EXCLUDED_TITLE=/\b(?:assistant|associate|leasing|maintenance|accounting|accountant|bookkeep\w*|receptionist|coordinator|administrator|admin|marketing|intern|trainee|agent|inspector|technician|janitor|custodian|support|customer|sales|recruit\w*|payroll|clerk|secretary|vendor)\b/iu;
const TITLE_RANKS:readonly (readonly [RegExp,number])[]=[
 [/\b(?:owner|co-?owner|founder|co-?founder|proprietor|president|principal|ceo|chief executive)\b/iu,0],
 [/\b(?:managing broker|designated broker|broker of record|broker[- ]owner|principal broker|managing partner|managing director|managing member)\b/iu,1],
 [/\b(?:(?:director|head|vp|vice[- ]?president)(?:,|\s+of|\s+for)?\s+property management|property management\s+(?:director|vp|vice[- ]?president))\b/iu,2],
 [/\bproperty manager\b/iu,3],
 [/\b(?:broker|partner)\b/iu,4],
];
/** A vice president is not "president": every rank but the property-management one reads the title without its vice-president words, so "Vice
 * President of Finance" matches nothing, "Owner and Vice President" is an owner, and only a VP of property management is a decision-maker. */
const VICE_PRESIDENT=/\b(?:vice[- ]?president|vp|svp|evp|avp)\b/giu,PROPERTY_MANAGEMENT_RANK=2;
export function rankDecisionMakerTitle(title:string):number|null{
 if(EXCLUDED_TITLE.test(title))return null;
 const withoutVice=title.replace(VICE_PRESIDENT,' ');
 return TITLE_RANKS.find(([pattern,rank])=>pattern.test(rank===PROPERTY_MANAGEMENT_RANK?title:withoutVice))?.[1]??null;
}
/** Title filter adapters send to a provider's search; the domain re-ranks the enriched title so a stale search title cannot admit an excluded one. */
export const DECISION_MAKER_TITLES:readonly string[]=['owner','founder','president','principal','ceo','managing broker','designated broker','broker of record','property manager','director of property management'];

/** Mailboxes that are a role or a system, never a person: a named decision-maker is reached at a personal-name address. */
const ROLE_LOCAL_PARTS=new Set(['info','information','hello','hi','office','contact','contactus','management','manager','leasing','maintenance','support','admin','administrator','team','service','services','inquiries','inquiry','enquiries','properties','property','sales','billing','accounting','accounts','payroll','ap','ar','hr','careers','career','jobs','job','press','media','marketing','privacy','legal','abuse','postmaster','webmaster','mailer-daemon','noreply','no-reply','donotreply','do-not-reply','unsubscribe','reception','general','mail','email','rentals','rental','tenants','residents','owners','help','orders','booking','bookings','welcome','newsletter','staff','broker','realty','home','homes']);
const hostOf=(value:string):string=>value.trim().toLowerCase().replace(/^https?:\/\//u,'').replace(/^www\./u,'').split(/[/?#]/u)[0]!;
/** A provider may return a name in one case ("JORDAN", "blake"): such a name is capitalized per word and hyphen or apostrophe part, so "Hi {first_name}" never shouts. Mixed case is the provider's and kept. */
const tidyName=(value:string):string=>{const name=value.trim();return name===name.toUpperCase()||name===name.toLowerCase()?name.toLowerCase().replace(/(^|[\s'’-])(\p{L})/gu,(_m,lead:string,letter:string)=>`${lead}${letter.toUpperCase()}`):name;};
export interface AcceptedPerson {providerPersonId:string;firstName:string;lastName:string;title:string;email:string;confidence:PeopleMatchConfidence}
export type PersonRefusal='no_person'|'unverified'|'low_confidence'|'no_name'|'title'|'invalid_email'|'role_address'|'consumer_domain'|'domain_mismatch';
/** The one acceptance rule: a verified provider email, a medium or high match, a real first and last name, a decision-maker title and a
 * personal-name mailbox at the company's own host (never a role, consumer or other-domain address). Pure; refusals are recorded as a reason, never as the person. */
export function acceptablePerson(person:ProviderPerson|null,companyHost:string):{ok:true;person:AcceptedPerson}|{ok:false;reason:PersonRefusal}{
 if(!person)return {ok:false,reason:'no_person'};
 if(person.emailStatus!=='verified'||!person.email)return {ok:false,reason:'unverified'};
 if(person.matchConfidence!=='high'&&person.matchConfidence!=='medium')return {ok:false,reason:'low_confidence'};
 const [first,last]=[tidyName(person.firstName),tidyName(person.lastName)];
 if(personFirstNameOf(first)===null||!/^\p{L}[\p{L}'’.-]*$/u.test(first)||first.length<2||first.length>100||!/^\p{L}[\p{L}'’ .-]*$/u.test(last)||last.length<2||last.length>100)return {ok:false,reason:'no_name'};
 if(person.title.trim().length>200||rankDecisionMakerTitle(person.title)===null)return {ok:false,reason:'title'};
 const parsed=parseEmailAddress(person.email.trim().toLowerCase());
 if(!parsed)return {ok:false,reason:'invalid_email'};
 if(CONSUMER_EMAIL_DOMAINS.has(parsed.domain))return {ok:false,reason:'consumer_domain'};
 if(ROLE_LOCAL_PARTS.has(parsed.localPart)||ROLE_LOCAL_PARTS.has(parsed.localPart.replace(/[._+-]+/gu,'')))return {ok:false,reason:'role_address'};
 if(parsed.domain!==hostOf(companyHost))return {ok:false,reason:'domain_mismatch'};
 return {ok:true,person:{providerPersonId:person.providerPersonId,firstName:first,lastName:last,title:person.title.trim(),email:`${parsed.localPart}@${parsed.domain}`.toLowerCase(),confidence:person.matchConfidence}};
}
