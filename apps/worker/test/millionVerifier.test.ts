import {it,expect,vi,type Mock} from 'vitest';
import type {ProviderHttp} from '../src/providers/boundedHttp.ts';
import {millionVerifier,millionVerifierFromEnvironment} from '../src/providers/millionVerifier.ts';

const KEY='mv-key-DO-NOT-LEAK';
const answer=(body:Record<string,unknown>,status=200)=>new Response(JSON.stringify(body),{status});
const sequence=(...responses:Response[]):Mock<ProviderHttp>=>vi.fn<ProviderHttp>(async()=>responses.shift()!);
const ask=(http:Mock<ProviderHttp>,address='ryan@peak.org')=>millionVerifier(KEY,{http}).check(address);
const request=(http:Mock<ProviderHttp>)=>{const [url,init] = http.mock.calls[0] as unknown as [string,RequestInit];return {url:new URL(url),init};};

it('sends one GET to the documented single-check endpoint with the key, the address and timeout=20, and follows no redirect',async()=>{
 const http=sequence(answer({email:'ryan@peak.org',quality:'good',result:'ok',resultcode:1,subresult:'ok',free:false,role:false,didyoumean:'',credits:3454,executiontime:2,error:'',livemode:true}));
 expect(await ask(http,'ryan+x@peak.org')).toEqual({ok:true,verdict:'ok'});
 expect(http).toHaveBeenCalledTimes(1);
 const {url,init}=request(http);
 expect(url.origin+url.pathname).toBe('https://api.millionverifier.com/api/v3/');
 expect(Object.fromEntries(url.searchParams)).toEqual({api:KEY,email:'ryan+x@peak.org',timeout:'20'});
 expect(init).toMatchObject({method:'GET',redirect:'error'});
});
it.each([['ok','ok'],['catch_all','catch_all'],['unknown','unknown'],['invalid','invalid'],['disposable','disposable'],['OK','ok'],['Catch_All','catch_all']] as const)('maps the vendor result %s to the verdict %s, and never reads the balance as a charge',async(result,verdict)=>{
 expect(await ask(sequence(answer({result,credits:12,error:''})))).toEqual({ok:true,verdict});
});
it.each(['unverified','error','','maybe'])('treats the unrecognised result %j as an unusable answer that may have been charged',async result=>{
 expect(await ask(sequence(answer({result,error:''})))).toEqual({ok:false,code:'invalid_response',mayHaveCharged:true});
});
it('treats an answer with no result, or an unreadable body, as unusable and possibly charged, and never as a verdict',async()=>{
 expect(await ask(sequence(answer({error:''})))).toEqual({ok:false,code:'invalid_response',mayHaveCharged:true});
 expect(await ask(sequence(answer({result:'ok'.repeat(30),error:''})))).toEqual({ok:false,code:'invalid_response',mayHaveCharged:true});
 expect(await ask(sequence(new Response('<html>not json</html>')))).toEqual({ok:false,code:'unavailable',mayHaveCharged:true});
 expect(await ask(sequence(new Response('x'.repeat(1024*1024+1))))).toEqual({ok:false,code:'unavailable',mayHaveCharged:true});
 expect(await ask(sequence(new Response(null,{status:200})))).toEqual({ok:false,code:'invalid_response',mayHaveCharged:true});
});
it.each([[401,'auth_failed'],[403,'auth_failed'],[402,'quota_exhausted'],[429,'rate_limited']] as const)('maps HTTP %s to %s, uncharged, without retrying or exposing the body or the key',async(status,code)=>{
 const http=vi.fn(async()=>new Response(`DO-NOT-RETAIN-ERROR ${KEY}`,{status}));
 const result=await ask(http);
 expect(result).toEqual({ok:false,code,mayHaveCharged:false});expect(http).toHaveBeenCalledTimes(1);expect(JSON.stringify(result)).not.toContain('DO-NOT-RETAIN');
});
it('treats another 4xx as an uncharged failure and a 5xx as possibly charged',async()=>{
 expect(await ask(sequence(new Response('x',{status:422})))).toEqual({ok:false,code:'unavailable',mayHaveCharged:false});
 expect(await ask(sequence(new Response('x',{status:500})))).toEqual({ok:false,code:'unavailable',mayHaveCharged:true});
 expect(await ask(sequence(new Response('x',{status:503})))).toEqual({ok:false,code:'unavailable',mayHaveCharged:true});
});
it.each([
 ['invalid_api_key','auth_failed'],['apikey_not_found','auth_failed'],['IP address blocked','auth_failed'],['insufficient credits','quota_exhausted'],['rate limit exceeded','rate_limited'],['internal error','unavailable'],['no email','unavailable'],
] as const)('reads an error answer (%s) as %s even when it also names a result, uncharged',async(error,code)=>{
 expect(await ask(sequence(answer({result:'ok',error})))).toEqual({ok:false,code,mayHaveCharged:false});
});
it('never lets the key, the address or a vendor message out through a thrown transport error, and does not retry',async()=>{
 const thrown=vi.fn<ProviderHttp>(async url=>{throw new Error(`DO-NOT-RETAIN ${url}`);});
 const result=await ask(thrown);
 expect(result).toEqual({ok:false,code:'unavailable',mayHaveCharged:true});expect(thrown).toHaveBeenCalledTimes(1);
 expect(JSON.stringify(result)).not.toMatch(/DO-NOT-RETAIN|mv-key|ryan@/u);
});
it('gives up after its own bound, once, as possibly charged',async()=>{
 vi.useFakeTimers();
 try{
  const hung=vi.fn<ProviderHttp>(()=>new Promise<Response>(()=>{}));
  const pending=ask(hung);
  await vi.advanceTimersByTimeAsync(30_001);
  expect(await pending).toEqual({ok:false,code:'unavailable',mayHaveCharged:true});expect(hung).toHaveBeenCalledTimes(1);
 }finally{vi.useRealTimers();}
});
it('refuses a blank key and a malformed address before any request, uncharged, and reads only FSS_MILLIONVERIFIER_API_KEY',async()=>{
 const http=vi.fn(async()=>new Response('{}'));
 expect(await millionVerifier('',{http}).check('ryan@peak.org')).toEqual({ok:false,code:'auth_failed',mayHaveCharged:false});
 expect(await millionVerifier('a\nb',{http}).check('ryan@peak.org')).toEqual({ok:false,code:'auth_failed',mayHaveCharged:false});
 for(const bad of ['ryan','ryan@','@peak.org','a b@peak.org','a@b@c.org',`${'a'.repeat(250)}@peak.org`])expect(await millionVerifier(KEY,{http}).check(bad),bad).toEqual({ok:false,code:'invalid_response',mayHaveCharged:false});
 expect(http).not.toHaveBeenCalled();
 expect(millionVerifierFromEnvironment({})).toBeUndefined();
 expect(millionVerifierFromEnvironment({FSS_MILLIONVERIFIER_API_KEY:'  '})).toBeUndefined();
 expect(millionVerifierFromEnvironment({FSS_APOLLO_API_KEY:'fixture',FSS_TAVILY_API_KEY:'fixture'})).toBeUndefined();
 expect(millionVerifierFromEnvironment({FSS_MILLIONVERIFIER_API_KEY:' fixture '})).toMatchObject({check:expect.any(Function)});
});
