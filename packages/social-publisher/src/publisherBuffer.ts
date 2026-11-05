export class PublisherRefusal extends Error {constructor(readonly reason:string){super(reason);this.name='PublisherRefusal';}}
export type PublisherTransport=(url:string,init:RequestInit)=>Promise<Response>;
export class BufferGraphQL {
 constructor(private readonly transport:PublisherTransport=fetch){}
 async request<T>(apiKey:string,query:string,variables:Record<string,unknown>={}):Promise<T>{
  if(!apiKey||apiKey.length>4096||!/^[!-~]+$/u.test(apiKey))throw new PublisherRefusal('credential_invalid');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);timer.unref();
  try{
   const response=await this.transport('https://api.buffer.com',{method:'POST',redirect:'error',signal:controller.signal,headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({query,variables})});
   if(response.status===401||response.status===403)throw new PublisherRefusal('credential_revoked');
   if(!response.ok)throw new PublisherRefusal(response.status===429?'provider_rate_limited':'remote_unavailable');
   if(!response.body)throw new PublisherRefusal('remote_unavailable');
   const reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
   try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>512000){await reader.cancel();throw new PublisherRefusal('remote_unavailable');}chunks.push(part.value);}}finally{reader.releaseLock();}
   const json:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));
   if(!json||typeof json!=='object'||!('data' in json)||('errors' in json&&Array.isArray(json.errors)&&json.errors.length))throw new PublisherRefusal('remote_unavailable');
   return json.data as T;
  }catch(error){if(error instanceof PublisherRefusal)throw error;throw new PublisherRefusal('remote_unavailable');}finally{clearTimeout(timer);}
 }
}
export const CHANNEL_FIELDS='id organizationId service type serviceId externalLink name displayName isDisconnected isLocked isQueuePaused allowedActions';
export const POST_FIELDS=`id channelId channel { organizationId serviceId service type } text dueAt createdAt status schedulingType isCustomScheduled externalLink allowedActions assets { __typename ... on ImageAsset { id source mimeType image { altText } } }`;
export interface BufferChannel {id:string;organizationId:string;service:string;type:string;serviceId:string;externalLink:string|null;name:string;displayName:string|null;isDisconnected:boolean;isLocked:boolean;isQueuePaused:boolean;allowedActions:string[]}
export interface BufferPost {id:string;channelId:string;channel:{organizationId:string;serviceId:string;service:string;type:string};text:string;dueAt:string|null;createdAt:string;status:string;schedulingType:string|null;isCustomScheduled:boolean;externalLink:string|null;allowedActions:string[];assets:{__typename:string;id?:string|null;source?:string;mimeType?:string;image?:{altText:string}}[]}
export function requireChannel(channel:BufferChannel,allowPaused=false):void {
 if(channel.service!=='linkedin'||channel.type!=='profile')throw new PublisherRefusal('account_mismatch');
 if(channel.isLocked||channel.isDisconnected)throw new PublisherRefusal('channel_unavailable');
 if(channel.isQueuePaused&&!allowPaused)throw new PublisherRefusal('queue_paused');
 if(!['readUpdates','scheduleUpdates','manageUpdates'].every(action=>channel.allowedActions.includes(action)))throw new PublisherRefusal('channel_permission_denied');
 if(!/^[a-f0-9]{24}$/iu.test(channel.id)||!/^[a-f0-9]{24}$/iu.test(channel.organizationId)||!channel.serviceId||channel.serviceId.length>300)throw new PublisherRefusal('account_mismatch');
}
