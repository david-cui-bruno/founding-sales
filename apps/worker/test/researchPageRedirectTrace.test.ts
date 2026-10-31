import {createHash} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import {MAX_REDIRECTS,researchPageFetch,type RawResponse,type RequestOptions} from '../src/research/companyPageFetch.ts';

const HOME='<p>We manage residential property for owners.</p>';
const bytes=(text:string):Uint8Array=>new TextEncoder().encode(text);
const ok=(body:string,contentType='text/html; charset=utf-8'):RawResponse=>({statusCode:200,headers:{'content-type':contentType},body:bytes(body),abortedOverCap:false});
const robotsAllowing=ok('User-agent: *\nDisallow:\n','text/plain');
const request={firmWebsite:'https://example.test/',links:[] as readonly string[],maxPagesPerFirm:1,maxBytes:1_000_000};
/** Actual adapter with controlled HTTP/DNS boundaries; no sockets, provider or database. */
function harness(options:{answers:Readonly<Record<string,readonly string[]>>;responses:Readonly<Record<string,RawResponse>>}){
 const sent:RequestOptions[]=[];
 const provider=researchPageFetch({lookup:async host=>{const answer=options.answers[host];if(!answer)throw Error('Missing controlled DNS response');return answer;},
  request:async input=>{sent.push(input);const answer=options.responses[input.url];if(!answer)throw Error('Missing controlled HTTP response');return answer;},
  now:()=>Date.parse('2026-09-28T14:00:00.000Z')});
 return {provider,sent};
}

