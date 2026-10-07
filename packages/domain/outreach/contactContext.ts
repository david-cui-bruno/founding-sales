import type {QualificationFact,SourceObservation} from '@fss/contracts';
import type {SourcingIdentity} from '../sourcing/qualificationPolicy.ts';
const fold=(s:string)=>s.normalize('NFKC').replace(/\s+/gu,' ').trim().toLowerCase();
const escape=(s:string)=>s.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&');
/** A compact office card on a contact page. Never combines arbitrary page-wide evidence.
 * Accept only a firm heading, phone/email, optional office label/street, and this city/state.
 * The observation retains every original block; the email route still cites the email block. */
export function officeContactContext(source:SourceObservation,fact:QualificationFact,identity:SourcingIdentity):string|null {
 if(!/(?:^|\/)contact(?:[-_/]|$)/iu.test(new URL(source.url).pathname))return null;
 const blocks=source.blocks,index=blocks.findIndex(b=>b.id===fact.blockId);
 if(index<0)return null;
 // Expanded context is for an unambiguous role-address line, not prose or a guessed person.
 if(!/^(?:e-?mail\s*:?\s*)?[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/iu.test(blocks[index]!.text.trim()))return null;
 const location=new RegExp(`^${escape(fold(identity.locality))},?\\s+${escape(fold(identity.region))}(?:\\s+\\d{5}(?:-\\d{4})?)?$`,'u');
 for(let start=Math.max(0,index-3);start<index;start++){
  if(fold(blocks[start]!.text)!==fold(identity.name))continue;
  for(let end=index+1;end<=Math.min(blocks.length-1,index+4);end++){
   if(!location.test(fold(blocks[end]!.text)))continue;
   const card=blocks.slice(start,end+1);if(card.some(b=>b.text.length>160))continue;
   const middle=blocks.slice(start+1,end);
   if(middle.some(b=>b.id!==fact.blockId&&!/^(?:[+\d\s().-]{7,}|office(?: location| address)?|address|\d{1,6}\s+[\p{L}\d .,#'-]+)$/iu.test(b.text.trim())))continue;
   const text=card.map(b=>b.text).join(' ');
   if((text.match(/@/gu)??[]).length!==1)continue;
   return text;
  }
 }
 return null;
}
