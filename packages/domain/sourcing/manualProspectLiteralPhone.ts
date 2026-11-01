import {createHash} from 'node:crypto';
import {sourceObservationSchema,prospectPhoneObservationSchema,PROSPECT_PHONE_CAPTURE_LIMITS,type ManualProspect,type SourceObservation} from '@fss/contracts';
import {canonicalizePhone} from '../src/rules/suppressionCanonicalization.ts';

type Evidence=NonNullable<ManualProspect['phoneEvidence']>;
export type LiteralSource=Extract<Extract<Evidence,{state:'observed'}>['sources'][number],{method:string}>;
export type LiteralAuthority=LiteralSource['authority'];
export type LiteralLineage=LiteralSource['lineage'];
export type LiteralDiagnostics=NonNullable<Extract<Evidence,{state:'conflicting'}>['diagnostics']>;
/** `moved`: prepared-capture observations admitted on the company site's moved host (ADR0034); only these may differ from `website`. */
export interface LiteralInput {runId:string;observations:unknown;website:string|null;authorities:Record<string,LiteralAuthority>;lineage:LiteralLineage;now:number;partial?:boolean;moved?:ReadonlySet<string>}
export interface LiteralScan {sources:LiteralSource[];coverage:NonNullable<Evidence['coverage']>;unresolved:boolean;diagnostics?:LiteralDiagnostics;reason?:'original_not_usable'|'bounded_scan_incomplete'}
/** v2 extends v1 (ADR0034) with verb attachment before prose and standalone published
 * numbers; every v1-accepted span is unchanged. Evidence is recomputed per read, never stored. */
