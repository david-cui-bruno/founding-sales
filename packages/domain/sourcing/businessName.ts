import {US_BUSINESS_REGIONS,US_BUSINESS_STATE_NAMES} from '../../contracts/src/usBusinessGeography.ts';
import {DISCOVERY_QUERIES} from './discoveryQueries.ts';

/** The ONE business-name resolver for prepared email (ADR0035): the name a prospect sees ("Hi {name} team") and the Firm's name. Pure.
 * A stored company name is a search-result title (`title`) or a place record's name (`place`, Overture). The capture keeps visible text
 * blocks only (`<title>`, meta tags and JSON-LD are dropped by `parsePageText`), so no structured site name exists to prefer; the sources are
 * the stored name's brand segment, then the company's own footer ©-line. A name that is only location and service words ("Denton TX Property
 * Management", "Dallas-Fort Worth Property Management") names no business: null, and the company is not email-admissible. Never guessed. */
export interface BusinessNameInput {name:string;source:'title'|'place';locality:string;/** The discovery query that found the company, when recorded. */query?:string|undefined;host:string;/** Visible text blocks of the company's admitted own-site pages. */blocks?:readonly string[]}
const words=(text:string):string[]=>text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
// Service, offer, filler and legal-form words that name no company on their own.
const GENERIC=new Set(words(`property properties management manager managers mgmt service services company companies co residential commercial rental rentals rent renters real estate realty home homes house houses housing leasing lease hoa association associations community communities apartment apartments condo condos
 professional full best top local trusted affordable premier quality expert experts leading reliable your our my we you the a an and of in for to from at with by on near me cash buyer buyers buy sell selling sale fast free quote get call now today welcome homepage page official site website firm group team associates advisors solutions
 llc inc corp corporation ltd lp llp pllc pc`));
