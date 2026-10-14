import { z } from 'zod';
import type { BookingPolicySnapshot } from '../meetings/bookingPolicyTypes.ts';
import type { loadBookingInterpretationSources } from './bookingInterpretationSources.ts';
const citation = z.strictObject({sourceId:z.string().uuid(),start:z.number().int().nonnegative(),end:z.number().int().positive(),quote:z.string().min(1).max(12000)});
const slotSchema = z.strictObject({localDate:z.string().max(10),localTime:z.string().max(5),timeZone:z.string().max(100),evidence:citation});
const candidateSchema = z.strictObject({intent:z.enum(['interest','accept_slot','clarify','conditional','refusal','opt_out','change','handoff']),agreement:citation.nullable(),slot:slotSchema.nullable(),substantive:citation.nullable()});
type Citation=z.infer<typeof citation>;
type Original=NonNullable<Awaited<ReturnType<typeof loadBookingInterpretationSources>>>['originals'][number];
export function bookingInterpretationModelInput(originals:readonly Original[]):string|null {
 const messages=[];
 for(const source of originals){
  const ranges=z.array(z.object({kind:z.string(),start:z.number().int().nonnegative(),end:z.number().int().nonnegative()})).safeParse(source.ranges);
  if(!ranges.success||source.passage===null||ranges.data.some(range=>range.end<range.start||range.end>source.passage!.length))return null;
  messages.push({sourceId:source.sourceId,direction:source.direction,occurredAt:source.occurredAt,rawSenderDate:source.rawSenderDate,authored:ranges.data.filter(range=>range.kind==='authored').map(range=>({start:range.start,end:range.end,text:source.passage!.slice(range.start,range.end)}))});
 }
 return JSON.stringify(messages);
}
function authored(source:Original,evidence:Citation|null):boolean {
 const ranges=z.array(z.object({kind:z.string(),start:z.number().int().nonnegative(),end:z.number().int().nonnegative()})).safeParse(source.ranges);
 return evidence!==null&&evidence.sourceId===source.sourceId&&evidence.end>evidence.start&&source.passage?.slice(evidence.start,evidence.end)===evidence.quote&&ranges.success&&ranges.data.some(range=>range.kind==='authored'&&range.start<=evidence.start&&range.end>=evidence.end);
}
function authoredSlotParts(source:Original) {
 const ranges=z.array(z.object({kind:z.string(),start:z.number(),end:z.number()})).safeParse(source.ranges);
 if(!ranges.success)return null;
 const full=ranges.data.filter(range=>range.kind==='authored').map(range=>source.passage?.slice(range.start,range.end)??'').join('\n');
 return {dates:new Set(full.match(/\b\d{4}-\d{2}-\d{2}\b/g)??[]),times:new Set(full.match(/\b(?:[01]\d|2[0-3]):[0-5]\d\b/g)??[]),zones:new Set(full.match(/\b[A-Za-z_]+(?:\/[A-Za-z_+-]+)+\b/g)??[])};
}
function uniqueSlot(parts:NonNullable<ReturnType<typeof authoredSlotParts>>,slot:z.infer<typeof slotSchema>):boolean {
 return parts.dates.size===1&&parts.dates.has(slot.localDate)&&parts.times.size===1&&parts.times.has(slot.localTime)&&parts.zones.size===1&&parts.zones.has(slot.timeZone);
}
function exactSlot(slot:z.infer<typeof slotSchema>,originals:readonly Original[],now:string,agreement:Citation):boolean {
 const offered=originals.find(source=>source.sourceId===slot.evidence.sourceId);
 const original=originals[0]!;
 if(!offered||!authored(offered,slot.evidence)||originals.length>2||original.envelope.cc.length!==0||original.envelope.to.length!==1)return false;
 const incoming=authoredSlotParts(original);
 // A cropped model citation cannot choose between alternatives in the authored reply.
 if(!incoming||incoming.dates.size>1||incoming.times.size>1||incoming.zones.size>1||
  (incoming.dates.size===1&&!incoming.dates.has(slot.localDate))||
  (incoming.times.size===1&&!incoming.times.has(slot.localTime))||
  (incoming.zones.size===1&&!incoming.zones.has(slot.timeZone)))return false;
 if(offered.sourceId!==original.sourceId){
  if(offered.direction!=='outgoing'||!offered.sentProof||offered.completeness!=='complete'||offered.envelope.cc.length!==0||offered.envelope.to.length!==1||offered.envelope.to[0]?.toLowerCase()!==original.envelope.from?.toLowerCase()||offered.envelope.from?.toLowerCase()!==original.envelope.to[0]?.toLowerCase())return false;
  const prior=authoredSlotParts(offered);
  if(!prior)return false;
  const uniquelyOffered=uniqueSlot(prior,slot);
  const explicitlySelected=uniqueSlot(incoming,slot)&&agreement.quote.includes(slot.localDate)&&agreement.quote.includes(slot.localTime)&&agreement.quote.includes(slot.timeZone);
  if(!uniquelyOffered&&!explicitlySelected)return false;
 }
 if(!/^\d{4}-\d{2}-\d{2}$/.test(slot.localDate)||!Number.isFinite(Date.parse(slot.localDate))||new Date(slot.localDate).toISOString().slice(0,10)!==slot.localDate||!/^([01]\d|2[0-3]):[0-5]\d$/.test(slot.localTime)||slot.localDate<=now.slice(0,10))return false;
 try{if(!slot.timeZone.includes('/'))return false;new Intl.DateTimeFormat('en-US',{timeZone:slot.timeZone});}catch{return false;}
 // Only explicitly represented dates and zones are admitted. Relative or abbreviated evidence clarifies.
 return slot.evidence.quote.includes(slot.localDate)&&slot.evidence.quote.includes(slot.localTime)&&slot.evidence.quote.includes(slot.timeZone);
}
const clarification={kind:'clarification' as const,reason:'booking_candidate_requires_review',permission:false as const};
/** Candidate validation is not authority, freebusy, a Route, a send or a booking. */
export function bookingInterpretationOutcome(input:{candidate:unknown;originals:readonly Original[];snapshot:BookingPolicySnapshot;now:string}) {
 const parsed=candidateSchema.safeParse(input.candidate);
 if(!parsed.success)return clarification;
 const candidate=parsed.data,original=input.originals[0]!;
 if(original.completeness!=='complete'||original.envelope.from===null)return clarification;
 if(!authored(original,candidate.agreement))return clarification;
 const questionSupported=authored(original,candidate.substantive);
 if(candidate.substantive!==null&&!questionSupported)return clarification;
 const handoff={ownerUserId:input.snapshot.ownerUserId,action:questionSupported?'answer_sales_question':'review_conditional_scheduling',evidence:questionSupported?candidate.substantive:candidate.agreement};
 if(candidate.intent==='refusal'||candidate.intent==='opt_out')return {kind:'stop' as const,reason:candidate.intent,evidence:candidate.agreement,permission:false as const};
 const authoredRanges=z.array(z.object({kind:z.string(),start:z.number(),end:z.number()})).safeParse(original.ranges);
 const text=authoredRanges.success?authoredRanges.data.filter(range=>range.kind==='authored').map(range=>original.passage?.slice(range.start,range.end)??'').join('\n'):'';
 // These guards can only withhold a positive candidate, never grant an action.
 const conditional=/\b(if|unless|provided|assuming|subject to|only after)\b/i.test(text);
 const refusal=/\b(no thanks|not interested|do not contact|don't contact|stop contacting|unsubscribe)\b/i.test(text);
 if(refusal)return {kind:'stop' as const,reason:'refusal' as const,evidence:candidate.agreement,permission:false as const};
 // Booking negation anywhere in the authored reply vetoes cropped positive evidence.
 // Withhold for review rather than turn a lexical match into action authority.
 const bookingNegation=/\b(?:do\s+not|don['’]t|never)\s+(?:book|schedule|arrange|reserve)\b/i.test(text);
 if(bookingNegation)return {...clarification,...(questionSupported?{handoff}:{})};
 if(candidate.intent==='conditional'||candidate.intent==='handoff'||conditional)return {kind:'david_handoff' as const,schedulingPaused:true,handoff,permission:false as const};
 const explicitAgreement=/\b(yes|that works|works for me|agreed|confirmed|book it|schedule it|see you|sounds good|let'?s do it)\b/i.test(candidate.agreement!.quote)&&!/\b(interested|learning more|maybe|sometime)\b/i.test(candidate.agreement!.quote);
 if(candidate.intent==='accept_slot'&&explicitAgreement&&candidate.slot!==null&&exactSlot(candidate.slot,input.originals,input.now,candidate.agreement!))return {kind:'slot_proposal' as const,slot:candidate.slot,agreement:candidate.agreement,attendeeAddress:original.envelope.from,permission:false as const,schedulingPaused:false,...(questionSupported?{handoff}:{}),requires:['current_attendee_route','fresh_freebusy','guarded_create']};
 if(candidate.intent==='interest'&&candidate.slot===null)return {kind:'approved_link' as const,bookingUrl:input.snapshot.bindings.event.bookingUrl,permission:false as const,schedulingPaused:false,...(questionSupported?{handoff}:{})};
 return {...clarification,...(questionSupported?{handoff}:{})};
}
