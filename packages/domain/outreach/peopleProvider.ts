import {parseEmailAddress} from '../crm/routeValidation.ts';
import {personFirstNameOf} from '../sequences/variables.ts';
import type {PreparedPageText} from '../sourcing/preparedEmailRead.ts';
import {CONSUMER_EMAIL_DOMAINS} from './consumerEmailDomains.ts';

/** ADR0036/0037. The seam a people source fills: given a company, find ONE named decision-maker and, when one is published or verified, their
 * personal email. `own_site` (ADR0037) reads the company's own retained pages and spends nothing; a people-data API (Apollo was the first
 * adapter; Hunter's domain-search `type=personal&decision_maker=true` is the intended next) answers over HTTP and spends credits. Adapters
 * never retry and never expose response bodies; the domain, not the adapter, decides whether an answer is acceptable (`acceptablePerson`)
 * and what it may spend. */
/** The source that reads a company's own retained pages (ADR0037): free, and read again when its person expires or the candidate changes. */
export const OWN_SITE_PROVIDER='own_site';
export type PeopleEmailStatus='verified'|'published'|'unverified'|'unavailable';
export type PeopleMatchConfidence='high'|'medium'|'low'|'none';
/** Where the company's own page published the person: the page, the block and the words (a citation, never a model's paraphrase). */
export interface PersonSource {observationId:string;url:string;blockId:string;quote:string}
export interface ProviderPerson {providerPersonId:string;firstName:string;lastName:string;title:string;email:string|null;emailStatus:PeopleEmailStatus;matchConfidence:PeopleMatchConfidence|null;source?:PersonSource}
/** A failure halts the pass. `mayHaveCharged` is true only when the paid call went out and no usable answer came back (timeout, transport,
 * invalid body): that company is never retried automatically. A refusal (bad key, no plan or quota, rate limit) and any failure of the
 * free search charged nothing, so the company is tried again after a short cool-down. */
export type PeopleLookup={ok:true;person:ProviderPerson|null;creditsUsed:number}|{ok:false;code:'auth_failed'|'quota_exhausted'|'rate_limited'|'unavailable'|'invalid_response';mayHaveCharged:boolean};
/** What a source may read about one company: its host and name, and the retained own-site page text of its prepared capture (a source that calls an HTTP API ignores the pages). */
export interface PeopleLookupInput {domain:string;companyName:string;candidateId:string;pages:readonly PreparedPageText[]}
export interface PeopleProvider {providerKey:string;/** The most credits one lookup can spend (0: free); the domain reserves exactly this before the call. */maxCreditsPerLookup:number;findDecisionMaker(input:PeopleLookupInput):Promise<PeopleLookup>}

/** Lower is better; null is never a decision-maker. Owner; then president, CEO, founder, principal; then the broker in charge; then a broker; then a property manager. */
const EXCLUDED_TITLE=/\b(?:assistant|asst\.?|associate|leasing|maintenance|accounting|accountant|bookkeep\w*|receptionist|coordinator|administrator|admin|marketing|intern|trainee|agent|inspector|technician|janitor|custodian|support|customer|sales|recruit\w*|payroll|clerk|secretary|vendor|tenants?|residents?|renters?|landlords?|investors?|clients?|home\s?owners?|property owners?)\b/iu;
const TITLE_RANKS:readonly (readonly [RegExp,number])[]=[
 [/\b(?:owner|co-?owner|proprietor)\b/iu,0],
 [/\b(?:president|founder|co-?founder|principal(?!\s+broker)|ceo|chief executive|managing partner|managing director|managing member)\b/iu,1],
 [/\b(?:managing broker|designated broker|broker of record|broker[- ]in[- ]charge|principal broker|qualifying broker)\b/iu,2],
 [/\b(?:broker|partner)\b/iu,3],
 [/\b(?:(?:director|head|vp|vice[- ]?president)(?:,|\s+of|\s+for)?\s+property management|property management\s+(?:director|vp|vice[- ]?president))\b/iu,4],
 [/\bproperty manager\b/iu,5],
];
/** A vice president is not "president": every rank but the property-management one reads the title without its vice-president words, so "Vice
 * President of Finance" matches nothing, "Owner and Vice President" is an owner, and only a VP of property management is a decision-maker. */
const VICE_PRESIDENT=/\b(?:vice[- ]?president|vp|svp|evp|avp)\b/giu,PROPERTY_MANAGEMENT_RANK=4;
export function rankDecisionMakerTitle(title:string):number|null{
 if(EXCLUDED_TITLE.test(title))return null;
 const withoutVice=title.replace(VICE_PRESIDENT,' '),ranks=TITLE_RANKS.filter(([pattern,rank])=>pattern.test(rank===PROPERTY_MANAGEMENT_RANK?title:withoutVice)).map(([,rank])=>rank);
 return ranks.length?Math.min(...ranks):null;
}

