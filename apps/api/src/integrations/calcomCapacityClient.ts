import type {CalcomCapacityClient} from '@fss/domain/meetings/bookingCapacity.ts';
export type CalcomCapacityHttp=(url:string,init:{method:'GET';headers:Record<string,string>;signal:AbortSignal;redirect:'error'})=>Promise<Response>;
/** Official /v2/me and event-type reads only. No appointment/configuration writes. */
export function calcomCapacityClient(options:{apiKey:string;http?:CalcomCapacityHttp}):CalcomCapacityClient {
  const http=options.http??(async(url,init)=>await fetch(url,init));
  const read=async(url:URL,eventVersion=false):Promise<unknown>=>{
    let response:Response;
    try {response=await http(url.toString(),{method:'GET',headers:{authorization:`Bearer ${options.apiKey}`,accept:'application/json',...(eventVersion?{'cal-api-version':'2026-06-12'}:{})},signal:AbortSignal.timeout(10_000),redirect:'error'});}catch {throw new Error('provider_unreachable');}
    if(response.status===401)throw new Error('provider_unauthorized');
    if(response.status===403)throw new Error('provider_forbidden');
    if(response.status===429)throw new Error('provider_rate_limited');
    if(response.status!==200)throw new Error('provider_unreachable');
    try {
      const limit=128*1024,declared=Number(response.headers.get('content-length')??'');
      if(declared>limit||response.body===null)throw new Error('invalid');
      const reader=response.body.getReader(),chunks:Uint8Array[]=[];let total=0;
      try {for(;;){const part=await reader.read();if(part.done)break;total+=part.value.byteLength;if(total>limit)throw new Error('invalid');chunks.push(part.value);}}
      finally {await reader.cancel().catch(()=>undefined);}
      const body:unknown=JSON.parse(Buffer.concat(chunks,total).toString('utf8'));
      if(typeof body!=='object'||body===null||Array.isArray(body))throw new Error('invalid');
      const answer=body as Record<string,unknown>;
      if(answer['status']!=='success')throw new Error('invalid');
      return answer['data'];
    }catch {throw new Error('provider_invalid_response');}
  };
  return {
    async readProfile(){return await read(new URL('/v2/me','https://api.cal.com'));},
    async readEventTypes(input){
      const url=new URL('/v2/event-types','https://api.cal.com');url.searchParams.set('username',input.username);url.searchParams.set('eventSlug',input.eventSlug);
      const events=await read(url,true);
      if(!Array.isArray(events)||events.length>100)throw new Error('provider_invalid_response');
      return events;
    },
  };
}
