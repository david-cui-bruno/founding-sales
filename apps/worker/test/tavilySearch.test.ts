import {it,expect,vi} from 'vitest';
import {tavilySearch} from '../src/sourcing/tavilySearch.ts';
const result={results:[{url:'https://pm.example/maintenance',title:'Example PM',content:'Call the owner.'}],usage:{credits:1},request_id:'native-123'};
it('uses one Basic request with no agentic fan-out and preserves native provenance',async()=>{
 const http=vi.fn(async()=>Response.json(result));const search=tavilySearch('test-key',{http});
 expect(await search.discover({query:'Dallas property manager maintenance'})).toMatchObject({ok:true,credits:1,requestId:'native-123',hits:[{url:result.results[0]!.url,snippet:'Call the owner.'}]});
 expect(http).toHaveBeenCalledTimes(1);const [url,init]=http.mock.calls[0]! as unknown as [string,RequestInit];
 expect(url).toBe('https://api.tavily.com/search');expect(init.redirect).toBe('error');
 expect(JSON.parse(init.body as string)).toMatchObject({search_depth:'basic',auto_parameters:false,include_answer:false,include_raw_content:false,include_usage:true,max_results:20,exclude_domains:['allpropertymanagement.com','propertymanagement.com','propertymanagementlist.com']});
});
it('deduplicates URLs, rejects nonpublic URLs and never turns snippets into verified facts',async()=>{
 const http=vi.fn(async()=>Response.json({...result,results:[...result.results,{...result.results[0],url:result.results[0]!.url+'#a'},{url:'http://127.0.0.1',title:'bad',content:'bad'},{url:'https://example.test/private?token=abc',title:'query',content:'x'}]}));
 const got=await tavilySearch('test-key',{http}).discover({query:'PM'});expect(got).toMatchObject({ok:true,hits:[{url:result.results[0]!.url}]});if(got.ok)expect(got.hits).toHaveLength(1);
});
it('fails closed on missing or unexpected credit usage and sanitizes provider errors',async()=>{
 for(const usage of [undefined,{credits:2}]){
  const got=await tavilySearch('test-key',{http:async()=>Response.json({...result,usage})}).discover({query:'PM'});
  expect(got).toMatchObject({ok:false,code:'usage_unexpected'});
 }
 const http=vi.fn(async()=>new Response('test-key secret',{status:429}));
 expect(await tavilySearch('test-key',{http}).discover({query:'PM'})).toEqual({ok:false,code:'rate_limited'});expect(http).toHaveBeenCalledTimes(1);
});
it('bounds stalled and oversized responses without leaking exceptions',async()=>{
 vi.useFakeTimers();
 try{
  const request=tavilySearch('test-key',{http:async()=>new Promise<Response>(()=>{})}).discover({query:'PM'});
  await vi.advanceTimersByTimeAsync(15001);expect(await request).toEqual({ok:false,code:'unavailable'});
 }finally{vi.useRealTimers();}
 expect(await tavilySearch('test-key',{http:async()=>new Response('x'.repeat(1024*1024+1))}).discover({query:'PM'})).toEqual({ok:false,code:'unavailable'});
});
it('refuses invalid queries before requesting and requires native result metadata',async()=>{
 const http=vi.fn(async()=>Response.json({results:[{title:'No URL'}],usage:{credits:1}}));const provider=tavilySearch('test-key',{http});
 expect(await provider.discover({query:''})).toMatchObject({ok:false,code:'invalid_query'});expect(http).not.toHaveBeenCalled();
 expect(await provider.discover({query:'PM'})).toMatchObject({ok:false,code:'invalid_response'});
});

it('accepts twenty results for one credit and refuses a response beyond the requested bound',async()=>{
 const rows=Array.from({length:20},(_,i)=>({url:`https://firm-${i}.test/`,title:`Firm ${i}`,content:'Residential management'}));
 const response=await tavilySearch('test-key',{http:async()=>Response.json({...result,results:rows})}).discover({query:'PM'});
 expect(response.ok&&response.hits).toHaveLength(20);
 expect(await tavilySearch('test-key',{http:async()=>Response.json({...result,results:[...rows,{...rows[0],url:'https://overflow.test/'}]})}).discover({query:'PM'})).toMatchObject({ok:false,code:'invalid_response'});
});
