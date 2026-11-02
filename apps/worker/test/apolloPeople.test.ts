import {it,expect,vi,type Mock} from 'vitest';
import type {ProviderHttp} from '../src/providers/boundedHttp.ts';
import {apolloPeople,apolloPeopleFromEnvironment} from '../src/providers/apolloPeople.ts';
const found={id:'p-2',first_name:'Jordan',last_name:'Blake',title:'Owner',email:'Jordan.Blake@cobalt.example',email_status:'verified',match_confidence:'high'};
const search=(...people:{id:string;title:string|null;has_email?:boolean}[])=>new Response(JSON.stringify({people:people.map(person=>({has_email:true,...person})),total_entries:people.length}));
const match=(person:unknown)=>new Response(JSON.stringify({person}));
const sequence=(...responses:Response[]):Mock<ProviderHttp>=>vi.fn<ProviderHttp>(async()=>responses.shift()!);
const ask=(http:Mock<ProviderHttp>)=>apolloPeople('fixture-key',{http}).findDecisionMaker({domain:'cobalt.example',companyName:'Cobalt'});
const call=(http:Mock<ProviderHttp>,index:number)=>{const [url,init]=http.mock.calls[index] as unknown as [string,RequestInit];return {url:new URL(url),init};};

it('searches for free, enriches the best title once by id and domain, and reports one credit for the returned email',async()=>{
 const http=sequence(search({id:'p-1',title:'Property Manager'},{id:'p-2',title:'Founder & CEO'},{id:'p-3',title:'Leasing Agent'}),match(found));
 const result=await ask(http);
 expect(http).toHaveBeenCalledTimes(2);
 const [first,second]=[call(http,0),call(http,1)];
 expect(first.url.origin+first.url.pathname).toBe('https://api.apollo.io/api/v1/mixed_people/api_search');
 expect(first.url.searchParams.getAll('q_organization_domains_list[]')).toEqual(['cobalt.example']);
 expect(first.url.searchParams.getAll('person_titles[]')).toEqual(expect.arrayContaining(['owner','managing broker','property manager']));
 expect(first.url.searchParams.get('per_page')).toBe('25');
 expect(second.url.origin+second.url.pathname).toBe('https://api.apollo.io/api/v1/people/match');
 expect(Object.fromEntries(second.url.searchParams)).toEqual({id:'p-2',domain:'cobalt.example'});
 for(const {init} of [first,second])expect(init).toMatchObject({method:'POST',redirect:'error',headers:{'x-api-key':'fixture-key'}});
 expect(result).toEqual({ok:true,creditsUsed:1,person:{providerPersonId:'p-2',firstName:'Jordan',lastName:'Blake',title:'Owner',email:'jordan.blake@cobalt.example',emailStatus:'verified',matchConfidence:'high'}});
});
it('ranks owners above brokers above property managers, skips excluded titles and people without an email, and keeps Apollo order on a tie',async()=>{
 const http=sequence(search({id:'a',title:'Assistant Property Manager'},{id:'b',title:'Property Manager'},{id:'c',title:'Designated Broker'},{id:'d',title:'President',has_email:false},{id:'e',title:'Managing Broker'},{id:'f',title:'Maintenance Supervisor'}),match(found));
 await ask(http);
 expect(call(http,1).url.searchParams.get('id')).toBe('c');
});
it('costs nothing when no title qualifies, nobody has an email, or nobody matches',async()=>{
 const noTitle=sequence(search({id:'a',title:'Leasing Agent'},{id:'b',title:null}));
 expect(await ask(noTitle)).toEqual({ok:true,person:null,creditsUsed:0});expect(noTitle).toHaveBeenCalledTimes(1);
 const noEmail=sequence(search({id:'a',title:'Owner',has_email:false}));
 expect(await ask(noEmail)).toEqual({ok:true,person:null,creditsUsed:0});
 const noMatch=sequence(search({id:'a',title:'Owner'}),match(null));
 expect(await ask(noMatch)).toEqual({ok:true,person:null,creditsUsed:0});
});
it.each([['verified','verified'],['unverified','unverified'],['likely to engage','unverified'],['unavailable','unavailable']])('maps Apollo email status %s to %s and never calls a non-verified answer verified',async(apollo,ours)=>{
 const result=await ask(sequence(search({id:'p-2',title:'Owner'}),match({...found,email_status:apollo})));
 expect(result).toMatchObject({ok:true,creditsUsed:1,person:{emailStatus:ours}});
});
it('reports an unavailable person for a missing or locked email, and still charges the matched person',async()=>{
 expect(await ask(sequence(search({id:'p-2',title:'Owner'}),match({...found,email:null,email_status:null})))).toMatchObject({ok:true,creditsUsed:1,person:{email:null,emailStatus:'unavailable'}});
 expect(await ask(sequence(search({id:'p-2',title:'Owner'}),match({...found,email:'email_not_unlocked@cobalt.example',email_status:'verified'})))).toMatchObject({ok:true,creditsUsed:1,person:{emailStatus:'unavailable'}});
});
// Apollo's rule (docs.apollo.io/docs/api-pricing): one credit for demographics OR email; none when match_confidence is none; low only if it returns data we did not send.
it.each([
 ['a high match with an email',found,1],
 ['a high match with demographics and no email',{...found,email:null,email_status:null},1],
 ['a medium match with demographics and no email',{...found,email:null,email_status:null,match_confidence:'medium'},1],
 ['a low match that returns data we did not send',{...found,email:null,email_status:null,match_confidence:'low'},1],
 ['a low match that returns an email',{...found,first_name:null,last_name:null,title:null,match_confidence:'low'},1],
 ['a match with no confidence field (undecidable, charged)',{...found,email:null,email_status:null,match_confidence:null},1],
 ['an unrecognised confidence (charged)',{...found,email:null,email_status:null,match_confidence:'certain'},1],
 ['a none match, even with fields present',{...found,email:null,email_status:null,match_confidence:'none'},0],
 ['a low match that returns nothing beyond the id',{id:'p-2',match_confidence:'low'},0],
] as const)('charges %s by the match outcome, not the email: %i credit(s)',async(_label,person,credits)=>{
 expect(await ask(sequence(search({id:'p-2',title:'Owner'}),match(person)))).toMatchObject({ok:true,creditsUsed:credits});
});
it.each([[401,'auth_failed'],[403,'auth_failed'],[402,'quota_exhausted'],[429,'rate_limited']] as const)('maps HTTP %s to %s on search and on enrichment without retrying or paying',async(status,code)=>{
 const onSearch=vi.fn(async()=>new Response('DO-NOT-RETAIN-ERROR',{status}));
 expect(await ask(onSearch)).toEqual({ok:false,code,mayHaveCharged:false});expect(onSearch).toHaveBeenCalledTimes(1);
 const onMatch=sequence(search({id:'p-2',title:'Owner'}),new Response('DO-NOT-RETAIN-ERROR',{status}));
 const result=await ask(onMatch);
 expect(result).toEqual({ok:false,code,mayHaveCharged:false});expect(onMatch).toHaveBeenCalledTimes(2);expect(JSON.stringify(result)).not.toContain('DO-NOT-RETAIN');
});
it('treats a failed free search as uncharged, and a failed or unreadable enrichment as possibly charged',async()=>{
 expect(await ask(sequence(new Response('x',{status:500})))).toEqual({ok:false,code:'unavailable',mayHaveCharged:false});
 expect(await ask(sequence(new Response('{"people":"no"}')))).toEqual({ok:false,code:'invalid_response',mayHaveCharged:false});
 const thrown=vi.fn(async()=>{throw new Error('DO-NOT-RETAIN-SECRET');});
 expect(await ask(thrown)).toEqual({ok:false,code:'unavailable',mayHaveCharged:false});expect(thrown).toHaveBeenCalledTimes(1);
 expect(await ask(sequence(search({id:'p-2',title:'Owner'}),new Response('x',{status:500})))).toEqual({ok:false,code:'unavailable',mayHaveCharged:true});
 expect(await ask(sequence(search({id:'p-2',title:'Owner'}),new Response('x',{status:422})))).toEqual({ok:false,code:'unavailable',mayHaveCharged:false});
 expect(await ask(sequence(search({id:'p-2',title:'Owner'}),match({id:'p-2',first_name:'x'.repeat(101)})))).toMatchObject({ok:false,code:'invalid_response',mayHaveCharged:true});
 expect(await ask(sequence(search({id:'p-2',title:'Owner'}),new Response('x'.repeat(1024*1024+1))))).toEqual({ok:false,code:'unavailable',mayHaveCharged:true});
});
it('refuses a blank key, and asks nothing and charges nothing for a malformed domain, before any request, and reads only FSS_APOLLO_API_KEY',async()=>{
 const http=vi.fn(async()=>new Response('{}'));
 expect(await apolloPeople('',{http}).findDecisionMaker({domain:'cobalt.example',companyName:'Cobalt'})).toEqual({ok:false,code:'auth_failed',mayHaveCharged:false});
 expect(await apolloPeople('key',{http}).findDecisionMaker({domain:'cobalt example',companyName:'Cobalt'})).toEqual({ok:true,person:null,creditsUsed:0});
 expect(http).not.toHaveBeenCalled();
 expect(apolloPeopleFromEnvironment({})).toBeUndefined();
 expect(apolloPeopleFromEnvironment({FSS_APOLLO_API_KEY:'  '})).toBeUndefined();
 expect(apolloPeopleFromEnvironment({FSS_APOLLO_ORGANIZATION_SEARCH_KEY:'fixture'})).toBeUndefined();
 expect(apolloPeopleFromEnvironment({FSS_APOLLO_API_KEY:'fixture'})).toMatchObject({providerKey:'apollo',maxCreditsPerLookup:1});
});
