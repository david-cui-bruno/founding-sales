/** Internal preparation lead only. Publication remains exactly Tue/Thu 10AM New York. */
export function linkedinRecurringDay(at:string):{targetAt:string;preparing:boolean;missed:boolean}|null{
 const time=Date.parse(at);if(!Number.isFinite(time))return null;
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',weekday:'short',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(time).map(p=>[p.type,p.value]));
 if(parts['weekday']!=='Tue'&&parts['weekday']!=='Thu')return null;
 const localUtc=Date.UTC(Number(parts['year']),Number(parts['month'])-1,Number(parts['day']),Number(parts['hour']),Number(parts['minute']),Number(parts['second']));
 const offset=localUtc-Math.floor(time/1000)*1000;
 const target=Date.UTC(Number(parts['year']),Number(parts['month'])-1,Number(parts['day']),10)-offset;
 return {targetAt:new Date(target).toISOString(),preparing:time>=target-1800000&&time<target,missed:time>=target};
}
