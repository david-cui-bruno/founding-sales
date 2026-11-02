import {createHash} from 'node:crypto';
import type {PreparedPageText} from '../sourcing/preparedEmailRead.ts';
import {OWN_SITE_PROVIDER,personalAddressAtHost,rankDecisionMakerTitle,type PeopleProvider,type ProviderPerson} from './peopleProvider.ts';

/** ADR0037. Named decision-makers read from the company's OWN retained pages (the prepared capture's visible text blocks), deterministically: no
 * model, no network, no credit. A person is a NAME next to a decision-maker TITLE: "Name, Title" (team cards, bylines, the TX TREC and CA DRE licence footers
 * "Ryan Stetson, Broker", "Designated Broker ~ Ethan D. Autry TREC #"), "Title: Name", "Name is the Owner", or a name block directly followed by a title block.
 * A dash-led signature ("- Jon Smith, Owner / Broker") counts only with a company-side title (a bare "Owner" is as likely a customer's). An address is attached only
 * when the page publishes it for that person: in the same block, in the next blocks of the card, or in a line that names the person; a role mailbox, another
 * domain and a consumer domain never are, and an address is never built from a name. The capture keeps visible text only: JSON-LD, <title> and mailto
 * targets are not in it, so a person published only there is not found. */
export interface OwnSiteFinding {firstName:string;lastName:string;title:string;rank:number;email:string|null;confidence:'high'|'medium';source:{observationId:string;url:string;blockId:string;quote:string}}

const WORD="\\p{Lu}(?:['’]\\p{Lu})?\\p{Ll}+(?:\\p{Lu}\\p{Ll}+)?(?:-\\p{Lu}\\p{Ll}+)?";
const STOP='(?:Owner|Co|Founder|President|Chairman|Chairwoman|Principal|Broker|Designated|Managing|Qualifying|Property|Manager|Director|Realtor|Licensed|Senior|General|Partner|Associate|Assistant|Leasing|Chief|Executive|Vice|Acting|Operations|Sales|Agent|Team|Our|Meet|Contact|Management|Properties|Realty|Real|Estate|Group|Company|Services|Associates|Rentals|Homes|Welcome|Email|Call|Texas|California|License|Licence|Licensed|Phone|Office|Staff|Leadership|About|Home|Tenant|Tenants|Owners|Residents|Why|Learn|Read|More|Get|Started|Fair|Housing|Equal|Opportunity|Privacy|Policy|Terms|All|Rights|Reserved|Copyright|Click|Here|Apply|Pay|Rent|Maintenance|Request|Login|Portal|Hours|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|San|Los|Las|New|North|South|East|West|Fort|Port|Saint|Mount|Lake|Beach|Palm|Grand|Little|Big|Great|Greater|Metro|Central|Downtown|Valley|City|County|Area|Local|Premier|Professional|Trusted|Quality|Residential|Commercial|Investment|Investor|Investors|Landlord|Landlords|Mortgage|Insurance|Rock|Round|Salt|Golden)';
/** Makes the letters of a literal regex fragment case-insensitive, so names (case-sensitive: a capital starts each word) and titles (any case) share one pattern. */
const ci=(fragment:string):string=>fragment.replace(/(?<!\\)[A-Za-z]/gu,letter=>`[${letter.toUpperCase()}${letter.toLowerCase()}]`);
const TOKEN=`(?!${STOP}\\b)${WORD}`,NICK='(?:["“(]\\p{Lu}\\p{Ll}+["”)])',INITIAL='\\p{Lu}\\.';
const NAME=`(?:${INITIAL}\\s+){0,2}${TOKEN}(?:\\s+(?:${NICK}|${INITIAL}|${TOKEN})){0,3}(?:\\s+(?:Jr\\.?|Sr\\.?|II|III|IV))?`;
const TITLE_WORD=ci('(?:\\(Acting\\)\\s*)?(?:Co-?Owners?|Owners?|Co-?Founders?|Founders?|Presidents?|CEO|Chief Executive Officer|Chairman|Chairwoman|Principal Broker|Principals?|Designated Broker|Managing Broker|Qualifying Broker|Broker of Record|Broker[- ]in[- ]Charge|Brokers?|Managing (?:Partner|Director|Member)|Partner|(?:Licensed |Senior |Lead )?Property Manager|Director of Property Management|Realtor®?|General Manager|Operations? Manager|COO|CFO|CIO|CPM|RMP|CCIM|ARM|EVP|SVP|VP|Vice President(?: of Property Management)?)');
const TITLE=`${TITLE_WORD}(?:\\s*(?:,|/|&|\\+|\\band\\b|-|–|—|\\|)\\s*${TITLE_WORD})*`;
const LICENCE=`(?:${ci('TREC|DRE|CABRE|CalBRE|BRE|Licen(?:s|c)e|Lic\\b|Texas|California|TX\\b|CA\\b')}|#)`;
const AFTER=`(?![\\p{L}\\p{N}])(?=$|\\s*[,.;:)|•·–—~(\\[#/]|\\s+(?:${LICENCE}|\\d|${ci('E-?mail|Phone|Call|Tel|Mobile|Cell|Direct|Ext\\b')}|[\\w.+-]+@))`;
const NAME_TITLE=new RegExp(`(?<![\\p{L}\\p{N}])(${NAME})(?:\\s*,\\s*|\\s+[–—-]\\s+|\\s*[–—]\\s*|\\s*\\|\\s*|\\s*:\\s*|\\s*\\(\\s*|\\s+)(${TITLE})${AFTER}`,'gu');
const TITLE_NAME=new RegExp(`(?<![\\p{L}\\p{N}])(${TITLE})\\s*(?:~|:|–|—|\\s-\\s|,)\\s*(${NAME})(?![\\p{L}\\p{N}])(?=$|\\s*[,.;:)|•·–—~(\\[#/]|\\s+-\\s|\\s+${LICENCE})`,'gu');
const NAME_IS_TITLE=new RegExp(`(?<![\\p{L}\\p{N}])(${NAME})\\s+(?:is|serves as|has been|was)\\s+(?:the|our|a|an)\\s+(?:current\\s+)?(${TITLE})${AFTER}`,'gu');
const NAME_ONLY=new RegExp(`^(${NAME})\\.?$`,'u'),TITLE_ONLY=new RegExp(`^(${TITLE})(?:\\s*,?\\s*(?:${LICENCE}.*)?)?$`,'u');
const EMAIL=/[A-Za-z0-9][A-Za-z0-9._%+-]*@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/gu;
const COMPANY_SIDE=/\b(?:broker|ceo|chief executive|president|founder|principal|property manager)\b/iu;
const CUSTOMER_WORDS=/\b(?:testimonials?|reviews?|reviewed|stars?|tenants?|residents?|renters?|clients?|customers?|homeowners?)\b/iu;
const SIGNATURE_LEAD=/(?:^|\s)[–—~-]\s*$/u;

