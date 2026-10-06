/** Return both real instants in a DST overlap; never silently choose one or normalize a gap. */
export function socialScheduleInstants(local:string,zone:string):{instant:string;label:string}[]{
 const match=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u.exec(local);if(!match)return [];
 const [year,month,day,hour,minute]=match.slice(1).map(Number) as [number,number,number,number,number];
 const naive=Date.UTC(year,month-1,day,hour,minute);const roundTrip=new Date(naive);if(roundTrip.getUTCFullYear()!==year||roundTrip.getUTCMonth()!==month-1||roundTrip.getUTCDate()!==day||hour>23||minute>59)return [];
 let format:Intl.DateTimeFormat;try{format=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23',timeZoneName:'shortOffset'});}catch{return [];}
 const choices:{instant:string;label:string}[]=[];
 for(let offset=-840;offset<=840;offset+=15){const date=new Date(naive-offset*60_000);const parts=Object.fromEntries(format.formatToParts(date).map(p=>[p.type,p.value]));if(Number(parts['year'])===year&&Number(parts['month'])===month&&Number(parts['day'])===day&&Number(parts['hour'])===hour&&Number(parts['minute'])===minute)choices.push({instant:date.toISOString(),label:`${local.replace('T',' ')} ${parts['timeZoneName']??''}`});}
 return choices.sort((a,b)=>a.instant.localeCompare(b.instant));
}
