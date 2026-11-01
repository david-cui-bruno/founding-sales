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
const ENTITIES:Record<string,string>={quot:'"',apos:"'",lt:'<',gt:'>',amp:'&',nbsp:' ',raquo:'»',rsaquo:'›',rarr:'→'};
const decode=(value:string)=>value.replace(/&(#(?:[xX][0-9a-fA-F]{1,6}|[0-9]{1,7})|quot|apos|lt|gt|amp|nbsp|raquo|rsaquo|rarr);/giu,(_,token:string)=>{
 if(!token.startsWith('#'))return ENTITIES[token.toLowerCase()]??'';
 const code=token[1]?.toLowerCase()==='x'?Number.parseInt(token.slice(2),16):Number.parseInt(token.slice(1),10);
 return Number.isInteger(code)&&code>0&&code<=0x10ffff&&(code<0xd800||code>0xdfff)?String.fromCodePoint(code):'\uFFFD';
});
const text=(html:string)=>decode(html.replace(/<[^>]*>/gu,' ')).replace(/\s+/gu,' ').replace(/[\s»›>→⇒⟶➔➜➝➞▸►▶‣]+$/u,'').trim().slice(0,300);
// Navigation wording names no company; neither does a bare URL or host.
const NAVIGATION=/^(?:(?:go to|visit)(?: the| their| our| company)?(?: web ?site| site| homepage| home page)|web ?site|site|homepage|home page|(?:learn|read|see|view) more|more(?: info(?:rmation)?| details)?|view (?:profile|details|web ?site|company)|click here|details|contact(?: us)?|info)$/u;
const generic=(label:string,host:string)=>{
 const plain=label.toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
 return plain===''||NAVIGATION.test(plain)||label.toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//u,'').replace(/[/?#].*$/u,'').replace(/^www\./u,'').replace(/\.$/u,'')===host;
};
// The company named by the listing item that holds the link: its last heading or strong text.
const ITEM_NAME=/<(h[1-6]|strong|b)\b[^>]*>([\s\S]{0,500}?)<\/\1\s*>/giu;

/** Links to other company hosts, one per host, in page order. A lead is stored as
 * `https://<host><path>`: http is upgraded and query/fragment dropped, so a tracking
 * parameter cannot make a lead unreadable; one that is still not a valid source URL is no lead.
 * A navigation label ("Go to website >>") is replaced by the item's heading, else left
 * empty so the candidate is named by its host. */
export function discoveryListLeads(listUrl:string,page:{readonly url:string;readonly body:Uint8Array;readonly contentType:string}):readonly DiscoveryListLead[] {
 if(page.body.byteLength>MAX_PAGE_BYTES||mediaTypeOf(page.contentType)!=='text/html')return [];
 const seen=new Set([companyHost(listUrl),companyHost(page.url)]),leads:DiscoveryListLead[]=[],source=new TextDecoder('utf-8').decode(page.body);
 // The listing item starts after the previous external link, or at the nearest item element.
 let itemStart=0;
 for(const match of source.matchAll(ANCHOR)){
  if(leads.length>=DISCOVERY_LIST_LEAD_LIMIT)break;
  let link:URL;
  try{link=new URL(decode(match[1]??match[2]??match[3]??'').trim());}catch{continue;}
  if(link.protocol!=='https:'&&link.protocol!=='http:')continue;
  const before=source.slice(Math.max(itemStart,match.index-2000),match.index);
  if(!seen.has(companyHost(link.href)))itemStart=match.index+match[0].length;
  const url=`https://${link.hostname}${link.pathname}`;
  if(!sourcingUrlSchema.safeParse(url).success)continue;
  const host=companyHost(url);
  let label=text(match[4]??'');
  if(generic(label,host)){
   const item=before.slice(Math.max(0,...[...before.matchAll(/<(?:li|article|tr)\b/giu)].map(m=>m.index)));
   label=[...item.matchAll(ITEM_NAME)].map(m=>text(m[2]??'')).reverse().find(name=>!generic(name,host))??'';
  }
  if(seen.has(host)||classifyDiscoveryPage({url,title:label})!=='company')continue;
  seen.add(host);leads.push({url,host,label});
 }
 return leads;
}
