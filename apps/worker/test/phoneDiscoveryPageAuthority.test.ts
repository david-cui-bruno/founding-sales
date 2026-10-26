import {expect,it,vi} from 'vitest';
import type {PageFetchRequest} from '@fss/domain/research/providers.ts';
import {researchPageFetch,type RawResponse,type RequestOptions} from '../src/research/companyPageFetch.ts';

const HOME='https://example.test/',ROBOTS=`${HOME}robots.txt`,CONTACT=`${HOME}contact`;
const html=(text:string,statusCode=200,headers:RawResponse['headers']={}):RawResponse=>({statusCode,headers:{'content-type':'text/html',...headers},body:new TextEncoder().encode(text),abortedOverCap:false});
const redirect=(to:string)=>html('',302,{location:to});
const homepage=html('<p>Office phone: (214) 555-0123</p><a href="/contact">Contact</a><a href="/team">Team</a>');
const defaults:PageFetchRequest={urls:[HOME,`${HOME}about`],firmWebsite:HOME,links:[],maxPagesPerFirm:4,maxBytes:1000000,prioritizeContactPages:true};
function fixture(responses:Readonly<Record<string,RawResponse>>={},addresses:readonly string[]=['93.184.216.34']){
 const events:string[]=[],sent:RequestOptions[]=[];
 const lookup=vi.fn(async(hostname:string)=>{events.push(`lookup:${hostname}`);return addresses;});
 const request=vi.fn(async(options:RequestOptions)=>{
  events.push(`request:${options.url}`);sent.push(options);
  return responses[options.url]??(options.url===ROBOTS?html('User-agent: *\nDisallow:\n'):options.url===HOME?homepage:html('<p>Company page.</p>'));
 });
 const provider=researchPageFetch({lookup,request,now:()=>Date.parse('2026-10-26T07:15:00Z')});
 return {events,sent,lookup,request,provider};
}
function scenario(kind:'robots'|'homepage'|'contact'|'redirect'|'robots_redirect'){
 const target=kind==='robots'?ROBOTS:kind==='homepage'?HOME:kind==='contact'?CONTACT:kind==='redirect'?`${HOME}final`: `${HOME}robots-final`;
 const responses=kind==='redirect'?{[HOME]:redirect('/middle'),[`${HOME}middle`]:redirect('/final')}:kind==='robots_redirect'?{[ROBOTS]:redirect('/robots-middle'),[`${HOME}robots-middle`]:redirect('/robots-final')}:{};
 const expected=kind==='robots'?[]:kind==='homepage'?[ROBOTS]:kind==='contact'?[ROBOTS,HOME]:kind==='redirect'?[ROBOTS,HOME,`${HOME}middle`]:[ROBOTS,`${HOME}robots-middle`];
 return {target,responses,expected};
}
it.each(['robots','homepage','contact','redirect','robots_redirect'] as const)('denies exact %s destination before HTTP and stops the entire queue, not just that URL',async kind=>{
 const {target,responses,expected}=scenario(kind),f=fixture(responses),checked:string[]=[];
 const result=await f.provider.fetchPages({...defaults,mayFetchUrl:async url=>{checked.push(url);return url!==target;}});
 expect(result.ok).toBe(true);if(!result.ok)throw Error('Expected bounded adapter outcome');
 expect(result.value.skipped['source_authority_refused']).toBe(1);
 expect(f.sent.map(request=>request.url)).toEqual(expected);expect(f.sent.some(request=>request.url===target)).toBe(false);
 expect(checked.at(-1)).toBe(target);expect(checked).toEqual([...expected,target]);
 expect(result.value.pages.map(page=>page.url)).toEqual(kind==='contact'?[HOME]:[]);
 expect(f.sent.some(request=>[`${HOME}team`,`${HOME}about`].includes(request.url))).toBe(false);
});
it.each(['robots','homepage','contact','redirect','robots_redirect'] as const)('fails closed on a thrown %s destination check with no later HTTP or raw error',async kind=>{
 const {target,responses,expected}=scenario(kind),f=fixture(responses),checked:string[]=[];
 const result=await f.provider.fetchPages({...defaults,mayFetchUrl:async url=>{checked.push(url);if(url===target)throw Error('private native source detail');return true;}});
 expect(result.ok).toBe(true);if(!result.ok)throw Error('Expected bounded adapter outcome');
 expect(result.value.skipped['source_authority_refused']).toBe(1);
 expect(f.sent.map(request=>request.url)).toEqual(expected);expect(checked.at(-1)).toBe(target);
 expect(checked).toEqual([...expected,target]);expect(JSON.stringify(result)).not.toContain('private native source detail');
});
it('checks exact current authority immediately before every HTTP call, after global continuation and DNS/robots safety',async()=>{
 const f=fixture({[CONTACT]:redirect('/contact-office')});
 const result=await f.provider.fetchPages({...defaults,maxPagesPerFirm:2,
  shouldContinue:async()=>{f.events.push('continue');return true;},
  mayFetchUrl:async url=>{expect(f.events.at(-1)).toBe('continue');f.events.push(`authority:${url}`);return true;},
 });
 expect(result.ok).toBe(true);if(!result.ok)throw Error('Expected successful capture');
 expect(result.value.pages.map(page=>page.url)).toEqual([HOME,`${HOME}contact-office`]);
 const calls=[ROBOTS,HOME,CONTACT,`${HOME}contact-office`];expect(f.sent.map(request=>request.url)).toEqual(calls);
 for(const [index,event] of f.events.entries())if(event.startsWith('request:'))expect(f.events[index-1]).toBe(event.replace('request:','authority:'));
 expect(f.sent.every(request=>request.address==='93.184.216.34'&&request.hostname==='example.test')).toBe(true);
 expect(result.value.pages.every(page=>page.contentHash.length===64&&page.firstParty)).toBe(true);
});
it('reauthorizes page URLs even with cached robots and never requests a later allowed site after refusal',async()=>{
 const later='https://later.test/',f=fixture();
 const checked:string[]=[];
 const result=await f.provider.fetchPages({...defaults,urls:[HOME,later],links:[later],maxPagesPerFirm:8,mayFetchUrl:async url=>{checked.push(url);return url!==CONTACT;}});
 expect(result.ok&&result.value.skipped['source_authority_refused']).toBe(1);
 expect(f.sent.map(request=>request.url)).toEqual([ROBOTS,HOME]);expect(checked).toEqual([ROBOTS,HOME,CONTACT]);
 expect(f.lookup.mock.calls.every(([hostname])=>hostname==='example.test')).toBe(true);
});
it('keeps ordinary no-hook fetching, contact discovery, redirect following and robots caching unchanged',async()=>{
 const f=fixture({[CONTACT]:redirect('/contact-office')});
 const result=await f.provider.fetchPages({...defaults,maxPagesPerFirm:2});
 expect(result.ok).toBe(true);if(!result.ok)throw Error('Expected successful capture');
 expect(result.value.pages.map(page=>page.url)).toEqual([HOME,`${HOME}contact-office`]);
 expect(f.sent.map(request=>request.url)).toEqual([ROBOTS,HOME,CONTACT,`${HOME}contact-office`]);
 expect(result.value.skipped).not.toHaveProperty('source_authority_refused');
});
it('cannot override global pause or public-address denial with an always-true native hook',async()=>{
 const authority=vi.fn(async()=>true),paused=fixture();
 const pauseResult=await paused.provider.fetchPages({...defaults,shouldContinue:async()=>false,mayFetchUrl:authority});
 expect(pauseResult.ok&&pauseResult.value.skipped['paused']).toBeGreaterThan(0);expect(paused.sent).toEqual([]);expect(authority).not.toHaveBeenCalled();
 const unsafe=fixture({},['93.184.216.34','169.254.169.254']);
 const unsafeResult=await unsafe.provider.fetchPages({...defaults,urls:[HOME],mayFetchUrl:authority});
 expect(unsafeResult.ok&&unsafeResult.value.skipped).toEqual({address_not_public:1});expect(unsafe.sent).toEqual([]);expect(authority).not.toHaveBeenCalled();
});
it('keeps URL policy and robots denial authoritative before page-body dispatch',async()=>{
 const authority=vi.fn(async()=>true),blocked=fixture();
 const result=await blocked.provider.fetchPages({...defaults,urls:[`${HOME}?token=private`],mayFetchUrl:authority});
 expect(result.ok&&result.value.skipped['url_not_permitted']).toBe(1);expect(blocked.sent).toEqual([]);expect(authority).not.toHaveBeenCalled();
 const forbidden=fixture({[ROBOTS]:html('User-agent: *\nDisallow: /contact\n')});
 const robotsResult=await forbidden.provider.fetchPages({...defaults,maxPagesPerFirm:1,urls:[CONTACT],links:[CONTACT],mayFetchUrl:authority});
 expect(robotsResult.ok&&robotsResult.value.skipped).toEqual({robots_disallowed:1});
 expect(forbidden.sent.map(request=>request.url)).toEqual([ROBOTS]);expect(authority).toHaveBeenCalledExactlyOnceWith(ROBOTS);
});
