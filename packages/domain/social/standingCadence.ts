import type {SocialStandingPlanSave} from '@fss/contracts';
export function localStandingDate(at:Date,timezone:string):string{return new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(at);}
export function standingWeek(at:Date,timezone:string):string{const day=localStandingDate(at,timezone),d=new Date(`${day}T12:00:00Z`);d.setUTCDate(d.getUTCDate()-((d.getUTCDay()+6)%7));return d.toISOString().slice(0,10);}
/** Match actual local clock instants: nonexistent DST times skip; repeated times use first occurrence. */
export function standingWeekSlots(at:Date,c:Pick<SocialStandingPlanSave,'timezone'|'cadence'>):{ordinal:number;localWeek:string;publishAt:Date}[]{
 const week=standingWeek(at,c.timezone);
 const format=new Intl.DateTimeFormat('en-CA',{timeZone:c.timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
 return [...c.cadence].sort((a,b)=>a.weekday-b.weekday||a.time.localeCompare(b.time)).flatMap((slot,index)=>{
  const date=new Date(`${week}T12:00:00Z`);date.setUTCDate(date.getUTCDate()+slot.weekday-1);const target=date.toISOString().slice(0,10),desired=`${target} ${slot.time}`,wall=Date.parse(`${target}T${slot.time}:00Z`),offsets=new Set<number>();
  // Sample both sides of transitions, then verify exact local fields. This
  // handles half-hour offsets without scanning thousands of minute instants.
  for(let hours=-36;hours<=36;hours+=6){const sample=wall+hours*3600000,parts=format.formatToParts(new Date(sample)),get=(key:string)=>parts.find(p=>p.type===key)!.value;offsets.add(Date.parse(`${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:00Z`)-sample);}
  const candidates=[...offsets].map(offset=>wall-offset).sort((a,b)=>a-b);
  for(const candidate of candidates){const instant=new Date(candidate),parts=format.formatToParts(instant),get=(key:string)=>parts.find(p=>p.type===key)!.value;
   if(`${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`===desired)return [{ordinal:index+1,localWeek:week,publishAt:instant}];
  }return [];
 });
}
