import {it,expect,vi} from 'vitest';
import {apolloSearch,apolloFromEnvironment} from '../src/sourcing/apolloSearch.ts';
const organization={name:'Example PM',primary_domain:'WWW.EXAMPLE.TEST',city:'Dallas',state:'Texas',estimated_num_employees:4};
const search={region:'TX' as const,page:1,perPage:100 as const};
it('calls only Organization Search once with fixed company, region, size and page filters, stripping every other field',async()=>{
 const http=vi.fn(async()=>new Response(JSON.stringify({organizations:[{...organization,id:'vendor-id',phone:'DO-NOT-RETAIN-PHONE',contacts:[{email:'DO-NOT-RETAIN-EMAIL'}],raw:'DO-NOT-RETAIN-RAW',description:'DO-NOT-RETAIN-DESCRIPTION'}],people:[{name:'DO-NOT-RETAIN-PERSON'}],request_id:'DO-NOT-RETAIN-REQUEST'})));
 const result=await apolloSearch('fixture-key',{http}).discoverOrganizations(search);
 expect(http).toHaveBeenCalledTimes(1);
 const [url,init]=http.mock.calls[0] as unknown as [string,RequestInit];
 expect(url).toBe('https://api.apollo.io/api/v1/mixed_companies/search');
 expect(init).toMatchObject({method:'POST',redirect:'error',headers:{'X-Api-Key':'fixture-key'}});
 expect(JSON.parse(String(init.body))).toEqual({organization_locations:['Texas, US'],organization_num_employees_ranges:['1,10'],q_organization_keyword_tags:['property management'],page:1,per_page:100});
 expect(result).toMatchObject({ok:true,returnedCount:1,organizations:[{name:'Example PM',domain:'example.test',hqCity:'Dallas',hqState:'TX',employeeCount:4}]});
 expect(JSON.stringify(result)).not.toContain('DO-NOT-RETAIN');
 if(result.ok)expect(result.requestId).toMatch(/^[a-f0-9-]{36}$/u);
});
it.each([['RI','Rhode Island'],['MA','Massachusetts']] as const)('uses the fixed %s company location filter',async(region,name)=>{
 const http=vi.fn(async()=>new Response('{"organizations":[]}'));
 await apolloSearch('fixture',{http}).discoverOrganizations({...search,region});
 expect(JSON.parse(String((http.mock.calls[0] as unknown as [string,RequestInit])[1].body)).organization_locations).toEqual([`${name}, US`]);
});
it('counts the source page independently of normalized domains and never invents missing headquarters or size',async()=>{
 const rows=[{...organization,primary_domain:'127.0.0.1'},{...organization,city:null,state:null,estimated_num_employees:null}];
 const result=await apolloSearch('fixture',{http:async()=>new Response(JSON.stringify({organizations:rows}))}).discoverOrganizations(search);
 expect(result).toMatchObject({ok:true,returnedCount:2,organizations:[{name:'Example PM',domain:'example.test',hqCity:null,hqState:null,employeeCount:null}]});
});
it.each([401,403,402,429,500,302])('never retries HTTP %s or exposes its error body',async status=>{
 const http=vi.fn(async()=>new Response('DO-NOT-RETAIN-ERROR',{status}));
 const result=await apolloSearch('fixture',{http}).discoverOrganizations(search);
 expect(result.ok).toBe(false);expect(JSON.stringify(result)).not.toContain('DO-NOT-RETAIN');expect(http).toHaveBeenCalledTimes(1);
});
it('never retries a thrown transport error',async()=>{
 const http=vi.fn(async()=>{throw new Error('DO-NOT-RETAIN-SECRET');});
 expect(await apolloSearch('fixture',{http}).discoverOrganizations(search)).toEqual({ok:false,code:'unavailable'});
 expect(http).toHaveBeenCalledTimes(1);
});
it.each([
 {organizations:Array.from({length:101},()=>organization)},
 {organizations:[{...organization,estimated_num_employees:11}]},
 {organizations:[{...organization,name:'n'.repeat(301)}]},
 {organizations:[{...organization,primary_domain:'d'.repeat(254)}]},
 {people:[{name:'not an organization'}]},
])('refuses malformed or over-bounded responses',async body=>{
 expect(await apolloSearch('fixture',{http:async()=>new Response(JSON.stringify(body))}).discoverOrganizations(search)).toEqual({ok:false,code:'invalid_response'});
});
it('bounds the response byte stream and declared length',async()=>{
 for(const response of [new Response('x'.repeat(1024*1024+1)),new Response('{"organizations":[]}',{headers:{'content-length':String(1024*1024+1)}})]){
  const http=vi.fn(async()=>response);
  expect(await apolloSearch('fixture',{http}).discoverOrganizations(search)).toEqual({ok:false,code:'unavailable'});expect(http).toHaveBeenCalledTimes(1);
 }
});
it('refuses invalid inputs before HTTP and stays unconfigured without a nonsecret account/key binding',async()=>{
 const http=vi.fn(async()=>new Response('{"organizations":[]}'));
 expect(await apolloSearch('',{http}).discoverOrganizations(search)).toEqual({ok:false,code:'auth_failed'});
 expect(await apolloSearch('fixture',{http}).discoverOrganizations({...search,page:0})).toEqual({ok:false,code:'invalid_query'});
 expect(http).not.toHaveBeenCalled();
 expect(apolloFromEnvironment({})).toBeUndefined();
 expect(apolloFromEnvironment({FSS_APOLLO_ORGANIZATION_SEARCH_KEY:'fixture'})).toBeUndefined();
 expect(apolloFromEnvironment({FSS_APOLLO_ORGANIZATION_SEARCH_KEY:'fixture',FSS_APOLLO_ACCOUNT_REF:'account-1',FSS_APOLLO_KEY_REF:'key-1'})).toMatchObject({accountRef:'account-1',keyRef:'key-1',provider:{providerKey:'apollo_free'}});
});
