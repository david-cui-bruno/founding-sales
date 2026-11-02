import type {ManualPhoneSnapshot} from './manualProspectPhone.ts';
import {admitPreparedPages} from './preparedPageAdmission.ts';
import {PREPARED_PHONE_HORIZON_MS} from './preparedPhoneSource.ts';
import {CONSUMER_EMAIL_DOMAINS} from '../outreach/consumerEmailDomains.ts';

/** One exact address a company published on its own admitted pages (ADR0035). Evidence, never contact permission. */
export interface PreparedEmailRoute {address:string;observationId:string;blockId:string;url:string;/** ms epoch: earliest page/capture/source deadline, at most seven days after retrieval. */expiresAt:number}
const ADDRESS=/\b[A-Z0-9._%+-]+@[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?)*\.[A-Z]{2,}\b/giu;
/** Wording that makes an address someone else's, an example or a suggestion, as supportedBusinessEmail refuses it. */
const NOT_THE_COMPANY=/\b(?:suggested|guess|example address|referral|vendor|web designer|website by|designed by|powered by|on behalf of|try emailing|testimonial)\b/iu;
const NOT_FOR_SALES=/^(?:no-?reply|do-?not-?reply|donotreply|mailer-daemon|webmaster|postmaster|abuse|privacy|legal|careers?|jobs?|hr|press|media|unsubscribe|billing|accounting|payroll|ap|ar)$/u;
const PREFERRED=['info','hello','contact','office','management','leasing','maintenance','support','admin','team','service','services','inquiries','properties','sales'];
const hostOf=(value:string|null):string|null=>{try{const url=new URL(value??'');return ['http:','https:'].includes(url.protocol)?url.hostname.toLowerCase().replace(/^www\./u,''):null;}catch{return null;}};

/** Each admitted page's own source deadline, as the prepared collection attached it; null when this snapshot never carried them. */
export function preparedSnapshotDeadlines(snapshot:ManualPhoneSnapshot):Map<string,number>|null{
 const recorded=snapshot['prepared_source_deadlines'];
 if(typeof recorded!=='object'||recorded===null||Array.isArray(recorded))return null;
 return new Map(Object.entries(recorded).flatMap(([url,at])=>typeof at==='number'?[[url,at] as const]:[]));
}
/** Never guessed: only a literal address, in a block of an admitted own-site page (shared admission rule: same host or the moved site,
 * hash-bound, unexpired), at the company's own host or the host that page was captured from. Consumer mailboxes and suggestion/vendor
 * wording are refused. Several published addresses: a role mailbox first, in a fixed order, then the first alphabetically. Caller reads
 * the snapshot through the prepared brief's collection, so `prepared_source_deadlines` bounds every page. */
export function preparedEmailRoute(snapshot:ManualPhoneSnapshot,now:number):PreparedEmailRoute|null{
 const deadlines=preparedSnapshotDeadlines(snapshot);
 if(!deadlines)return null;
 const admitted=admitPreparedPages(snapshot,now,deadlines),companyHost=hostOf(admitted.website);
 if(!companyHost)return null;
 const found=new Map<string,PreparedEmailRoute>();
 for(const {source,expires} of admitted.pages){
  const expiresAt=Math.min(Date.parse(source.retrievedAt)+PREPARED_PHONE_HORIZON_MS,admitted.captureDeadline??Infinity,expires??Infinity);
  if(!Number.isFinite(expiresAt)||expiresAt<=now)continue;
  const pageHost=hostOf(source.url);
  for(const block of source.blocks){
   if(block.text.length>2000||NOT_THE_COMPANY.test(block.text))continue;
   for(const match of block.text.matchAll(ADDRESS)){
    const address=match[0].toLowerCase(),[local,domain]=address.split('@');
    if(!local||!domain||CONSUMER_EMAIL_DOMAINS.has(domain)||NOT_FOR_SALES.test(local)||domain!==companyHost&&domain!==pageHost)continue;
    if(!found.has(address))found.set(address,{address,observationId:source.id,blockId:block.id,url:source.url,expiresAt});
   }
  }
 }
 const rank=(address:string)=>{const index=PREFERRED.indexOf(address.split('@')[0]!);return index<0?PREFERRED.length:index;};
 return [...found.values()].sort((a,b)=>rank(a.address)-rank(b.address)||a.address.localeCompare(b.address))[0]??null;
}
