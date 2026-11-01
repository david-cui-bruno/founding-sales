/** Search-title cleanup is a candidate suggestion, never identity evidence. */
export function discoveryFirmName(title:string,url:string):string {
 const original=title.replace(/\s+/gu,' ').trim();
 const parts=original.split(/\s*[|–—]\s*|\s+-\s+/u).filter(Boolean);
 const branded=parts.filter(part=>/\b(?:property (?:group|management)|realty|rentals|PM)\b/iu.test(part)
  &&! /^(?:property management|rhode island|providence|rentals,|sales|top\s|best\s)/iu.test(part));
 return (branded.length===1?branded[0]!:original||new URL(url).hostname).slice(0,300);
}

/** Directories excluded at the search provider; their pages rarely link to company sites. */
export const DISCOVERY_SEARCH_EXCLUDED_DOMAINS=['allpropertymanagement.com','propertymanagement.com','propertymanagementlist.com'] as const;
/** Hosts whose pages list or review many companies. Their outbound company links are
 * discovery leads; the directory itself is never a company or a source of company facts. */
export const DISCOVERY_DIRECTORY_DOMAINS=[...DISCOVERY_SEARCH_EXCLUDED_DOMAINS,
 'managemyproperty.com','expertise.com','yelp.com','bbb.org','angi.com','homeadvisor.com','thumbtack.com','upnest.com','clutch.co','manta.com','yellowpages.com','porch.com','houzz.com'] as const;
/** Hosts that never describe a prospect company: reference, social, jobs, listings and portals. */
export const DISCOVERY_NONCOMPANY_DOMAINS=['wikipedia.org','merriam-webster.com','dictionary.com','britannica.com','mychart.org','facebook.com','instagram.com',
 'linkedin.com','twitter.com','x.com','youtube.com','tiktok.com','reddit.com','quora.com','pinterest.com','indeed.com','glassdoor.com','ziprecruiter.com',
 'zillow.com','trulia.com','redfin.com','realtor.com','apartments.com','rent.com','craigslist.org','nextdoor.com','google.com','apple.com','amazon.com'] as const;

const hostOf=(url:string)=>new URL(url).hostname.toLowerCase().replace(/\.$/u,'');
const within=(host:string,domains:readonly string[])=>domains.some(domain=>host===domain||host.endsWith('.'+domain));

/** Exact host families only: an ordinary firm's similar name is not a directory. */
export function isDiscoveryDirectory(url:string):boolean {
 return within(hostOf(url),DISCOVERY_DIRECTORY_DOMAINS);
}

/** One company per host (ADR0034): lowercase hostname without `www.`. */
export function companyHost(url:string):string {
 return hostOf(url).replace(/^www\./u,'');
}

const LIST_TITLE=/\b(?:top|best)\s+\d+\b|\b\d+\s+(?:top|best)\b|\b(?:top|best)\s+(?:[\p{L}&'-]+\s+){0,4}(?:property\s+)?(?:management\s+)?companies\b|\bcompanies\s+(?:in|near|serving)\b|\bdirectory\b|\blist\s+of\b/iu;
export type DiscoveryPageKind='company'|'list'|'noise';
/** Routes a search hit or stored record (ADR0034). A list page yields leads, never facts. */
export function classifyDiscoveryPage(input:{url:string;title:string}):DiscoveryPageKind {
 const host=hostOf(input.url);
 if(within(host,DISCOVERY_NONCOMPANY_DOMAINS)||/\.(?:gov|edu|mil)$/u.test(host))return 'noise';
 if(within(host,DISCOVERY_DIRECTORY_DOMAINS)||LIST_TITLE.test(input.title))return 'list';
 return 'company';
}