describe('opt-in page redirect provenance',()=>{
  it('records the actual slash redirect only when redirect provenance is requested',async()=>{
    const {provider,sent}=harness({answers:{'example.test':['93.184.216.34']},responses:{
      'https://example.test/robots.txt':robotsAllowing,
      'https://example.test/about':{statusCode:301,headers:{location:'/about/'},body:null,abortedOverCap:false},
      'https://example.test/about/':ok(HOME),
    }});
    const outcome=await provider.fetchPages({...request,urls:['https://example.test/about'],maxPagesPerFirm:2,recordRedirectTrace:true});
    expect(outcome.ok&&outcome.value.pages[0]).toMatchObject({url:'https://example.test/about/',redirectTrace:{version:'page-redirect-trace-v1',urls:['https://example.test/about','https://example.test/about/']}});
    expect(sent.map(entry=>entry.url)).toEqual(['https://example.test/robots.txt','https://example.test/about','https://example.test/about/']);
  });

  it('preserves the exact legacy page shape and request sequence when tracing is absent or false',async()=>{
    const h=harness({answers:{'example.test':['93.184.216.34']},responses:{
      'https://example.test/robots.txt':robotsAllowing,
      'https://example.test/':{statusCode:301,headers:{location:'/home'},body:null,abortedOverCap:false},
      'https://example.test/home':ok(HOME),
    }});
    const legacy=await h.provider.fetchPages({...request,urls:['https://example.test/']});
    const firstRequests=[...h.sent];h.sent.length=0;
    const off=await h.provider.fetchPages({...request,urls:['https://example.test/'],recordRedirectTrace:false});
    expect(off).toEqual(legacy);expect(h.sent).toEqual(firstRequests);
    expect(off.ok&&off.value.pages[0]).toEqual({url:'https://example.test/home',contentHash:createHash('sha256').update(bytes(HOME)).digest('hex'),contentType:'text/html; charset=utf-8',body:bytes(HOME),retrievedAt:'2026-09-28T14:00:00.000Z',firstParty:true});
  });

  it('records all three followed hops and ends at the exact returned URL without adding requests',async()=>{
    const hop=(location:string):RawResponse=>({statusCode:302,headers:{location},body:null,abortedOverCap:false});
    const h=harness({answers:{'example.test':['93.184.216.34'],'www.example.test':['93.184.216.35']},responses:{
      'https://example.test/robots.txt':robotsAllowing,'https://www.example.test/robots.txt':robotsAllowing,
      'https://example.test/':hop('https://www.example.test/home'),
      'https://www.example.test/home':hop('/about'),
      'https://www.example.test/about':hop('/about/'),
      'https://www.example.test/about/':ok(HOME),
    }});
    const outcome=await h.provider.fetchPages({...request,urls:['https://example.test/'],recordRedirectTrace:true});
    expect(outcome.ok&&outcome.value.pages[0]).toMatchObject({url:'https://www.example.test/about/',redirectTrace:{version:'page-redirect-trace-v1',urls:['https://example.test/','https://www.example.test/home','https://www.example.test/about','https://www.example.test/about/']}});
    const onRequests=[...h.sent];h.sent.length=0;
    const legacy=await h.provider.fetchPages({...request,urls:['https://example.test/']});
    expect(h.sent).toEqual(onRequests);expect(outcome.ok&&outcome.value.pages[0]?.redirectTrace?.urls).toHaveLength(MAX_REDIRECTS+1);
    if(!outcome.ok||!legacy.ok)throw Error('Expected controlled successful page fetches');
    const {redirectTrace:_trace,...page}=outcome.value.pages[0]!;expect(page).toEqual(legacy.value.pages[0]);
  });

  it('records an explicitly permitted offsite hop without treating it as first-party equivalence',async()=>{
    const h=harness({answers:{'example.test':['93.184.216.34'],'directory.test':['93.184.216.35']},responses:{
      'https://example.test/robots.txt':robotsAllowing,'https://directory.test/robots.txt':robotsAllowing,
      'https://example.test/':{statusCode:302,headers:{location:'https://directory.test/source'},body:null,abortedOverCap:false},
      'https://directory.test/source':ok(HOME),
    }});
    const outcome=await h.provider.fetchPages({...request,urls:['https://example.test/'],links:['https://directory.test/source'],recordRedirectTrace:true});
    expect(outcome.ok&&outcome.value.pages[0]).toMatchObject({url:'https://directory.test/source',firstParty:false,redirectTrace:{version:'page-redirect-trace-v1',urls:['https://example.test/','https://directory.test/source']}});
    expect(h.sent.map(entry=>entry.url)).toEqual(['https://example.test/robots.txt','https://example.test/','https://directory.test/robots.txt','https://directory.test/source']);
  });

  it.each([
    {location:'https://unapproved.test/',reason:'url_not_permitted'},
    {location:'https://example.test/home?token=private',reason:'url_has_query'},
    {location:'http://[',reason:'malformed_redirect'},
  ])('does not create a page trace or request a refused redirect: $reason',async({location,reason})=>{
    const h=harness({answers:{'example.test':['93.184.216.34']},responses:{
      'https://example.test/robots.txt':robotsAllowing,
      'https://example.test/':{statusCode:302,headers:{location},body:null,abortedOverCap:false},
    }});
    const traced=await h.provider.fetchPages({...request,urls:['https://example.test/'],recordRedirectTrace:true});
    expect(traced).toMatchObject({ok:true,value:{pages:[],skipped:{[reason]:1}}});
    expect(h.sent.map(entry=>entry.url)).toEqual(['https://example.test/robots.txt','https://example.test/']);
    const sent=[...h.sent];h.sent.length=0;expect(await h.provider.fetchPages({...request,urls:['https://example.test/']})).toEqual(traced);expect(h.sent).toEqual(sent);
  });

  it('excludes robots redirects from the page-only trace',async()=>{
    const h=harness({answers:{'example.test':['93.184.216.34']},responses:{
      'https://example.test/robots.txt':{statusCode:301,headers:{location:'/robots-v2.txt'},body:null,abortedOverCap:false},
      'https://example.test/robots-v2.txt':robotsAllowing,'https://example.test/':ok(HOME),
    }});
    const outcome=await h.provider.fetchPages({...request,urls:['https://example.test/'],recordRedirectTrace:true});
    expect(outcome.ok&&outcome.value.pages[0]?.redirectTrace).toEqual({version:'page-redirect-trace-v1',urls:['https://example.test/']});
    expect(h.sent.map(entry=>entry.url)).toEqual(['https://example.test/robots.txt','https://example.test/robots-v2.txt','https://example.test/']);
  });

});
