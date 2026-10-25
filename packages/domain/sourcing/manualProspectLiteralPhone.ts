import {createHash} from 'node:crypto';
import {sourceObservationSchema,type ManualProspect,type SourceObservation} from '@fss/contracts';
import {canonicalizePhone} from '../src/rules/suppressionCanonicalization.ts';

type Evidence=NonNullable<ManualProspect['phoneEvidence']>;
export type LiteralSource=Extract<Extract<Evidence,{state:'observed'}>['sources'][number],{method:string}>;
export type LiteralAuthority=LiteralSource['authority'];
export type LiteralLineage=LiteralSource['lineage'];
export interface LiteralInput {runId:string;observations:unknown;website:string|null;authorities:Record<string,LiteralAuthority>;lineage:LiteralLineage;now:number}
export interface LiteralScan {sources:LiteralSource[];coverage:NonNullable<Evidence['coverage']>;unresolved:boolean;reason?:'original_not_usable'|'bounded_scan_incomplete'}
const parser='manual-literal-phone-v1' as const;
const host=(value:string|null)=>{try{const url=new URL(value??'');return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password?url.hostname.toLowerCase().replace(/^www\./u,''):null;}catch{return null;}};
// Labels, not arbitrary prose, introduce a phone-bearing segment in one block.
const labels=/\b(?:office\s+phone|main\s+phone|mobile(?:\s+phone)?|personal(?:\s+phone)?|emergency(?:\s+phone)?|fax|telephone|phone|tel|call\s+us)\b/giu;
// Vanity and extension forms are retained as unsupported WHOLE literals. Never
// accept their numeric prefix as a business endpoint. No cross-block stitching.
const tokens=/\+?[\p{N}(][\p{N}(). \t-]*\p{N}(?:[ \t]*(?:ext(?:ension)?\.?|x|#)[ \t]*[\p{L}\p{N}]+|-?[\p{L}\p{N}-]+)?/giu;
/** Consume only explicitly attached literals. Unmatched prose/fields/residue
 * makes the segment unresolved, never a license to search later identifiers.
 * Unicode/vanity tokens are retained but do NOT extend the supported grammar. */
function attachedLiterals(segment:string):{matches:RegExpExecArray[];complete:boolean}{
 const matches:RegExpExecArray[]=[];let cursor=0;
 for(const token of segment.matchAll(tokens)){
  const gap=segment.slice(cursor,token.index);
  const connector=matches.length===0?/^\s*(?::|[.-])?\s*(?:at\s+)?$/iu:/^\s*(?:[/,;&]|and|or)?\s*$/iu;
  if(!connector.test(gap))return {matches,complete:false};
  matches.push(token);cursor=token.index+token[0].length;
 }
 return {matches,complete:/^[\s.,;]*$/u.test(segment.slice(cursor))};
}
const splitSurrogate=(text:string,at:number)=>at>0&&at<text.length&&/[\uD800-\uDBFF]/u.test(text[at-1]!)&&/[\uDC00-\uDFFF]/u.test(text[at]!);
export function scanManualLiteralPhones(input:LiteralInput):LiteralScan {
 const coverage:LiteralScan['coverage']={parser,state:'complete',observations:0,blocks:0};
 const result:LiteralScan={sources:[],coverage,unresolved:false};
 const unusable=()=>({...result,sources:[],coverage:{...coverage,state:'unavailable' as const},reason:'original_not_usable' as const});
 const bounded=()=>({...result,sources:[],coverage:{...coverage,state:'bounded' as const},reason:'bounded_scan_incomplete' as const});
 if(!Array.isArray(input.observations))return unusable();
 if(input.observations.length>8||Buffer.byteLength(JSON.stringify(input.observations))>100000)return bounded();
 const parsed=input.observations.map(value=>sourceObservationSchema.safeParse(value));
 if(parsed.some(value=>!value.success))return unusable();
 const sources=parsed.flatMap(value=>value.success?[value.data]:[]);
 if(new Set(sources.map(source=>source.id)).size!==sources.length)return unusable();
 const website=host(input.website);
 for(const source of sources){
  // A lost/unusable original is incomplete coverage, never a selected survivor.
  if(!input.authorities[source.id]||!website||host(source.url)!==website||!source.firstParty||source.truncated||Date.parse(source.retrievedAt)>input.now||
   createHash('sha256').update(JSON.stringify(source.blocks)).digest('hex')!==source.relevantTextHash)return unusable();
  coverage.observations++;coverage.blocks+=source.blocks.length;
  for(const block of source.blocks){
   const found=[...block.text.matchAll(labels)];
   for(const [index,label] of found.entries()){
    const start=label.index+label[0].length,end=found[index+1]?.index??block.text.length;
    const segment=block.text.slice(start,end);
    const attached=attachedLiterals(segment),candidates=attached.matches;
    if(!attached.complete)result.unresolved=true;
    for(const token of candidates){
     const literal=token[0].trimEnd(),at=start+token.index,to=at+literal.length;
     if(literal.length>200||label[0].length>200||result.sources.length>=16)return bounded();
     const adjacent=(block.text[at-1]??'')+(block.text[to]??'');
     const ambiguous=/\b(?:fax|mobile|personal|emergency|vendor|powered\s+by|website\s+by|testimonial|customer\s+review)\b/iu.test(block.text)||/[\p{L}\p{N}]/u.test(adjacent)||splitSurrogate(block.text,at)||splitSurrogate(block.text,to);
     const normalized=canonicalizePhone(literal),supported=normalized.ok&&!ambiguous&&attached.complete&&/^[0-9+(). \t-]+$/u.test(literal);
     if(!supported)result.unresolved=true;
     result.sources.push(literalSource(input,source,block.id,label[0],label.index,literal,at,supported&&normalized.ok?normalized.handle.value:null));
    }
    // An explicit phone label with unresolved nonempty content cannot disappear
    // beside a valid alternate (including malformed/vanity phone attempts).
    if(candidates.length===0&&/\S/u.test(segment.replace(/^[\s:.-]+/u,'')))result.unresolved=true;
   }
  }
 }
 if(!sources.length)return unusable();
 return result;
}
function literalSource(input:LiteralInput,source:SourceObservation,blockId:string,label:string,labelStart:number,literal:string,start:number,value:string|null):LiteralSource{
 return {method:'retained_original_literal',parser,runId:input.runId,observationId:source.id,blockId,url:source.url,retrievedAt:source.retrievedAt,
  contentHash:source.contentHash,relevantTextHash:source.relevantTextHash,literal,start,end:start+literal.length,label,labelStart,labelEnd:labelStart+label.length,
  normalizedValue:value,normalization:'existing-canonicalize-phone-v1',normalizationBasis:value===null?'unsupported':literal.startsWith('+')?'explicit_country_code':'default_us',
  authority:input.authorities[source.id]!,lineage:input.lineage};
}
