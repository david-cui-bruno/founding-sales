/** Shared by the two demo-recording adapters. Never returns error bodies. */
export type ProviderHttp = (url:string,init:RequestInit)=>Promise<Response>;
export const record = (value:unknown):Record<string,unknown> => typeof value==='object'&&value!==null&&!Array.isArray(value)?value as Record<string,unknown>:{};
export async function boundedProviderRequest(http:ProviderHttp,url:string,init:RequestInit,signal:AbortSignal,timeoutMs:number):Promise<{status:number;body:unknown;retryAfterMs:number|null}> {
  const controller=new AbortController();
  const abort=()=>{controller.abort();};
  const timer=setTimeout(abort,timeoutMs);
  signal.addEventListener('abort',abort,{once:true}); if(signal.aborted)abort();
  let rejectAbort:(reason:Error)=>void=()=>{};
  const aborted=new Promise<never>((_,reject)=>{rejectAbort=reject;});
  const reject=()=>{rejectAbort(new Error('provider_unreachable'));};
  controller.signal.addEventListener('abort',reject,{once:true}); if(controller.signal.aborted)reject();
  let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  try {
    const work=async()=>{
      const response=await http(url,{...init,redirect:'error',signal:controller.signal});
      const after=response.headers.get('retry-after');
      const retryAfterMs=after!==null&&/^\d+$/u.test(after)?Math.min(Number(after)*1000,2*60*60*1000):after!==null&&Number.isFinite(Date.parse(after))?Math.max(0,Math.min(Date.parse(after)-Date.now(),2*60*60*1000)):null;
      if(!response.ok){await response.body?.cancel();return {status:response.status,body:null,retryAfterMs};}
      if(Number(response.headers.get('content-length'))>1024*1024)throw new Error('provider_answer_invalid');
      let length=0;const chunks:Uint8Array[]=[];
      reader=response.body?.getReader();
      if(reader)while(true){const part=await reader.read();if(part.done)break;length+=part.value.byteLength;if(length>1024*1024)throw new Error('provider_answer_invalid');chunks.push(part.value);}
      const body=length===0?null:JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
      return {status:response.status,body,retryAfterMs};
    };
    return await Promise.race([work(),aborted]);
  } finally {
    clearTimeout(timer); signal.removeEventListener('abort',abort); controller.signal.removeEventListener('abort',reject);
    if(reader)void reader.cancel().catch(()=>{});
    controller.abort();
  }
}
export function readFailure(status:number,retryAfterMs:number|null):{kind:'retry'|'refused';code:string;retryAfterMs:number|null} {
  return {kind:status===429||status>=500?'retry':'refused',code:status===401||status===403?'auth_failed':status===429?'rate_limited':'provider_refused',retryAfterMs};
}