interface Mention {key:string;firstName:string;lastName:string;title:string;rank:number;email:string|null;confidence:'high'|'medium';order:number;blockId:string;observationId:string;url:string;quote:string}
const tidy=(text:string):string=>text.replace(/\s+/gu,' ').trim();
const titleCase=(text:string):string=>text===text.toUpperCase()&&/\p{L}/u.test(text)?text.toLowerCase().replace(/(^|[\s'’/|,–—-])(\p{L})/gu,(_m,lead:string,letter:string)=>`${lead}${letter.toUpperCase()}`).replace(/\b(?:Ceo|Coo|Cfo|Cio|Cpm|Rmp|Ccim|Arm|Evp|Svp|Vp|Dre|Trec|Tx|Ca)\b/gu,acronym=>acronym.toUpperCase()):text;
/** First name (the nickname in quotes or parentheses wins: "William "Hoss" Evey" is Hoss), last name (the last word, with a Jr/III suffix) and a key that ignores middle names. */
function splitName(raw:string):{firstName:string;lastName:string;key:string}|null{
 const nick=/["“(](\p{Lu}\p{Ll}+)["”)]/u.exec(raw)?.[1],suffix=/\b(Jr\.?|Sr\.?|II|III|IV)\s*$/u.exec(raw)?.[1],words=raw.replace(/["“(][^"”)]*["”)]/gu,' ').replace(/\b(?:Jr\.?|Sr\.?|II|III|IV)\s*$/u,'').split(/\s+/u).filter(word=>/^\p{Lu}['’\p{L}]/u.test(word));
 if(words.length<2)return null;
 const firstName=nick??words[0]!,last=words.at(-1)!,lastName=suffix?`${last} ${suffix}`:last;
 return {firstName,lastName,key:`${words[0]!.toLowerCase()} ${last.toLowerCase()}`};
}
const letters=(value:string)=>value.toLowerCase().replace(/[^\p{L}]/gu,'');
/** The address is plausibly this person's: its local part carries their first name, nickname or last name (or a prefix of the first name of three letters), as `doc@`, `jlasley@`, `ben@`, `kyle.wheatley@`. */
function belongsTo(local:string,person:{firstName:string;lastName:string;key:string}):boolean{
 const mailbox=letters(local),first=letters(person.key.split(' ')[0]!),nick=letters(person.firstName),last=letters(person.lastName.replace(/\b(?:Jr|Sr|II|III|IV)\.?$/u,''));
 return [first,nick].some(name=>name.length>=3&&(mailbox.includes(name)||name.startsWith(mailbox)&&mailbox.length>=3))||last.length>=3&&mailbox.includes(last);
}
const emailsIn=(text:string):string[]=>[...new Set((text.match(EMAIL)??[]).map(address=>address.replace(/\.+$/u,'').toLowerCase()))];
/** A person's page address: valid at the company host and not a role or consumer mailbox. */
const personal=(addresses:readonly string[],host:string):string[]=>addresses.flatMap(address=>{const checked=personalAddressAtHost(address,host);return checked.ok?[checked.email]:[];});
const localOf=(address:string)=>address.slice(0,address.indexOf('@'));

interface Hit {name:string;title:string;signature:boolean;quote:string}
/** The statement around a match: its text between the nearest `|`, bullet or copyright marks, so a footer's citation is the line that names the person, not the whole footer. */
const statement=(text:string,start:number,end:number):string=>{
 const before=Math.max(text.lastIndexOf('|',start),text.lastIndexOf('•',start),text.lastIndexOf('·',start),text.lastIndexOf('©',start)),stops=[...'|•·©'].map(mark=>text.indexOf(mark,end)).filter(index=>index>=0);
 return tidy(text.slice(before+1,stops.length?Math.min(...stops):text.length));
};
function hitsIn(block:string):Hit[]{
 const text=titleCase(block),hits:Hit[]=[];
 for(const pattern of [NAME_TITLE,TITLE_NAME,NAME_IS_TITLE]){
  pattern.lastIndex=0;
  for(const match of text.matchAll(pattern)){
   const [name,title]=pattern===TITLE_NAME?[match[2]!,match[1]!]:[match[1]!,match[2]!];
   hits.push({name:tidy(name),title:tidy(title),signature:pattern===NAME_TITLE&&SIGNATURE_LEAD.test(text.slice(0,match.index)),quote:statement(text,match.index,match.index+match[0].length)});
  }
 }
 return hits;
}

/** Every mention of a decision-maker on the pages, in page and block order, each with the address its own blocks publish for that person (if any). */
function mentionsOf(pages:readonly PreparedPageText[],host:string):Mention[]{
 const found:Mention[]=[];let order=0;
 for(const page of pages){
  const blocks=page.blocks.map(block=>({id:block.id,text:tidy(block.text)}));
  const push=(raw:{name:string;title:string;signature:boolean},block:string,quote:string,emails:string[],adjacent:boolean,soleHit:boolean)=>{
   const person=splitName(raw.name),rank=rankDecisionMakerTitle(raw.title);
   if(!person||rank===null||CUSTOMER_WORDS.test(quote)||raw.signature&&!COMPANY_SIDE.test(raw.title)||raw.name.length>60)return;
   const mine=personal(emails,host),pool=adjacent||!soleHit?mine.filter(address=>belongsTo(localOf(address),person)):mine.length===1?mine:mine.filter(address=>belongsTo(localOf(address),person));
   found.push({...person,title:raw.title,rank,email:pool[0]??null,confidence:raw.signature?'medium':'high',order:order++,blockId:block,observationId:page.observationId,url:page.url,quote:tidy(quote).slice(0,500)});
  };
  for(let i=0;i<blocks.length;i++){
   const block=blocks[i]!;if(block.text.length<5)continue;
   const hits=block.text.length<=600?hitsIn(block.text):[];
   if(hits.length){for(const hit of hits)push(hit,block.id,hit.quote,emailsIn(block.text),false,hits.length===1);continue;}
   // A team card: a block that is only a name, directly followed by a block that is only a title; the card's following blocks may carry the address.
   const name=block.text.length<=60?NAME_ONLY.exec(titleCase(block.text.replace(/[:,]$/u,'')))?.[1]:undefined,next=blocks[i+1];
   const title=name&&next&&next.text.length<=90?TITLE_ONLY.exec(titleCase(next.text))?.[1]:undefined;
   if(!name||!next||!title)continue;
   const tail:string[]=[next.text];
   for(const later of blocks.slice(i+2,i+4)){if(NAME_ONLY.test(titleCase(later.text))||hitsIn(titleCase(later.text)).length)break;tail.push(later.text);}
   push({name,title,signature:false},block.id,[block.text,...tail.filter(text=>text.length<=160)].join(' / '),tail.flatMap(emailsIn),true,true);
  }
 }
 // A line that names the person and publishes their address (any page): "Email Bob at bob@example.com". Attached only to a person with no address yet.
 for(const page of pages)for(const block of page.blocks){
  const text=tidy(block.text),addresses=personal(emailsIn(text),host);
  if(!addresses.length||text.length>300)continue;
  for(const mention of found){
   if(mention.email!==null)continue;
   const address=addresses.find(candidate=>belongsTo(localOf(candidate),mention)),first=letters(mention.key.split(' ')[0]!),words=new Set(text.replace(EMAIL,' ').toLowerCase().split(/[^\p{L}]+/u));
   if(address&&[first,letters(mention.firstName),letters(mention.lastName)].some(name=>name.length>=3&&words.has(name))){mention.email=address;mention.confidence='medium';mention.quote=tidy(`${mention.quote} … ${page.url===mention.url?'':`${page.url}: `}${text}`).slice(0,600);}
  }
 }
 return found;
}

/** The company's named decision-makers, best first: a person with a published address before one without (the campaign needs an address), then by title
 * rank (owner; president, CEO, founder, principal; designated or managing broker; broker; property manager), then page order. One entry per person: the
 * mention that carries the address and the best title. */
export function extractOwnSitePeople(pages:readonly PreparedPageText[],host:string):OwnSiteFinding[]{
 const best=new Map<string,Mention>();
 for(const mention of mentionsOf(pages,host)){
  const current=best.get(mention.key);
  if(!current||Number(mention.email!==null)>Number(current.email!==null)||Number(mention.email!==null)===Number(current.email!==null)&&mention.rank<current.rank)best.set(mention.key,mention);
 }
 return [...best.values()].sort((a,b)=>Number(b.email!==null)-Number(a.email!==null)||a.rank-b.rank||a.order-b.order).map(mention=>({firstName:mention.firstName,lastName:mention.lastName,title:mention.title,rank:mention.rank,email:mention.email,confidence:mention.confidence,source:{observationId:mention.observationId,url:mention.url,blockId:mention.blockId,quote:mention.quote}}));
}

/** ADR0037. The people source that reads the company's own retained pages: no request, no key, no credit (`maxCreditsPerLookup` 0), so no daily cap applies. Its
 * person is `published` when the company's own page published a personal address for them, else `unavailable` (named, not emailable: Calling shows them). */
export function ownSitePeople():PeopleProvider{
 return {providerKey:OWN_SITE_PROVIDER,maxCreditsPerLookup:0,findDecisionMaker:async({domain,pages})=>{
  const top=extractOwnSitePeople(pages,domain)[0];
  if(!top)return {ok:true,person:null,creditsUsed:0};
  const person:ProviderPerson={providerPersonId:`site:${createHash('sha256').update(`${top.firstName} ${top.lastName}`.toLowerCase()).digest('hex').slice(0,24)}`,firstName:top.firstName,lastName:top.lastName,title:top.title,email:top.email,emailStatus:top.email===null?'unavailable':'published',matchConfidence:top.confidence,source:top.source};
  return {ok:true,person,creditsUsed:0};
 }};
}