export const MANUAL_LITERAL_PHONE_PARSER='manual-literal-phone-v2' as const;
const parser=MANUAL_LITERAL_PHONE_PARSER;
const host=(value:string|null)=>{try{const url=new URL(value??'');return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password?url.hostname.toLowerCase().replace(/^www\./u,''):null;}catch{return null;}};
// Labels, not arbitrary prose, introduce a phone-bearing segment in one block.
// Stored choices keep v1 label offsets: v2 verbs never cover a v1 label (`Please call us`
// keeps the v1 `call us` span), so v2 only adds labels where v1 found none.
const labels=/\b(?:office\s+phone|main\s+phone|mobile(?:\s+phone)?|personal(?:\s+phone)?|emergency(?:\s+phone)?|fax|telephone|phone|tel|call\s+us|please\s+call(?!\s+us\b)|call)\b/giu;
// v2 forms apply only where no other line or purpose is mentioned anywhere in the block.
const otherLine=/\b(?:fax(?:es)?|mobile|cell(?:ular|s)?|emergenc(?:y|ies)|text(?:s|ing)?|sms|personal|vendor|powered\s+by|website\s+by|testimonial|customer\s+review)\b/iu;
/** v2-only labels (call verbs, phone emoji) attach nothing in a block naming another line or purpose. */
export const V2_ONLY_PHONE_LABEL=/^(?:please\s+call|call|📞|☎\uFE0F?)$/iu;
export function phoneBlockAllowsV2(text:string):boolean{return !otherLine.test(text);}
// A bare call verb is a label only when one literal follows directly (`call 202…`, `please call: 202…`).
const verbOnly=/^(?:please\s+call|call)$/iu,verbAttached=/^\s*:?\s*(?:at\s*:?\s*)?[+\p{N}(]/iu;
// v2: these labels keep one directly attached literal before ordinary sentence prose.
const proseLabels=/^(?:call(?:\s+us)?|please\s+call|phone|tel|telephone)$/iu;
// v2 standalone block: optional phone emoji/punctuation, one formatted NANP literal, optional one email.
const standalonePrefix=/^[\s:•|–—-]*(?:(?:📞|☎)\uFE0F?[\s:•|–—-]*)?$/u,standaloneEmail=/\s+[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\s*$/iu;
const nanp=/^(?:\+?1[ .-])?(?:\(\d{3}\)\s?|\d{3}[ .-])\d{3}[ .-]\d{4}$/u;
// Vanity and extension forms are retained as unsupported WHOLE literals. Never
// accept their numeric prefix as a business endpoint. No cross-block stitching.
const tokens=/\+?[\p{N}(][\p{N}(). \t-]*\p{N}(?:[ \t]*(?:ext(?:ension)?\.?|x|#)[ \t]*[\p{L}\p{N}]+|-?[\p{L}\p{N}-]+)?/giu;
/** Human selection must still cover the whole token, including unsupported suffixes. */
export function isWholeManualPhoneLiteral(text:string,start:number,end:number):boolean{
 return [...text.matchAll(tokens)].some(token=>token.index===start&&token.index+token[0].trimEnd().length===end);
}
/** Consume only explicitly attached literals. Unmatched prose/fields/residue
 * makes the segment unresolved, never a license to search later identifiers.
 * Unicode/vanity tokens are retained but do NOT extend the supported grammar. */
function attachedLiterals(segment:string,prose:boolean):{matches:RegExpExecArray[];complete:boolean}{
 const matches:RegExpExecArray[]=[];let cursor=0;
 for(const token of segment.matchAll(tokens)){
  const gap=segment.slice(cursor,token.index);
  const connector=matches.length===0?/^\s*(?::|[.-])?\s*(?:at\s+)?$/iu:/^\s*(?:[/,;&]|and|or)?\s*$/iu;
  if(!connector.test(gap))return {matches,complete:false};
  matches.push(token);cursor=token.index+token[0].length;
 }
 const rest=segment.slice(cursor);
 // v2 prose tail: exactly one literal, then a separator and digit-free prose.
 return {matches,complete:/^[\s.,;]*$/u.test(rest)||prose&&matches.length===1&&/^[\s,.;!]/u.test(rest)&&!/\p{N}/u.test(rest)};
}
const splitSurrogate=(text:string,at:number)=>at>0&&at<text.length&&/[\uD800-\uDBFF]/u.test(text[at-1]!)&&/[\uDC00-\uDFFF]/u.test(text[at]!);
type LiteralReason=LiteralDiagnostics['entries'][number]['reason'];
export interface BlockLiteral {literal:string;start:number;value:string|null;reason:LiteralReason|null}
export interface BlockPhoneLabel {label:string;labelStart:number;labelEnd:number;complete:boolean;unattached:boolean;literals:BlockLiteral[]}
/** The reviewed same-block grammar for one intact block. Callers own bounds,
 * coverage, authority and lineage; a value here is never contact permission. */
export function blockPhoneLabels(text:string):BlockPhoneLabel[]{
 const relaxed=phoneBlockAllowsV2(text);
 // Ordinary "personal touch" prose is not a phone label. Keep every
 // digit-bearing block conservative, including Unicode/unsupported numbers.
 const found=[...text.matchAll(labels)].filter(label=>
  !(/^personal$/iu.test(label[0])&&/^\s+touch\b/iu.test(text.slice(label.index+label[0].length))&&!/\p{N}/u.test(text))&&
  (!verbOnly.test(label[0])||relaxed&&verbAttached.test(text.slice(label.index+label[0].length))));
 const labelled=found.map((label,index):BlockPhoneLabel=>{
  const labelEnd=label.index+label[0].length,segment=text.slice(labelEnd,found[index+1]?.index??text.length),attached=attachedLiterals(segment,relaxed&&proseLabels.test(label[0]));
  // An explicit phone label with unresolved nonempty content cannot disappear
  // beside a valid alternate (including malformed/vanity phone attempts).
  return {label:label[0],labelStart:label.index,labelEnd,complete:attached.complete,unattached:attached.matches.length===0&&/\S/u.test(segment.replace(/^[\s:.-]+/u,'')),
   literals:attached.matches.map(token=>{
    const literal=token[0].trimEnd(),start=labelEnd+token.index,to=start+literal.length;
    const adjacent=(text[start-1]??'')+(text[to]??'');
    const ambiguous=/\b(?:fax|mobile|personal|emergency|vendor|powered\s+by|website\s+by|testimonial|customer\s+review)\b/iu.test(text)||/[\p{L}\p{N}]/u.test(adjacent)||splitSurrogate(text,start)||splitSurrogate(text,to);
    const normalized=canonicalizePhone(literal),plain=/^[0-9+(). \t-]+$/u.test(literal),supported=normalized.ok&&!ambiguous&&attached.complete&&plain;
    return {literal,start,value:supported&&normalized.ok?normalized.handle.value:null,reason:supported?null:ambiguous?'ambiguous_context':!normalized.ok||!plain?'unsupported_literal':'unattached_label_content'};
   })};
 });
 return labelled.length||!relaxed?labelled:standaloneNumber(text);
}
/** A block that is only one supported NANP literal (plus optional emoji/email) is a
 * published number. Its label is the emoji when present, else the literal's own span. */
function standaloneNumber(text:string):BlockPhoneLabel[]{
 // The permitted email tail is removed first so its digits are not a second number; offsets stay in `text`.
 const core=text.slice(0,standaloneEmail.exec(text)?.index??text.length),all=[...core.matchAll(tokens)];if(all.length!==1)return [];
 const token=all[0]!,literal=token[0].trimEnd(),start=token.index,end=start+literal.length,prefix=text.slice(0,start);
 if(!standalonePrefix.test(prefix)||!/^\s*$/u.test(core.slice(end))||!nanp.test(literal))return [];
 const normalized=canonicalizePhone(literal);if(!normalized.ok||!normalized.handle.value.startsWith('+1'))return [];
 const emoji=/(?:📞|☎)\uFE0F?/u.exec(prefix),label=emoji?{label:emoji[0],labelStart:emoji.index,labelEnd:emoji.index+emoji[0].length}:{label:literal,labelStart:start,labelEnd:end};
 return [{...label,complete:true,unattached:false,literals:[{literal,start,value:normalized.handle.value,reason:null}]}];
}
/** The exact span is the one literal of a standalone published number, whose permitted email tail is not part of it.
 * Extension and vanity suffixes never reach here: they are not supported NANP literals, so no standalone block exists. */
export function isStandalonePublishedLiteral(text:string,start:number,end:number):boolean{
 const literal=phoneBlockAllowsV2(text)?standaloneNumber(text)[0]?.literals[0]:undefined;
 return literal!==undefined&&literal.start===start&&literal.start+literal.literal.length===end;
}
export function scanManualLiteralPhones(input:LiteralInput):LiteralScan {
 const coverage:LiteralScan['coverage']={parser,state:'complete',observations:0,blocks:0};
 const result:LiteralScan={sources:[],coverage,unresolved:false};
 const unusable=():LiteralScan=>({sources:[],unresolved:result.unresolved,coverage:{...coverage,state:'unavailable'},reason:'original_not_usable'});
 const bounded=():LiteralScan=>({sources:[],unresolved:result.unresolved,coverage:{...coverage,state:'bounded'},reason:'bounded_scan_incomplete'});
 if(!Array.isArray(input.observations))return unusable();
 const authorities=input.observations.map(value=>typeof value==='object'&&value!==null&&'id' in value&&typeof value.id==='string'?input.authorities[value.id]:undefined);
 const phone=authorities.some(authority=>authority?.kind==='phone_discovery');
 if(input.observations.length>(phone?4:8)||Buffer.byteLength(JSON.stringify(input.observations))>PROSPECT_PHONE_CAPTURE_LIMITS.maxObservationBytes)return bounded();
 // Only the trusted discovery projection supplies this whole-run binding.
 // An observation's shape or a loose flag never promotes retained evidence.
 if(phone&&(input.lineage.kind!=='provider_original'||authorities.some(authority=>authority?.kind!=='phone_discovery'||authority.runId!==input.runId||
  !Number.isFinite(Date.parse(authority.expiresAt))||Date.parse(authority.expiresAt)<=input.now)))return unusable();
 const parsed=input.observations.map(value=>(phone?prospectPhoneObservationSchema:sourceObservationSchema).safeParse(value));
 if(parsed.some(value=>!value.success))return unusable();
 const sources=parsed.flatMap(value=>value.success?[value.data]:[]);
 if(new Set(sources.map(source=>source.id)).size!==sources.length)return unusable();
 const website=host(input.website);
 for(const source of sources){
  // A lost/unusable original is incomplete coverage, never a selected survivor. Only the prepared
  // authority (ADR0034) reads an incomplete page, and only until its own bound.
  const authority=input.authorities[source.id],prepared=authority?.kind==='prepared_capture';
  if(!authority||!website||host(source.url)!==website&&!(prepared&&input.moved?.has(source.id))||!source.firstParty||source.truncated&&!prepared||Date.parse(source.retrievedAt)>input.now||
   prepared&&!(Date.parse(authority.expiresAt)>input.now)||
   createHash('sha256').update(JSON.stringify(source.blocks)).digest('hex')!==source.relevantTextHash)return unusable();
  coverage.observations++;coverage.blocks+=source.blocks.length;
  for(const block of source.blocks){
   for(const found of blockPhoneLabels(block.text)){
    const reasons=new Set<LiteralReason>();
    if(!found.complete){result.unresolved=true;reasons.add('unattached_label_content');}
    for(const literal of found.literals){
     if(literal.literal.length>200||found.label.length>200||result.sources.length>=16)return bounded();
     if(literal.reason){result.unresolved=true;reasons.add(literal.reason);}
     result.sources.push(literalSource(input,source,block.id,found.label,found.labelStart,literal.literal,literal.start,literal.value));
    }
    if(found.unattached){result.unresolved=true;reasons.add('unattached_label_content');}
    for(const reason of reasons){
     const diagnostics=result.diagnostics??={entries:[],truncated:false};
     if((authority.kind==='phone_discovery'||authority.kind==='prepared_capture')&&(!diagnostics.expiresAt||Date.parse(authority.expiresAt)<Date.parse(diagnostics.expiresAt)))diagnostics.expiresAt=authority.expiresAt;
     if(found.label.length>200||diagnostics.entries.length>=16){diagnostics.truncated=true;continue;}
     diagnostics.entries.push({reason,runId:input.runId,observationId:source.id,blockId:block.id,url:source.url,retrievedAt:source.retrievedAt,
      contentHash:source.contentHash,relevantTextHash:source.relevantTextHash,parser,label:found.label,labelStart:found.labelStart,labelEnd:found.labelEnd,
      authority,lineage:input.lineage});
    }
   }
  }
 }
 if(!sources.length)return unusable();
 // Intact blocks of incomplete or partly skipped prepared pages support a published number, never absence or completeness.
 if(input.partial||sources.some(source=>source.truncated))coverage.state='partial';
 return result;
}
function literalSource(input:LiteralInput,source:SourceObservation,blockId:string,label:string,labelStart:number,literal:string,start:number,value:string|null):LiteralSource{
 return {method:'retained_original_literal',parser,runId:input.runId,observationId:source.id,blockId,url:source.url,retrievedAt:source.retrievedAt,
  contentHash:source.contentHash,relevantTextHash:source.relevantTextHash,literal,start,end:start+literal.length,label,labelStart,labelEnd:labelStart+label.length,
  normalizedValue:value,normalization:'existing-canonicalize-phone-v1',normalizationBasis:value===null?'unsupported':literal.startsWith('+')?'explicit_country_code':'default_us',
  authority:input.authorities[source.id]!,lineage:input.lineage};
}
