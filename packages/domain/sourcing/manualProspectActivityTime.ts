import {callbackInstant,localParts,zoneOffsetMinutes,type ManualProspectActivityContent} from '@fss/contracts';
/** Unlike operational callbacks, private reports reject both DST gaps and folds. */
export function validManualActivityTime(content:ManualProspectActivityContent,now:Date):boolean{
 if(content.occurrence.kind==='known'&&Date.parse(content.occurrence.occurredAt)>now.getTime())return false;
 const timing=content.callback?.timing;if(!timing||timing.kind==='unknown')return true;
 try{
  const due=callbackInstant(timing.localDate,timing.localTime,timing.sourceTimeZone);
  if(!due||Date.parse(due)!==Date.parse(timing.dueAt))return false;
  const matches=(at:number):boolean=>{const p=localParts(at,timing.sourceTimeZone);return p.date===timing.localDate&&`${String(p.hour).padStart(2,'0')}:${String(p.minute).padStart(2,'0')}`===timing.localTime;};
  if(!matches(Date.parse(due)))return false;
  const guess=Date.parse(`${timing.localDate}T${timing.localTime}:00.000Z`),offsets=new Set<number>();
  for(let hour=-36;hour<=36;hour+=6)offsets.add(zoneOffsetMinutes(Date.parse(due)+hour*3600000,timing.sourceTimeZone));
  return [...offsets].filter(offset=>matches(guess-offset*60000)).length===1;
 }catch{return false;}
}
