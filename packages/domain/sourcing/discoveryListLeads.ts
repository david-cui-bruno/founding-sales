import {sourcingUrlSchema} from '@fss/contracts';
import {MAX_PAGE_BYTES,mediaTypeOf} from '../research/pageText.ts';
import {classifyDiscoveryPage,companyHost,type DiscoveryPageKind} from './discoveryIdentity.ts';
import type {DiscoveryHit} from './discoveryProvider.ts';

/** List pages fetched per search, in result order (ADR0034). */
export const DISCOVERY_LIST_PAGE_LIMIT=3;
/** Company leads taken from one list page, in page order. */
export const DISCOVERY_LIST_LEAD_LIMIT=20;
/** A pointer to another company's own site; the list page is never a source of its facts. */
export interface DiscoveryListLead {readonly url:string;readonly host:string;readonly label:string}
export interface DiscoveryRoutedHit {readonly hit:DiscoveryHit;readonly kind:DiscoveryPageKind}

/** Every hit keeps its result position; only the first list hits are expanded. */
export function routeDiscoveryHits(hits:readonly DiscoveryHit[]):{readonly routed:readonly DiscoveryRoutedHit[];readonly lists:readonly DiscoveryHit[]} {
 const routed=hits.map(hit=>({hit,kind:classifyDiscoveryPage({url:hit.url,title:hit.title})}));
 return {routed,lists:routed.filter(r=>r.kind==='list').slice(0,DISCOVERY_LIST_PAGE_LIMIT).map(r=>r.hit)};
}

// Bounded lexical scan like `anchorHrefs`, plus the anchor's own text as the lead label.
const ANCHOR=/<a\s[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>`=]+))[^>]*>([\s\S]{0,2000}?)<\/a\s*>/giu;
const ENTITIES:Record<string,string>={quot:'"',apos:"'",lt:'<',gt:'>',amp:'&',nbsp:' '};
const decode=(value:string)=>value.replace(/&(#(?:[xX][0-9a-fA-F]{1,6}|[0-9]{1,7})|quot|apos|lt|gt|amp|nbsp);/giu,(_,token:string)=>{
 if(!token.startsWith('#'))return ENTITIES[token.toLowerCase()]??'';
 const code=token[1]?.toLowerCase()==='x'?Number.parseInt(token.slice(2),16):Number.parseInt(token.slice(1),10);
 return Number.isInteger(code)&&code>0&&code<=0x10ffff&&(code<0xd800||code>0xdfff)?String.fromCodePoint(code):'\uFFFD';
});

/** Links to other company hosts, one per host, in page order. A lead is stored as
 * `https://<host><path>`: http is upgraded and query/fragment dropped, so a tracking
 * parameter cannot make a lead unreadable; one that is still not a valid source URL is no lead. */
export function discoveryListLeads(listUrl:string,page:{readonly url:string;readonly body:Uint8Array;readonly contentType:string}):readonly DiscoveryListLead[] {
 if(page.body.byteLength>MAX_PAGE_BYTES||mediaTypeOf(page.contentType)!=='text/html')return [];
 const seen=new Set([companyHost(listUrl),companyHost(page.url)]),leads:DiscoveryListLead[]=[];
 for(const match of new TextDecoder('utf-8').decode(page.body).matchAll(ANCHOR)){
  if(leads.length>=DISCOVERY_LIST_LEAD_LIMIT)break;
  let link:URL;
  try{link=new URL(decode(match[1]??match[2]??match[3]??'').trim());}catch{continue;}
  if(link.protocol!=='https:'&&link.protocol!=='http:')continue;
  const url=`https://${link.hostname}${link.pathname}`;
  if(!sourcingUrlSchema.safeParse(url).success)continue;
  const host=companyHost(url),label=decode((match[4]??'').replace(/<[^>]*>/gu,' ')).replace(/\s+/gu,' ').trim().slice(0,300);
  if(seen.has(host)||classifyDiscoveryPage({url,title:label})!=='company')continue;
  seen.add(host);leads.push({url,host,label});
 }
 return leads;
}
