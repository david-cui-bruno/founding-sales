import {US_BUSINESS_REGIONS,US_BUSINESS_STATE_NAMES} from '../../contracts/src/usBusinessGeography.ts';

// Service, place and placeholder wording that names no company.
const DESCRIPTIVE=/\b(?:services?|real estate|propert(?:y|ies)|management|managers?|experts?|investments?|rentals?|homes|hoa|commercial|residential|facilit(?:y|ies)|leasing|sales|compan(?:y|ies))\b|,\s*\p{L}+\.?$/iu;
// A US state code (case-sensitive, so "Co" is no Colorado) or name ends a place: "Spokane WA", "Washington".
const STATE_CODE=new RegExp(`(?:^|[\\s,])(?:${US_BUSINESS_REGIONS.join('|')})\\.?$`,'u'),STATE_NAME=new RegExp(`(?:^|[\\s,])(?:${Object.values(US_BUSINESS_STATE_NAMES).join('|')})\\.?$`,'iu');
const place=(part:string)=>STATE_CODE.test(part)||STATE_NAME.test(part);
const PLACEHOLDER=/^(?:company source|source|company|home|home ?page|welcome|untitled(?: page)?|index|web ?site)$/iu;
/** Search-title cleanup is a candidate suggestion, never identity evidence. One branded part
 * names the company; else a short non-descriptive last part after descriptive ones
 * ("Commercial Real Estate, HOA & Facility Services | Kiemle Hagood") when no part is branded and
 * the last part is no place; else the whole title.
 * An empty or placeholder title ("Company source") leaves the host to name the company. */
export function discoveryFirmName(title:string,url:string):string {
 const original=title.replace(/\s+/gu,' ').trim();
 const parts=original.split(/\s*[|–—]\s*|\s+-\s+/u).filter(Boolean),last=parts.at(-1)??'';
 const branded=parts.filter(part=>/\b(?:property (?:group|management)|realty|rentals|PM)\b/iu.test(part)
  &&! /^(?:property management|rhode island|providence|rentals,|sales|top\s|best\s)/iu.test(part));
 const brand=branded.length===0&&parts.length>1&&/\p{L}/u.test(last)&&last.split(' ').length<=6&&!DESCRIPTIVE.test(last)&&!place(last)&&parts.slice(0,-1).every(part=>DESCRIPTIVE.test(part)||place(part))?last:null;
 const name=branded.length===1?branded[0]!:brand??original;
 return (name===''||PLACEHOLDER.test(name)?companyHost(url):name).slice(0,300);
}

/** Directories excluded at the search provider; their pages rarely link to company sites. */
export const DISCOVERY_SEARCH_EXCLUDED_DOMAINS=['allpropertymanagement.com','propertymanagement.com','propertymanagementlist.com'] as const;
/** Hosts whose pages list or review many companies. Their outbound company links are
 * discovery leads; the directory itself is never a company or a source of company facts. */
export const DISCOVERY_DIRECTORY_DOMAINS=[...DISCOVERY_SEARCH_EXCLUDED_DOMAINS,
 'managemyproperty.com','ipropertymanagement.com','expertise.com','yelp.com','bbb.org','angi.com','homeadvisor.com','thumbtack.com','upnest.com','clutch.co','manta.com','yellowpages.com','porch.com','houzz.com'] as const;
/** Hosts that never describe a prospect company: reference, social, jobs, listings and portals. */
export const DISCOVERY_NONCOMPANY_DOMAINS=['wikipedia.org','merriam-webster.com','dictionary.com','britannica.com','mychart.org','facebook.com','instagram.com',
 'linkedin.com','twitter.com','x.com','youtube.com','tiktok.com','reddit.com','quora.com','pinterest.com','indeed.com','glassdoor.com','ziprecruiter.com',
 'zillow.com','trulia.com','redfin.com','realtor.com','apartments.com','rent.com','craigslist.org','nextdoor.com','google.com','apple.com','amazon.com',
 'macrotrends.net','statista.com','city-data.com','bestplaces.net','datausa.io','worldpopulationreview.com','neighborhoodscout.com'] as const;
/** Property-management software, portal and payment hosts. A firm's owner/tenant portal or
 * rent-payment page on them is not that firm's own site. */
export const DISCOVERY_PORTAL_DOMAINS=['appfolio.com','managebuilding.com','buildium.com','rentmanager.com','propertyware.com','rentcafe.com','yardi.com',
 'yardibreeze.com','doorloop.com','tenantcloud.com','rentecdirect.com','rentvine.com','turbotenant.com','avail.co','rentredi.com','cozy.co','paylease.com','zego.io'] as const;

const hostOf=(url:string)=>new URL(url).hostname.toLowerCase().replace(/\.$/u,'');
const within=(host:string,domains:readonly string[])=>domains.some(domain=>host===domain||host.endsWith('.'+domain));

/** Exact host families only: an ordinary firm's similar name is not a directory. */
export function isDiscoveryDirectory(url:string):boolean {
 return within(hostOf(url),DISCOVERY_DIRECTORY_DOMAINS);
}

// Suffixes under which the registrable domain takes three labels: multi-label country
// suffixes, and shared hosting where each tenant subdomain is its own organization.
const MULTI_LABEL_SUFFIXES=new Set(['co.uk','org.uk','ac.uk','com.au','net.au','org.au','co.nz','co.za','com.br','com.mx','co.in','com.sg','co.jp',
 'wixsite.com','squarespace.com','wordpress.com','weebly.com','godaddysites.com','webflow.io','netlify.app','github.io','blogspot.com','site123.me',
 'carrd.co','business.site','ueniweb.com','vercel.app','pages.dev','myshopify.com','editorx.io','strikingly.com','jimdosite.com']);
/** One organization per registrable domain: the last two labels, three under a known
 * multi-label or shared-hosting suffix. An approximation of eTLD+1 for same-organization links only. */
export function registrableDomain(url:string):string {
 const labels=hostOf(url).split('.');
 return labels.slice(MULTI_LABEL_SUFFIXES.has(labels.slice(-2).join('.'))?-3:-2).join('.');
}

/** One company per host (ADR0034): lowercase hostname without `www.`. */
export function companyHost(url:string):string {
 return hostOf(url).replace(/^www\./u,'');
}

const LIST_TITLE=/\b(?:top|best)\s+\d+\b|\b\d+\s+(?:top|best)\b|\b(?:top|best)\s+(?:[\p{L}&'-]+\s+){0,4}(?:property\s+)?(?:management\s+)?companies\b|\bcompanies\s+(?:in|near|serving)\b|\bdirectory\b|\blist\s+of\b/iu;
// A city listing such as `/companies/spokane-wa` on any host.
const LIST_PATH=new RegExp(`/companies/[a-z0-9-]+-(?:${US_BUSINESS_REGIONS.join('|')})/?$`,'iu');
export type DiscoveryPageKind='company'|'list'|'noise';
/** Routes a search hit or stored record (ADR0034). A list page yields leads, never facts. */
export function classifyDiscoveryPage(input:{url:string;title:string}):DiscoveryPageKind {
 const host=hostOf(input.url);
 if(within(host,DISCOVERY_NONCOMPANY_DOMAINS)||within(host,DISCOVERY_PORTAL_DOMAINS)||/\.(?:gov|edu|mil)$/u.test(host))return 'noise';
 if(within(host,DISCOVERY_DIRECTORY_DOMAINS)||LIST_TITLE.test(input.title)||LIST_PATH.test(new URL(input.url).pathname))return 'list';
 return 'company';
}
