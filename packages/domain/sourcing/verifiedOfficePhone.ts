import type {QualificationFact,SourceObservation} from '@fss/contracts';
import {canonicalizePhone} from '../src/rules/suppressionCanonicalization.ts';
import type {SourcingIdentity} from './qualificationPolicy.ts';

const fold=(value:string)=>value.normalize('NFKC').replace(/\s+/gu,' ').trim().toLowerCase();
const escape=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&');
const phonePattern=/(?<![\p{L}\d])(?:\+?1[ .-]?)?\(?[2-9]\d{2}\)?[ .-]?\d{3}[ .-]?\d{4}(?![\p{L}\d])/gu;
// A number plus marketing prose is not an address. Unsupported layouts stay pending.
const streetAddress=/^\d{1,6}\s+(?:[nesw]\.?\s+)?[\p{L}\d][\p{L}\d .'-]*\s+(?:street|st|avenue|ave|road|rd|drive|dr|lane|ln|court|ct|boulevard|blvd|way|parkway|pkwy|place|pl|terrace|ter|circle|cir|highway|hwy)(?:\.)?(?:\s+[nesw]\.?)?(?:\s+(?:suite|ste|#)\s*#?[a-z0-9-]+)?$/u;
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
 const streetAtLocation=(text:string):string|null=>{
  const normalized=fold(text);
  // Full street/city on one line is still literal geography, never a service-area guess.
  if(!/^\d{1,6}\s/u.test(normalized))return null;
  const parts=normalized.split(/,\s*/u),locationIndex=parts.findIndex((_,index)=>location.test(parts.slice(index).join(', ')));
  if(locationIndex>=1&&locationIndex<=2&&streetAddress.test(parts[0]!))return locationIndex===1||/^(?:suite|ste|#)\s*#?[a-z0-9-]+$/u.test(parts[1]!)?parts[0]!:null;
  // Observed contact-card layout: "13803 Jarvis Rd Cypress, TX 77429".
  // Match a unique literal city suffix inside this original block, not joined facts.
  const suffixParts=normalized.split(new RegExp(`\\s+${escape(city)},?\\s+`,'u'));
  return suffixParts.length===2&&streetAddress.test(suffixParts[0]!)&&new RegExp(`^(?:${escape(state)}|${escape(stateNames[identity.region]??'__unknown__')})\\s+\\d{5}(?:-\\d{4})?$`,'u').test(suffixParts[1]!)?suffixParts[0]!:null;
 };
 const sameLocation=(text:string)=>location.test(fold(text))||streetAtLocation(text)!==null;
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
 const street=(text:string)=>streetAddress.test(fold(text));
 // Comparison keys only: every citation remains its original untouched block.
 const physicalStreet=(text:string)=>street(text)?fold(text):streetAtLocation(text);
 const label=(text:string)=>/^(?:office(?: location| address)?|address|location|contact(?: information)?|suite [a-z0-9-]+):?$/u.test(fold(text));
 const email=(text:string)=>/^(?:e-?mail\s*:?\s*)?[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/iu.test(text.trim());
 const facts=input.facts.filter(fact=>fact.kind==='business_phone');
 const allNumbers=new Set(facts.flatMap(fact=>numbers(fact.value)));
 if(allNumbers.size!==1)return {phone:null,ambiguous:false};
 let supported=false,ambiguous=false;
 for(const fact of facts){
  const source=input.observations.find(observation=>observation.id===fact.observationId);
  const index=source?.blocks.findIndex(block=>block.id===fact.blockId)??-1;
  if(!source||index<0||source.blocks[index]!.text!==fact.value||forbidden.test(fact.value))continue;
  // A selected phone block must itself be a recognized phone production, not
  // sneak through another card role such as an address with a numeric prefix.
  const phoneProduction=phoneLine(fact.value)||(namedLocation(fact.value)&&numbers(fact.value).length===1);
  const blocks=source.blocks;
  const foreignLocation=(text:string)=>!targetLocationMention.test(fold(text))&&(/,?\s+(?:TX|RI|MA|Texas|Rhode Island|Massachusetts)(?:\s+\d{5}(?:-\d{4})?)?\.?$/iu.test(text)||/\b(?:office|branch)\s*:\s*\S/iu.test(text)||(/\b(?:office|branch)\s*:?$/iu.test(text)&&!label(text)&&!named(text)));
  const conflictingContinuation=(start:number,end:number)=>{
   const cardStreets=new Set(blocks.slice(start,end+1).map(block=>physicalStreet(block.text)).filter(value=>value!==null));
   for(const [edge,direction] of [[start-1,-1],[end+1,1]] as const){
    for(let cursor=edge,seen=0;cursor>=0&&cursor<blocks.length&&seen<8;cursor+=direction,seen++){
     const text=blocks[cursor]!.text;
     if(text.length>240||named(text)||(numbers(text).length===0&&fold(text).startsWith(`${name} office: `)))break;
     if(foreignLocation(text)||numbers(text).some(value=>!allNumbers.has(value)))return true;
     const continuationStreet=physicalStreet(text);
     if(continuationStreet!==null&&cardStreets.size>0&&!cardStreets.has(continuationStreet))return true;
     if(sameLocation(text)&&/^\d/u.test(text)&&blocks.slice(start,end+1).some(block=>sameLocation(block.text)&&/^\d/u.test(block.text)&&fold(block.text)!==fold(text)))return true;
     if(!sameLocation(text)&&!phoneLine(text)&&!street(text)&&!label(text)&&!email(text))break;
    }
   }
   return false;
  };
  let accepted=false;
  for(let start=Math.max(0,index-7);start<=index;start++)for(let end=index;end<Math.min(blocks.length,start+8);end++){
   const card=blocks.slice(start,end+1);
   if(!phoneProduction||card.some(block=>block.text.length>240))continue;
   // Name-first cards cannot inherit a preceding office's phone. The observed
   // phone-first alternative is allowed only at the very start of the source.
   if(!named(card[0]!.text)&&!namedLocation(card[0]!.text)&&!(start===0&&phoneLine(card[0]!.text)))continue;
   if(!card.some(block=>namedLocation(block.text)||street(block.text)||(sameLocation(block.text)&&/^\d/u.test(block.text))||/^(?:office(?: location| address)?|address|location):?$/u.test(fold(block.text))||fold(block.text)===`${name} ${city} office`||fold(block.text)===`${name} ${city} branch`))continue;
   if(card.filter(block=>named(block.text)||namedLocation(block.text)).length!==1)continue;
   if(card.filter(block=>sameLocation(block.text)||namedLocation(block.text)).length!==1||card.filter(block=>street(block.text)).length>1)continue;
   if(new Set(card.map(block=>physicalStreet(block.text)).filter(value=>value!==null)).size>1)continue;
   if(!card.every(block=>named(block.text)||namedLocation(block.text)||sameLocation(block.text)||phoneLine(block.text)||street(block.text)||label(block.text)||email(block.text)))continue;
   const cardNumbers=new Set(card.flatMap(block=>numbers(block.text)));
   if(cardNumbers.size!==1||![...cardNumbers].every(value=>allNumbers.has(value)))continue;
   if(conflictingContinuation(start,end))continue;
   accepted=true;
  }
  supported ||= accepted;
  if(!accepted){
   // An explicitly different nearby office is ambiguous, not a request to infer
   // a replacement locality. Unsupported/distant layouts merely remain pending.
   const nearby=blocks.slice(Math.max(0,index-2),index+3);
   ambiguous ||= nearby.some(block=>foreignLocation(block.text));
  }
 }
 return {phone:supported&&!ambiguous?[...allNumbers][0]!:null,ambiguous};
}
