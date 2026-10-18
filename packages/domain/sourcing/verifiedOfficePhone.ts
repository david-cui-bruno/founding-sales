import type {QualificationFact,SourceObservation} from '@fss/contracts';
import {canonicalizePhone} from '../src/rules/suppressionCanonicalization.ts';
import type {SourcingIdentity} from './qualificationPolicy.ts';

const fold=(value:string)=>value.normalize('NFKC').replace(/\s+/gu,' ').trim().toLowerCase();
const escape=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&');
const phonePattern=/(?:\+?1[ .-]?)?\(?[2-9]\d{2}\)?[ .-]?\d{3}[ .-]?\d{4}/gu;
const stateNames:Record<string,string>={TX:'texas',RI:'rhode island',MA:'massachusetts'};
const forbidden=/\b(?:fax|emergency|after.hours|police|fire department|web design|website by|powered by|testimonial|review)\b/iu;
/** Each accepted proof is one original contiguous section, never synthesized fact text. */
export interface OfficePhoneProof {phone:string|null;ambiguous:boolean}
function numbers(text:string):string[] {
 return [...new Set([...text.matchAll(phonePattern)].flatMap(match=>{
  const normalized=canonicalizePhone(match[0]);return normalized.ok?[normalized.handle.value]:[];
 }))];
}
/** The caller supplies only current complete first-party evidence already schema/citation checked.
 * Old extraction facts are single literal blocks. Their company/address may be neighboring
 * blocks, but only an entirely recognized compact office card can establish that association.
 * This proof does not authorize a call or change the legacy manual qualification policy. */
export function verifiedOfficePhone(input:{identity:SourcingIdentity;facts:readonly QualificationFact[];observations:readonly SourceObservation[]}):OfficePhoneProof {
 const {identity}=input,name=fold(identity.name),city=fold(identity.locality),state=fold(identity.region);
 const location=new RegExp(`^(?:${escape(city)}),?\\s+(?:${escape(state)}|${escape(stateNames[identity.region]??'__unknown__')})(?:\\s+\\d{5}(?:-\\d{4})?)?\\.?$`,'u');
 const targetLocationMention=new RegExp(`(?:^|[\\s,:])${escape(city)},?\\s+(?:${escape(state)}|${escape(stateNames[identity.region]??'__unknown__')})\\b`,'u');
 const sameLocation=(text:string)=>{
  const normalized=fold(text);
  if(location.test(normalized))return true;
  // Full street/city on one line is still literal geography, never a service-area guess.
  if(!/^\d{1,6}\s/u.test(normalized))return false;
  const parts=normalized.split(/,\s*/u),locationIndex=parts.findIndex((_,index)=>location.test(parts.slice(index).join(', ')));
  if(locationIndex<1||locationIndex>2||!/^\d{1,6}\s+[\p{L}\d .#'-]+$/u.test(parts[0]!))return false;
  return locationIndex===1||/^(?:suite|ste|#)\s*#?[a-z0-9-]+$/u.test(parts[1]!);
 };
 const named=(text:string)=>{
  const normalized=fold(text);
  return normalized===name||normalized===`${name} ${city} office`||normalized===`${name} ${city} branch`;
 };
 const namedLocation=(text:string)=>{
  const normalized=fold(text),prefix=`${name} office: `;
  if(!normalized.startsWith(prefix))return false;
  const [geography,...sections]=normalized.slice(prefix.length).split('. ');
  return sameLocation(geography!)&&sections.every(section=>section.replace(/\.$/u,'')==='we provide residential property management'||phoneLine(section));
 };
 const phoneLine=(text:string)=>{
  if(forbidden.test(text)||numbers(text).length!==1)return false;
  const remainder=fold(text).replaceAll(name,'').replace(phonePattern,'').replace(/\b(?:contact|call|us|today|at|phone|telephone|tel|office|main)\b/gu,'').replace(/[\s:().,+-]/gu,'');
  return remainder==='';
 };
 const street=(text:string)=>/^\d{1,6}\s+[\p{L}\d .,#'-]+$/u.test(fold(text))&&!/,\s*[a-z]{2}(?:\s+\d{5}(?:-\d{4})?)?\.?$/iu.test(text)&&!/\b(?:texas|rhode island|massachusetts)\b/iu.test(text);
 const label=(text:string)=>/^(?:office(?: location| address)?|address|location|contact(?: information)?|suite [a-z0-9-]+)$/u.test(fold(text));
 const email=(text:string)=>/^(?:e-?mail\s*:?\s*)?[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/iu.test(text.trim());
 const facts=input.facts.filter(fact=>fact.kind==='business_phone');
 const allNumbers=new Set(facts.flatMap(fact=>numbers(fact.value)));
 if(allNumbers.size!==1)return {phone:null,ambiguous:false};
 let supported=false,ambiguous=false;
 for(const fact of facts){
  const source=input.observations.find(observation=>observation.id===fact.observationId);
  const index=source?.blocks.findIndex(block=>block.id===fact.blockId)??-1;
  if(!source||index<0||source.blocks[index]!.text!==fact.value||forbidden.test(fact.value))continue;
  const blocks=source.blocks;
  let accepted=false;
  for(let start=Math.max(0,index-7);start<=index;start++)for(let end=index;end<Math.min(blocks.length,start+8);end++){
   const card=blocks.slice(start,end+1);
   if(card.some(block=>block.text.length>240))continue;
   // Name-first cards cannot inherit a preceding office's phone. The observed
   // phone-first alternative is allowed only at the very start of the source.
   if(!named(card[0]!.text)&&!namedLocation(card[0]!.text)&&!(start===0&&phoneLine(card[0]!.text)))continue;
   if(!card.some(block=>namedLocation(block.text)||street(block.text)||(sameLocation(block.text)&&/^\d/u.test(block.text))||/^(?:office(?: location| address)?|address|location)$/u.test(fold(block.text))||fold(block.text)===`${name} ${city} office`||fold(block.text)===`${name} ${city} branch`))continue;
   if(card.filter(block=>named(block.text)||namedLocation(block.text)).length!==1)continue;
   if(card.filter(block=>sameLocation(block.text)||namedLocation(block.text)).length!==1||card.filter(block=>street(block.text)).length>1)continue;
   if(!card.every(block=>named(block.text)||namedLocation(block.text)||sameLocation(block.text)||phoneLine(block.text)||street(block.text)||label(block.text)||email(block.text)))continue;
   const cardNumbers=new Set(card.flatMap(block=>numbers(block.text)));
   if(cardNumbers.size!==1||![...cardNumbers].every(value=>allNumbers.has(value)))continue;
   accepted=true;
  }
  supported ||= accepted;
  if(!accepted){
   // An explicitly different nearby office is ambiguous, not a request to infer
   // a replacement locality. Unsupported/distant layouts merely remain pending.
   const nearby=blocks.slice(Math.max(0,index-2),index+3);
   ambiguous ||= nearby.some(block=>!targetLocationMention.test(fold(block.text))&&!sameLocation(block.text)&&!namedLocation(block.text)&&(/\b(?:office|branch)\s*:/iu.test(block.text)||/,\s*(?:TX|RI|MA|Texas|Rhode Island|Massachusetts)(?:\s|[.,]|$)/iu.test(block.text)));
  }
 }
 return {phone:supported&&!ambiguous?[...allNumbers][0]!:null,ambiguous};
}
