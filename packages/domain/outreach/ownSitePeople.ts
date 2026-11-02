import {createHash} from 'node:crypto';
import type {PreparedPageText} from '../sourcing/preparedEmailRead.ts';
import {parseEmailAddress} from '../crm/routeValidation.ts';
import {OWN_SITE_PROVIDER,isExcludedTitle,personalAddressAtHost,rankDecisionMakerTitle,type PeopleProvider,type ProviderPerson} from './peopleProvider.ts';

/** ADR0037. Named decision-makers read from the company's OWN retained pages (the prepared capture's visible text blocks), deterministically: no
 * model, no network, no credit. A person is a NAME next to a decision-maker TITLE: "Name, Title" (team cards, bylines, the TX TREC and CA DRE licence footers
 * "Ryan Stetson, Broker", "Designated Broker ~ Ethan D. Autry TREC #"), "Title: Name", "Name is the Owner", or a name block directly followed by a title block.
 * A dash-led signature ("- Jon Smith, Owner / Broker") counts only with a company-side title (a bare "Owner" is as likely a customer's). An address is attached only
 * when the page publishes it for that person: in the same block, in the next blocks of the card, or in the person's own statement (never from elsewhere on the page); a role mailbox, another
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
/** What may wrap an address in running text: a MATCHED pair (brackets, quotes, curly quotes), trailing sentence punctuation and a leading `mailto:`. Nothing else is stripped: an unpaired leading or trailing character is the parser's to accept whole or refuse (`'jane@x.org` is never `jane@x.org`). */
const PAIRS:readonly (readonly [string,string])[]=[['(',')'],['[',']'],['<','>'],['"','"'],["'","'"],['“','”'],['‘','’']],SENTENCE_END=/[.,;:!?]+$/u;
const COMPANY_SIDE=/\b(?:broker|ceo|chief executive|president|founder|principal|property manager)\b/iu;
const CUSTOMER_WORDS=/\b(?:testimonials?|reviews?|reviewed|stars?|tenants?|residents?|renters?|clients?|customers?|homeowners?)\b/iu;
/** A heading that opens a section of what customers say: a person named under it is a customer or reviewer, whatever title follows (an "Owner" is as likely a customer's). */
const TESTIMONIAL_HEADING=/\b(?:testimonials?|reviews?|what (?:our |the |other )?(?:clients?|customers?|tenants?|owners?|residents?|landlords?|homeowners?|people|others|neighbors?)(?: are)? (?:say|saying)|(?:happy|satisfied) (?:clients?|customers?|tenants?|owners?|residents?|landlords?)|success stories|kind words)\b/iu;
/** A block that is the label of a person's role, never a section heading. */
const ROLE_LINE=/\b(?:agent|manager|assistant|administrator|coordinator|supervisor|specialist|accountant|bookkeeper|representative|associate|technician|owner|broker|director|president|founder|partner|officer|realtor|chairman|chairwoman|principal)\b/iu;
const SMALL_WORDS=new Set(['of','the','and','our','to','for','in','at','a','an','on','with','your','you','us','we','is','are','from','by','what','who','why','how','&']);
const SIGNATURE_LEAD=/(?:^|\s)[–—~-]\s*$/u;

