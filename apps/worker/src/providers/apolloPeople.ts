import {z} from 'zod';
import {DECISION_MAKER_TITLES,rankDecisionMakerTitle,type PeopleLookup,type PeopleProvider,type ProviderPerson} from '@fss/domain/outreach/peopleProvider.ts';
import {boundedProviderRequest,type ProviderHttp} from './boundedHttp.ts';

const BASE='https://api.apollo.io/api/v1';
const text=(max:number)=>z.string().trim().min(1).max(max);
const searchSchema=z.object({people:z.array(z.object({id:text(64),title:text(200).nullable().optional(),has_email:z.boolean().optional()})).max(100)});
const matchSchema=z.object({person:z.object({
 id:text(64),first_name:text(100).nullable().optional(),last_name:text(100).nullable().optional(),title:text(200).nullable().optional(),
 email:text(320).nullable().optional(),email_status:text(40).nullable().optional(),match_confidence:text(20).nullable().optional(),
}).nullable().optional()});
const CONFIDENCE=new Set(['high','medium','low','none']);
/** Apollo's People Enrichment charge rule (docs.apollo.io/docs/api-pricing): one credit for demographics OR an email; no demographic credit when
 * `match_confidence` is `none`; a `low` match is charged only when it returns data we did not send. We send an id and a domain and ask for no phone,
 * waterfall or personal-email reveal, so the most one call costs is one credit. The charge follows the match, never the email: a high or medium
 * match without an email is still one credit. Conservative where the rule is not decidable: a missing or unrecognised confidence is charged, and
 * a `low` match is free only when it returned nothing beyond the id. */
function enrichmentCredits(found:{first_name?:string|null|undefined;last_name?:string|null|undefined;title?:string|null|undefined;email?:string|null|undefined},confidence:string|undefined):number{
 if(confidence==='none')return 0;
 if(confidence==='low')return found.first_name||found.last_name||found.title||found.email?1:0;
 return 1;
}
const refusal=(status:number):'auth_failed'|'quota_exhausted'|'rate_limited'|null=>status===401||status===403?'auth_failed':status===402?'quota_exhausted':status===429?'rate_limited':null;

/** ADR0036. Apollo people lookup: People API Search (0 credits, no emails) picks the best decision-maker title at the company's domain, then
 * ONE People Enrichment (`/people/match`, one credit for any matched person's demographics or email, none for no match, see `enrichmentCredits`) returns the name and
 * email. Fixed endpoints, query-string parameters as the docs show, header `x-api-key`; no retries, no waterfall, no phone or personal-email
 * reveal; response bodies, vendor errors and the key never leave this file. Whether the answer is acceptable is the domain's call. */
export function apolloPeople(apiKey:string,options:{http?:ProviderHttp}={}):PeopleProvider{
 const http=options.http??fetch;
 const call=async(path:string,query:URLSearchParams)=>boundedProviderRequest(http,`${BASE}${path}?${query.toString()}`,{method:'POST',headers:{'x-api-key':apiKey,'Content-Type':'application/json','Cache-Control':'no-cache'}},new AbortController().signal,15000);
 return {providerKey:'apollo',maxCreditsPerLookup:1,findDecisionMaker:async({domain}):Promise<PeopleLookup>=>{
  if(!apiKey.trim()||/[\r\n]/u.test(apiKey))return {ok:false,code:'auth_failed',mayHaveCharged:false};
  // A host that is not a public domain name is no company Apollo could know: nobody found, nothing asked, nothing spent.
  if(!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(domain))return {ok:true,person:null,creditsUsed:0};
  let id:string;
  try{
   const search=new URLSearchParams({include_similar_titles:'true',per_page:'25',page:'1'});
   search.append('q_organization_domains_list[]',domain);
   for(const title of DECISION_MAKER_TITLES)search.append('person_titles[]',title);
   const response=await call('/mixed_people/api_search',search);
   const refused=refusal(response.status);if(refused)return {ok:false,code:refused,mayHaveCharged:false};
   if(response.status<200||response.status>=300)return {ok:false,code:'unavailable',mayHaveCharged:false};
   const parsed=searchSchema.safeParse(response.body);if(!parsed.success)return {ok:false,code:'invalid_response',mayHaveCharged:false};
   // Search is free, so over-fetch and rank here: the best title first, Apollo's own order on a tie; only people Apollo says have an email.
   const ranked=parsed.data.people.flatMap((person,index)=>{const rank=person.has_email===true&&person.title?rankDecisionMakerTitle(person.title):null;return rank===null?[]:[{id:person.id,rank,index}];}).sort((a,b)=>a.rank-b.rank||a.index-b.index);
   if(!ranked[0])return {ok:true,person:null,creditsUsed:0};
   id=ranked[0].id;
  }catch{return {ok:false,code:'unavailable',mayHaveCharged:false};}
  try{
   const response=await call('/people/match',new URLSearchParams({id,domain}));
   const refused=refusal(response.status);if(refused)return {ok:false,code:refused,mayHaveCharged:false};
   if(response.status>=400&&response.status<500)return {ok:false,code:'unavailable',mayHaveCharged:false};
   if(response.status<200||response.status>=300)return {ok:false,code:'unavailable',mayHaveCharged:true};
   const parsed=matchSchema.safeParse(response.body);if(!parsed.success)return {ok:false,code:'invalid_response',mayHaveCharged:true};
   const found=parsed.data.person;
   if(!found)return {ok:true,person:null,creditsUsed:0};
   const email=found.email?.toLowerCase()??null,status=found.email_status?.toLowerCase(),confidence=found.match_confidence?.toLowerCase();
   const person:ProviderPerson={providerPersonId:found.id,firstName:found.first_name??'',lastName:found.last_name??'',title:found.title??'',email,
    emailStatus:email===null||/^email_not_unlocked@/u.test(email)||status==='unavailable'?'unavailable':status==='verified'?'verified':'unverified',
    matchConfidence:confidence&&CONFIDENCE.has(confidence)?confidence as ProviderPerson['matchConfidence']:null};
   return {ok:true,person,creditsUsed:enrichmentCredits(found,confidence)};
  }catch{return {ok:false,code:'unavailable',mayHaveCharged:true};}
 }};
}

/** The key is the only input: no account reference, no other secret. Absent or blank means no provider, so nothing is enriched. */
export function apolloPeopleFromEnvironment(environment:Readonly<Record<string,string|undefined>>):PeopleProvider|undefined{
 const key=environment['FSS_APOLLO_API_KEY'];
 return key?.trim()?apolloPeople(key.trim()):undefined;
}
