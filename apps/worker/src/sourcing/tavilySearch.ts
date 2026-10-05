import {z} from 'zod';
import type {DiscoverySearchProvider,DiscoveryHit} from '@fss/domain/sourcing/discoveryProvider.ts';
import {isPublicResearchUrl,withoutFragment} from '@fss/domain/research/sourcePolicy.ts';
import {boundedProviderRequest,type ProviderHttp} from '../providers/boundedHttp.ts';
const responseSchema=z.object({
 request_id:z.string().min(1).max(200),
 results:z.array(z.object({url:z.string().max(2000),title:z.string().max(2000),content:z.string().max(20000).optional()})).max(5),
 usage:z.object({credits:z.literal(1)}),
});
/** Fixed Basic search, one request with explicit cost-affecting options. No retries. */
export function tavilySearch(apiKey:string,options:{http?:ProviderHttp}={}):DiscoverySearchProvider {
 const http=options.http??fetch;
 return {providerKey:'tavily_basic',discover:async({query})=>{
  if(query.trim().length===0||query.length>400)return {ok:false,code:'invalid_query'};
  if(!apiKey.trim()||/[\r\n]/u.test(apiKey))return {ok:false,code:'auth_failed'};
  try {
   const reply=await boundedProviderRequest(http,'https://api.tavily.com/search',{
    method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},
    body:JSON.stringify({query,search_depth:'basic',topic:'general',max_results:5,auto_parameters:false,
     include_answer:false,include_raw_content:false,include_images:false,include_usage:true}),
   },new AbortController().signal,15000);
   if(reply.status===401||reply.status===403)return {ok:false,code:'auth_failed'};
   if(reply.status===402||reply.status===432)return {ok:false,code:'quota_exhausted'};
   if(reply.status===429)return {ok:false,code:'rate_limited'};
   if(reply.status<200||reply.status>=300)return {ok:false,code:'unavailable'};
   const usage=z.object({usage:z.object({credits:z.literal(1)})}).safeParse(reply.body);
   if(!usage.success)return {ok:false,code:'usage_unexpected'};
   const parsed=responseSchema.safeParse(reply.body);if(!parsed.success)return {ok:false,code:'invalid_response'};
   const hits:DiscoveryHit[]=[],seen=new Set<string>();
   for(const row of parsed.data.results){
    const url=withoutFragment(row.url);
    if(url.length>500||!isPublicResearchUrl(url)||seen.has(url))continue;
    seen.add(url);hits.push({url,title:row.title.slice(0,300),snippet:(row.content??'').slice(0,2000)});
   }
   return {ok:true,credits:1,requestId:parsed.data.request_id,hits};
  }catch{return {ok:false,code:'unavailable'};}
 }};
}