const LEGAL_FORM=/(?:^|\s)(?:LLC|L\.L\.C\.?|Inc|Incorporated|Corp|Corporation|Ltd|LP|LLP|PLLC)\.?$/iu;
const PREPOSITION=new Set(['in','for','serving','near','from']);
const STATE_CODE=`(?:${US_BUSINESS_REGIONS.join('|')})`,STATE_NAME=`(?:${Object.values(US_BUSINESS_STATE_NAMES).join('|')})`;
// A state in a title ends a place: "Denton TX", "Cambridge, MA", "Brookline, Massachusetts". The capitalised words before it are the place.
const STATE=new RegExp(`(?<=[\\p{L}\\p{N}&]),?\\s+(?:${STATE_CODE}(?![\\p{L}\\p{N}])|(?:${STATE_NAME})(?![\\p{L}\\p{N}]))`,'gu');
const MARKER='§';
// A state is a place only in a title (marked above); a place record's "… Of Texas" is part of the business's own name.
const STATE_WORDS=new Set(Object.values(US_BUSINESS_STATE_NAMES).flatMap(words));
const placeWords=(text:string)=>words(text).filter(word=>!GENERIC.has(word)&&!STATE_WORDS.has(word));
const catalogue=new Set(DISCOVERY_QUERIES.flatMap(entry=>[...placeWords(entry.locality),...placeWords(entry.query)]));
const clean=(text:string)=>text.replace(/\s+/gu,' ').replace(/^[\s,.;:|–—•·-]+|[\s,;:|–—•·-]+$/gu,'').trim();
const trimTail=(text:string)=>text.replace(/[\s,;:|–—•·-]+$/u,'');
interface Token {raw:string;at:number;kind:'brand'|'place'|'glue'}
/** One segment of a name classified token by token. Returns the segment without a trailing "in|for|serving <place>" tail, or null when no distinctive word is left. */
function brandSegment(segment:string,place:ReadonlySet<string>,source:'title'|'place'):string|null{
 const marked=source==='title'?segment.replace(STATE,` ${MARKER}`):segment,tokens:Token[]=[];
 for(const match of marked.matchAll(/[^\s,]+/gu)){
  const raw=match[0],low=raw.replace(/[.]+$/u,'').toLowerCase(),parts=low.split('-').flatMap(words);
  tokens.push({raw,at:match.index,kind:raw===MARKER||parts.length>0&&parts.every(part=>place.has(part))?'place':!/\p{L}/u.test(raw)||parts.every(part=>GENERIC.has(part))?'glue':'brand'});
 }
 // A state marker makes the capitalised, non-generic words before it a place (an unlisted city), and a preposition makes the capitalised words after it one.
 const capital=(token:Token|undefined)=>token!==undefined&&token.kind==='brand'&&/^\p{Lu}/u.test(token.raw);
 tokens.forEach((token,index)=>{
  if(token.raw===MARKER)for(let back=index-1,count=0;capital(tokens[back])&&count<3;back--,count++)tokens[back]!.kind='place';
  if(PREPOSITION.has(token.raw.toLowerCase()))for(let next=index+1,count=0;capital(tokens[next])&&count<4;next++,count++)tokens[next]!.kind='place';
 });
 if(!tokens.some(token=>token.kind==='brand'))return null;
 let cut=tokens.length;
 while(cut>0&&tokens[cut-1]!.kind!=='brand')cut--;
 // Only a preposition-led tail is removed ("Brubaker Property Management in Frisco, TX"); a bare trailing word stays part of the name.
 const tail=tokens.slice(cut),lead=tail.findIndex(token=>PREPOSITION.has(token.raw.toLowerCase()));
 const end=lead>=0?tail[lead]!.at:marked.length;
 return clean(marked.slice(0,end).replace(new RegExp(`\\s*${MARKER}`,'gu'),''))||null;
}
// The host's name without its last label (the suffix), so "com" or "net" in a vendor's name never matches.
const matchesHost=(name:string,host:string)=>words(name).some(word=>word.length>=3&&!GENERIC.has(word)&&host.toLowerCase().replace(/\.[^.]+$/u,'').replace(/[^a-z0-9]/gu,'').includes(word));
function brandOf(name:string,place:ReadonlySet<string>,source:'title'|'place',host:string):string|null{
 const original=clean(name);
 // A place record whose name ends in a legal form ("El Paso Renters LLC") is a registered business name even when its other words are generic.
 if(source==='place'&&LEGAL_FORM.test(original)&&words(original).length>=2)return original.slice(0,300);
 // A title cut off by the search provider ("… From the ...") has no reliable last part.
 const truncated=/(?:\.\.\.|…)$/u.test(original);
 let segments=original.split(/\s+[|–—•·-]\s+|\s*[|–—•·]\s*/u).map(clean).filter(Boolean);
 if(truncated)segments=segments.slice(0,-1);
 const brands=segments.flatMap(segment=>brandSegment(segment,place,source)??[]).filter((brand,index,all)=>all.findIndex(other=>other.toLowerCase()===brand.toLowerCase())===index);
 // Several different brand-looking parts are ambiguous ("Brand | Other Co"): only the one that shares a word with the company's host stands.
 const chosen=brands.length===1?brands:brands.filter(brand=>matchesHost(brand,host));
 return chosen.length===1?chosen[0]!.slice(0,300):null;
}
const COPYRIGHT=/(?:©|\(c\)|\bcopyright\b)\s*(?:©\s*)?(?:\d{4}(?:\s*[-–]\s*\d{4})?)?\s*[,.:|-]?\s*(.+)/iu;
const FOOTER_CUT=/\s*(?:[|•·–—]|\.\s+(?=\p{Lu})|\ball rights\b|\bprivacy\b|\bterms\b|\bpowered by\b|\bwebsite by\b|\bsite by\b|\bdesigned by\b|\bbuilt by\b|\bequal housing\b|\blicen[sc]e).*$/iu;
/** The company's own ©-line: the name that must share a word with the company's host, so a template or software vendor's line is no name. */
function footerBrand(blocks:readonly string[],place:ReadonlySet<string>,host:string):string|null{
 for(const block of blocks){
  if(block.length>300)continue;
  const found=COPYRIGHT.exec(block)?.[1];if(found===undefined)continue;
  const candidate=trimTail(found.replace(FOOTER_CUT,'')).replace(/\.$/u,'').trim(),brand=candidate.length>=3&&candidate.length<=80?brandOf(candidate,place,'title',host):null;
  if(brand&&matchesHost(brand,host))return brand;
 }
 return null;
}
export function resolveBusinessName(input:BusinessNameInput):string|null{
 const place=new Set([...catalogue,...placeWords(input.locality),...placeWords(input.query??'')]);
 return brandOf(input.name,place,input.source,input.host)??footerBrand(input.blocks??[],place,input.host);
}