interface Mention {key:string;firstName:string;lastName:string;title:string;rank:number;email:string|null;confidence:'high'|'medium';order:number;blockId:string;observationId:string;url:string;quote:string}
/** A section heading's words: a short line with no sentence punctuation (a trailing colon or bang aside), else null. */
const headingWords=(text:string):string|null=>{const bare=text.replace(/[:!]+$/u,'').trim();return bare.length>=3&&bare.length<=70&&!/[.,;?@"“”]/u.test(bare)?bare:null;};
/** A heading a testimonial section ends at: Title Case or ALL CAPS (never a customer's, a role's or a person's own line), so that a different heading demonstrably intervened. */
const endsTestimonials=(bare:string):boolean=>bare.split(/\s+/u).every(word=>SMALL_WORDS.has(word)||/^[\p{Lu}\d&]/u.test(word))&&/\p{Lu}/u.test(bare)&&!TESTIMONIAL_HEADING.test(bare)&&!CUSTOMER_WORDS.test(bare)&&!ROLE_LINE.test(bare)&&!(splitName(NAME_ONLY.exec(titleCase(bare))?.[1]??'')??null);
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
/** The COMPLETE mailbox literals of a text: each whitespace-delimited token that carries an `@`, trimmed of a matched wrapper pair, trailing sentence punctuation and a leading `mailto:` only, must parse whole as an address; a token that does not (`a(b@x.org`, `a@b.org,c@d.org`) is refused, and a suffix of a token is never rescanned (`jordan.o'connor@x.org` is never `connor@x.org`). */
const unwrapped=(token:string):string=>{
 for(let bare=token;;){
  const next=bare.replace(SENTENCE_END,'').replace(/^mailto:/iu,''),pair=PAIRS.find(([open,close])=>next.length>2&&next.startsWith(open)&&next.endsWith(close));
  const after=pair?next.slice(1,-1):next;
  if(after===bare)return bare;
  bare=after;
 }
};
const emailsIn=(text:string):string[]=>[...new Set(text.split(/\s+/u).flatMap(token=>{
 if(!token.includes('@'))return [];
 const parsed=parseEmailAddress(unwrapped(token));
 return parsed?[`${parsed.localPart}@${parsed.domain}`.toLowerCase()]:[];
}))];
/** A person's page address: valid at the company host and not a role or consumer mailbox. */
const personal=(addresses:readonly string[],host:string):string[]=>addresses.flatMap(address=>{const checked=personalAddressAtHost(address,host);return checked.ok?[checked.email]:[];});
const localOf=(address:string)=>address.slice(0,address.indexOf('@'));

/** `phrase` is the COMPLETE local title: the matched title plus the qualifier words joined to it ("Assistant" in "Assistant Property Manager: Jane", "Leasing Agent" in "Property Manager / Leasing Agent"). */
interface Hit {name:string;title:string;phrase:string;signature:boolean;quote:string;/** The text of THIS person's own statement: from where their statement starts to the next other named person or separator. */clause:string;/** No other named person (titled or not) appears in the block: the block's one address is then this person's. */alone:boolean}
const NAME_MENTION=new RegExp(`(?<![\\p{L}\\p{N}])(${NAME})(?![\\p{L}\\p{N}])`,'gu'),SEPARATOR=/[|•·©;]/gu;
/** One comma-separated clause of title qualifiers (at most three words) before or after the matched title: "Leasing Agent" in "Property Manager, Leasing Agent jane@…". */
const CLAUSE='[\\p{L}\'’®]+(?:[\\s/&+–—-]+[\\p{L}\'’®]+){0,2}';
const TAIL_CLAUSE=new RegExp(`^\\s*,\\s*(${CLAUSE})(?=[\\s,;:)|•·-]|$)`,'u'),HEAD_CLAUSE=new RegExp(`(?<![\\p{L}\\p{N}'’®@.])(${CLAUSE})\\s*,\\s*$`,'u');
/** The title qualifiers joined to the match by commas (any number of clauses): every clause that is itself a title, up to and including the first EXCLUDED one (which refuses the whole phrase); a clause that is neither (a name, a sentence) ends the scan, so a list of people is never one title. */
function commaClauses(text:string,side:'head'|'tail'):string{
 let rest=text,phrase='';
 for(let count=0;count<3;count++){
  const clause=(side==='tail'?TAIL_CLAUSE:HEAD_CLAUSE).exec(rest);
  if(!clause||!isExcludedTitle(clause[1]!)&&!TITLE_ONLY.test(clause[1]!))break;
  phrase=side==='tail'?`${phrase}, ${clause[1]!}`:`${clause[1]!}, ${phrase}`;
  rest=side==='tail'?rest.slice(clause[0].length):rest.slice(0,clause.index);
  if(isExcludedTitle(clause[1]!))break;
 }
 return phrase;
}
/** Every separator a name and a title are joined by (comma, dashes, bar, slash, colon, `&`, `and`) followed by a clause. */
const FOLLOWING_CLAUSE=new RegExp(`^\\s*(?:,|[–—|/:&-]|\\band\\b)\\s*(${CLAUSE})(?=[\\s,;:)|•·-]|$)`,'u');
/** After a title-first person's name (`Owner: Jane Doe`), a following clause that is an EXCLUDED title (`— Leasing Agent`, `| Leasing Agent`, `/ Leasing Agent`, `: Leasing Agent`) is the person's own title: the first title is not theirs. A following eligible title is compatible and does not veto; a clause that is no title ends the scan. */
function followedByExcludedTitle(rest:string):boolean{
 for(let count=0,left=rest;count<3;count++){
  const clause=FOLLOWING_CLAUSE.exec(left);
  if(!clause)return false;
  if(isExcludedTitle(clause[1]!))return true;
  if(!TITLE_ONLY.test(clause[1]!))return false;
  left=left.slice(clause[0].length);
 }
 return false;
}
const HEAD_WORDS=/(?<![\p{L}\p{N}'’®@.])(?:[\p{L}'’®]+[\s/&+–—-]+){1,3}$/u,TAIL_WORDS=/^(?:[\s/&+–—-]+[\p{L}'’®]+(?=[\s/&+–—,;:)|•·-]|$)){1,3}/u;
/** The statement around a match: its text between the nearest `|`, bullet or copyright marks, so a footer's citation is the line that names the person, not the whole footer. */
const statement=(text:string,start:number,end:number):string=>{
 const before=Math.max(text.lastIndexOf('|',start),text.lastIndexOf('•',start),text.lastIndexOf('·',start),text.lastIndexOf('©',start)),stops=[...'|•·©'].map(mark=>text.indexOf(mark,end)).filter(index=>index>=0);
 return tidy(text.slice(before+1,stops.length?Math.min(...stops):text.length));
};
/** The named people of a text (two or more name words), by position: every person the block names, whatever their title, so an excluded "Jane Doe, Office Administrator" counts as another person. */
const namesIn=(text:string):{start:number;end:number;key:string}[]=>[...text.matchAll(NAME_MENTION)].flatMap(match=>{const person=splitName(match[1]!);return person?[{start:match.index,end:match.index+match[0].length,key:person.key}]:[];});
function hitsIn(block:string):Hit[]{
 const text=titleCase(block),hits:Hit[]=[],names=namesIn(text),owned:{start:number;end:number}[]=[];
 // Name-first readings are resolved before title-first ones (a title is one person's): `NAME_TITLE` and `NAME_IS_TITLE` own their title span.
 for(const pattern of [NAME_TITLE,NAME_IS_TITLE,TITLE_NAME]){
  pattern.lastIndex=0;
  for(const match of text.matchAll(pattern)){
   const [name,title]=pattern===TITLE_NAME?[match[2]!,match[1]!]:[match[1]!,match[2]!];
   const start=match.index,end=start+match[0].length;
   if(pattern===TITLE_NAME){
    // A title-first reading ("Owner, Ann Roe") is refused when its title is already a name-first person's ("Jane Doe, Owner, Ann Roe"), or when any separator after the name is followed by an EXCLUDED title (`Owner: Jane Doe — Leasing Agent`, `| Leasing Agent`, `/`, `:`, `,`): that title is the person's own and refuses them. An eligible following title does not veto.
    const titleEnd=start+title.length;
    if(owned.some(span=>start<span.end&&span.start<titleEnd)||followedByExcludedTitle(text.slice(end)))continue;
   }else owned.push({start:end-title.length,end});
   const words=pattern===TITLE_NAME?`${HEAD_WORDS.exec(text.slice(0,start))?.[0]??''}${title}`:`${title} ${TAIL_WORDS.exec(text.slice(end))?.[0]??''}`,phrase=pattern===TITLE_NAME?`${commaClauses(text.slice(0,start-(HEAD_WORDS.exec(text.slice(0,start))?.[0].length??0)),'head')} ${words}`:`${words}${commaClauses(text.slice(end+(TAIL_WORDS.exec(text.slice(end))?.[0].length??0)),'tail')}`;
   const own=splitName(name)?.key,others=names.filter(other=>other.key!==own&&(other.end<=start||other.start>=end)),after=[...others.filter(other=>other.start>=end).map(other=>other.start),...[...text.matchAll(SEPARATOR)].map(mark=>mark.index).filter(index=>index>=end)];
   hits.push({name:tidy(name),title:tidy(title),phrase:tidy(phrase),signature:pattern===NAME_TITLE&&SIGNATURE_LEAD.test(text.slice(0,start)),quote:statement(text,start,end),clause:text.slice(start,after.length?Math.min(...after):text.length),alone:others.length===0});
  }
 }
 return hits;
}

/** Every mention of a decision-maker on the pages, in page and block order, each with the address its own blocks publish for that person (if any). */
function mentionsOf(pages:readonly PreparedPageText[],host:string):Mention[]{
 const found:Mention[]=[];let order=0;
 for(const page of pages){
  const blocks=page.blocks.map(block=>({id:block.id,text:tidy(block.text)}));
  const push=(raw:{name:string;title:string;phrase?:string;signature:boolean},block:string,quote:string,context:string,emails:string[],adjacent:boolean,alone:boolean)=>{
   const person=splitName(raw.name),rank=rankDecisionMakerTitle(raw.title);
   // The customer veto reads the whole untrimmed block (never the citation trimmed to one `|` cell), the title veto the complete local title phrase.
   if(!person||rank===null||isExcludedTitle(raw.phrase??raw.title)||CUSTOMER_WORDS.test(context)||raw.signature&&!COMPANY_SIDE.test(raw.title)||raw.name.length>60)return;
   const mine=personal(emails,host),pool=adjacent||!alone?mine.filter(address=>belongsTo(localOf(address),person)):mine.length===1?mine:mine.filter(address=>belongsTo(localOf(address),person));
   found.push({...person,title:raw.title,rank,email:pool[0]??null,confidence:raw.signature?'medium':'high',order:order++,blockId:block,observationId:page.observationId,url:page.url,quote:tidy(quote).slice(0,500)});
  };
  let testimonial=false;
  for(let i=0;i<blocks.length;i++){
   const block=blocks[i]!;if(block.text.length<5)continue;
   const hits=block.text.length<=600?hitsIn(block.text):[],heading=hits.length?null:headingWords(block.text);
   // A testimonial heading marks every person under it as a customer until a DIFFERENT heading intervenes; an order that shows none refuses (the section state is per page).
   if(heading!==null){if(TESTIMONIAL_HEADING.test(heading))testimonial=true;else if(endsTestimonials(heading))testimonial=false;}
   if(testimonial)continue;
   if(hits.length){for(const hit of hits)push(hit,block.id,hit.quote,block.text,emailsIn(hit.alone?block.text:hit.clause),false,hit.alone);continue;}
   // A team card: a block that is only a name, directly followed by a block that is only a title; the card's following blocks may carry the address.
   const name=block.text.length<=60?NAME_ONLY.exec(titleCase(block.text.replace(/[:,]$/u,'')))?.[1]:undefined,next=blocks[i+1];
   const title=name&&next&&next.text.length<=90?TITLE_ONLY.exec(titleCase(next.text))?.[1]:undefined;
   if(!name||!next||!title)continue;
   const tail:string[]=[next.text];
   for(const later of blocks.slice(i+2,i+4)){if(NAME_ONLY.test(titleCase(later.text))||hitsIn(titleCase(later.text)).length)break;tail.push(later.text);}
   const card=[block.text,...tail.filter(text=>text.length<=160)].join(' / ');
   push({name,title,signature:false},block.id,card,card,tail.flatMap(text=>emailsIn(text)),true,true);
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
