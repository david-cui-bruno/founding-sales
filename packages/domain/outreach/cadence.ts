import {addCalendarDays,endOfLocalDay,localDate,localInstant,localParts,weekdayOfDate} from '../src/rules/localClock.ts';
export type OutreachLane='email_first'|'call_first';
export interface ProspectingTouch {
 readonly ordinal:number;
 readonly channel:'phone'|'email';
 readonly channelOrdinal:number;
 readonly localDate:string;
 readonly dueAt:string;
 readonly voicemail:boolean;
}
export interface OutreachCadence {
 readonly version:'outreach-cadence-v1';
 readonly lane:OutreachLane;
 readonly timeZone:string;
 readonly expiresAt:string;
 readonly touches:readonly ProspectingTouch[];
}
function weekday(date:string):string {
 let result=date;
 while([0,6].includes(weekdayOfDate(result)))result=addCalendarDays(result,1);
 return result;
}
/** Calendar offsets are independent of existing sequence elapsed/business-day delays. */
export function buildOutreachCadence(input:{lane:OutreachLane;startsAt:string;timeZone:string}):OutreachCadence {
 const parts=localParts(input.startsAt,input.timeZone);
 const start=weekday(parts.hour>=17?addCalendarDays(parts.date,1):parts.date);
 const hour=Math.max(10,Math.min(parts.hour,16));
 const slots=input.lane==='email_first'
  ? [0,3,7,13,20].map(offset=>({offset,channel:'email' as const}))
  : [...[0,4,9,14].map(offset=>({offset,channel:'phone' as const})),...[2,7,12,20].map(offset=>({offset,channel:'email' as const}))].sort((a,b)=>a.offset-b.offset);
 const counts={phone:0,email:0};
 let previous='';
 const touches=slots.map((slot,index):ProspectingTouch=>{
  let date=weekday(addCalendarDays(start,slot.offset));
  if(date<=previous)date=weekday(addCalendarDays(previous,1));
  previous=date;
  counts[slot.channel]+=1;
  return {ordinal:index+1,channel:slot.channel,channelOrdinal:counts[slot.channel],localDate:date,dueAt:localInstant(date,{hour,minute:parts.hour>=10&&parts.hour<17?parts.minute:0},input.timeZone),voicemail:slot.channel==='phone'&&[1,4].includes(counts.phone)};
 });
 return {version:'outreach-cadence-v1',lane:input.lane,timeZone:input.timeZone,touches,expiresAt:endOfLocalDay(touches.at(-1)!.dueAt,input.timeZone)};
}
/** Latest relevant overdue action wins; older missed work is explicitly skipped. */
export function nextProspectingTouch(input:{plan:OutreachCadence;at:string;completedOrdinals:readonly number[];lastTouchAt:string|null}):{touch:ProspectingTouch;skippedOrdinals:readonly number[]}|null {
 const {plan,at,lastTouchAt}=input;
 if(Date.parse(at)>Date.parse(plan.expiresAt))return null;
 if(lastTouchAt!==null&&localDate(lastTouchAt,plan.timeZone)>=localDate(at,plan.timeZone))return null;
 const done=new Set(input.completedOrdinals);
 const latestDone=Math.max(0,...input.completedOrdinals);
 const prior=plan.touches.find(t=>t.ordinal===latestDone);
 const remaining=plan.touches.filter(t=>!done.has(t.ordinal)&&t.ordinal>latestDone);
 const due=remaining.filter(t=>{
  if(Date.parse(t.dueAt)>Date.parse(at))return false;
  if(lastTouchAt===null||prior===undefined)return true;
  const gap=Math.round((Date.parse(`${t.localDate}T00:00:00Z`)-Date.parse(`${prior.localDate}T00:00:00Z`))/86400000);
  const date=weekday(addCalendarDays(localDate(lastTouchAt,plan.timeZone),Math.max(1,gap)));
  const clock=localParts(t.dueAt,plan.timeZone);
  return Date.parse(localInstant(date,{hour:clock.hour,minute:clock.minute},plan.timeZone))<=Date.parse(at);
 });
 const touch=due.at(-1);
 if(touch===undefined)return null;
 return {touch,skippedOrdinals:remaining.filter(t=>t.ordinal<touch.ordinal).map(t=>t.ordinal)};
}
