import {randomUUID} from 'node:crypto';
import {isIP} from 'node:net';
import {z} from 'zod';
import {isPublicResearchUrl} from '@fss/domain/research/sourcePolicy.ts';
import {APOLLO_ORGANIZATION_PAGE_LIMIT,type DiscoveryRegion,type OrganizationDiscoveryProvider} from '@fss/domain/sourcing/discoveryProvider.ts';
import {boundedProviderRequest,type ProviderHttp} from '../providers/boundedHttp.ts';

const organizationSchema=z.object({
 name:z.string().trim().min(1).max(300),primary_domain:z.string().trim().min(1).max(253),
 city:z.string().trim().min(1).max(120).nullable().optional(),
 state:z.string().trim().max(40).nullable().optional(),
 estimated_num_employees:z.number().int().min(1).max(10).nullable().optional(),
});
const responseSchema=z.object({organizations:z.array(organizationSchema).max(APOLLO_ORGANIZATION_PAGE_LIMIT)});
const stateNames:Record<DiscoveryRegion,string>={TX:'Texas',RI:'Rhode Island',MA:'Massachusetts'};
const regionFor=(state:string|null|undefined):DiscoveryRegion|null=>
 (Object.keys(stateNames) as DiscoveryRegion[]).find(region=>state===region||state?.toLowerCase()===stateNames[region].toLowerCase())??null;

/** One fixed company-only endpoint. Raw responses and vendor identifiers never escape.
 * No retries, enrichment, contact exports, paid fallback, or provider error bodies.
 */
export function apolloSearch(apiKey:string,options:{http?:ProviderHttp}={}):OrganizationDiscoveryProvider {
 const http=options.http??fetch;
 return {providerKey:'apollo_free',discoverOrganizations:async({region,page,perPage})=>{
  if(!Object.hasOwn(stateNames,region)||!Number.isSafeInteger(page)||page<1||page>100000||perPage!==100)return {ok:false,code:'invalid_query'};
  if(!apiKey.trim()||/[\r\n]/u.test(apiKey))return {ok:false,code:'auth_failed'};
  try{
   const response=await boundedProviderRequest(http,'https://api.apollo.io/api/v1/mixed_companies/search',{
    method:'POST',headers:{'X-Api-Key':apiKey,'Content-Type':'application/json','Cache-Control':'no-cache'},
    body:JSON.stringify({organization_locations:[`${stateNames[region]}, US`],organization_num_employees_ranges:['1,10'],q_organization_keyword_tags:['property management'],page,per_page:APOLLO_ORGANIZATION_PAGE_LIMIT}),
   },new AbortController().signal,15000);
   if(response.status===401||response.status===403)return {ok:false,code:'auth_failed'};
   if(response.status===402)return {ok:false,code:'quota_exhausted'};
   if(response.status===429)return {ok:false,code:'rate_limited'};
   if(response.status<200||response.status>=300)return {ok:false,code:'unavailable'};
   // z.object strips every unrecognized field, including contacts and raw descriptions.
   const parsed=responseSchema.safeParse(response.body);
   if(!parsed.success)return {ok:false,code:'invalid_response'};
   const organizations=[];
   for(const row of parsed.data.organizations){
    const domain=row.primary_domain.toLowerCase().replace(/^www\./u,'');
    if(!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(domain)||isIP(domain)||!isPublicResearchUrl(`https://${domain}/`))continue;
    organizations.push({name:row.name,domain,hqCity:row.city??null,hqState:regionFor(row.state),employeeCount:row.estimated_num_employees??null});
   }
   return {ok:true,requestId:randomUUID(),returnedCount:parsed.data.organizations.length,organizations};
  }catch{return {ok:false,code:'unavailable'};}
 }};
}

/** Nonsecret operator references identify the real exclusive account/key pair.
 * A key alone is deliberately insufficient. Never log the environment or key.
 */
export function apolloFromEnvironment(environment:Readonly<Record<string,string|undefined>>):{provider:OrganizationDiscoveryProvider;accountRef:string;keyRef:string}|undefined {
 const key=environment['FSS_APOLLO_ORGANIZATION_SEARCH_KEY'],accountRef=environment['FSS_APOLLO_ACCOUNT_REF'],keyRef=environment['FSS_APOLLO_KEY_REF'];
 const reference=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/u;
 return key?.trim()&&accountRef&&keyRef&&reference.test(accountRef)&&reference.test(keyRef)?{provider:apolloSearch(key),accountRef,keyRef}:undefined;
}