/** Mailboxes that are a role or a system, never a person: a named decision-maker is reached at a personal-name address. */
const ROLE_LOCAL_PARTS=new Set(['info','information','hello','hi','office','contact','contactus','management','manager','leasing','maintenance','support','admin','administrator','team','service','services','inquiries','inquiry','enquiries','properties','property','sales','billing','accounting','accounts','payroll','ap','ar','hr','careers','career','jobs','job','press','media','marketing','privacy','legal','abuse','postmaster','webmaster','mailer-daemon','noreply','no-reply','donotreply','do-not-reply','unsubscribe','reception','general','mail','email','rentals','rental','tenants','residents','owners','help','orders','booking','bookings','welcome','newsletter','staff','broker','realty','home','homes','ceo','coo','cfo','president','vp','owner','founder','principal','director','ownership']);
const hostOf=(value:string):string=>value.trim().toLowerCase().replace(/^https?:\/\//u,'').replace(/^www\./u,'').split(/[/?#]/u)[0]!;
/** A provider may return a name in one case ("JORDAN", "blake"): such a name is capitalized per word and hyphen or apostrophe part, so "Hi {first_name}" never shouts. Mixed case is the provider's and kept. */
const tidyName=(value:string):string=>{const name=value.trim();return name===name.toUpperCase()||name===name.toLowerCase()?name.toLowerCase().replace(/(^|[\s'’-])(\p{L})/gu,(_m,lead:string,letter:string)=>`${lead}${letter.toUpperCase()}`):name;};
/** A personal-name mailbox at the company's own host: well formed, not a consumer domain, not a role or system mailbox, and at exactly the host. Pure. */
export function personalAddressAtHost(address:string,companyHost:string):{ok:true;email:string}|{ok:false;reason:'invalid_email'|'role_address'|'consumer_domain'|'domain_mismatch'}{
 const parsed=parseEmailAddress(address.trim().toLowerCase());
 if(!parsed)return {ok:false,reason:'invalid_email'};
 if(CONSUMER_EMAIL_DOMAINS.has(parsed.domain))return {ok:false,reason:'consumer_domain'};
 if(ROLE_LOCAL_PARTS.has(parsed.localPart)||ROLE_LOCAL_PARTS.has(parsed.localPart.replace(/[._+-]+/gu,'')))return {ok:false,reason:'role_address'};
 if(parsed.domain!==hostOf(companyHost))return {ok:false,reason:'domain_mismatch'};
 return {ok:true,email:`${parsed.localPart}@${parsed.domain}`};
}
/** `verified`: a provider verified the address; `published`: the company's own page published it next to the person's name (ADR0037); `unavailable`: a named decision-maker, cited from the company's own page, with no usable address (kept for Calling, never emailed). */
export type AcceptedEmailStatus='verified'|'published'|'unavailable';
export interface AcceptedPerson {providerPersonId:string;firstName:string;lastName:string;title:string;email:string|null;emailStatus:AcceptedEmailStatus;confidence:Exclude<PeopleMatchConfidence,'low'|'none'>;source?:PersonSource}
export type PersonRefusal='no_person'|'unverified'|'low_confidence'|'no_name'|'title'|'invalid_email'|'role_address'|'consumer_domain'|'domain_mismatch';
/** The one acceptance rule: a medium or high match, a real first and last name (never an initial), a decision-maker title and, when there is
 * an address, a verified or own-page-published personal-name mailbox at the company's own host (never a role, consumer or other-domain
 * address). An `unavailable` person with no address is accepted without one only when the source cites the page it read (own site); a paid provider's answer with no address stays refused as `unverified`. Pure; refusals are recorded as a reason, never as the person. */
export function acceptablePerson(person:ProviderPerson|null,companyHost:string):{ok:true;person:AcceptedPerson}|{ok:false;reason:PersonRefusal}{
 if(!person)return {ok:false,reason:'no_person'};
 const withAddress=person.emailStatus==='verified'||person.emailStatus==='published';
 if(person.emailStatus==='unverified'||withAddress&&!person.email||person.emailStatus==='unavailable'&&(person.email||!person.source))return {ok:false,reason:'unverified'};
 if(person.matchConfidence!=='high'&&person.matchConfidence!=='medium')return {ok:false,reason:'low_confidence'};
 const [first,last]=[tidyName(person.firstName),tidyName(person.lastName)];
 if(personFirstNameOf(first)===null||!/^\p{L}[\p{L}'’.-]*$/u.test(first)||/^\p{L}\.?$/u.test(first)||first.length<2||first.length>100||!/^\p{L}[\p{L}'’ .-]*$/u.test(last)||last.length<2||last.length>100)return {ok:false,reason:'no_name'};
 if(person.title.trim().length>200||rankDecisionMakerTitle(person.title)===null)return {ok:false,reason:'title'};
 const accepted={providerPersonId:person.providerPersonId,firstName:first,lastName:last,title:person.title.trim(),confidence:person.matchConfidence,...person.source?{source:person.source}:{}};
 if(!person.email)return {ok:true,person:{...accepted,email:null,emailStatus:'unavailable'}};
 const address=personalAddressAtHost(person.email,companyHost);
 if(!address.ok)return address;
 return {ok:true,person:{...accepted,email:address.email,emailStatus:person.emailStatus as 'verified'|'published'}};
}
