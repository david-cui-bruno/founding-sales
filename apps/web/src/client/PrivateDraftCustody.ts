import {z} from 'zod';
import {instant,uuid,socialPrivateDraftHashSchema,socialPrivateDraftSaveInputSchema,type SocialPrivateDraftSaveInput} from '@fss/contracts';
import type {BrowserClient} from './BrowserClient.ts';
export const PRIVATE_DRAFT_PENDING_KEY='callie.browser.pending-private-social.v1';
export const privateDraftPendingSchema=z.strictObject({identity:z.string(),expiresAt:instant,commandId:uuid,operation:z.enum(['create','update']),draftId:uuid.optional(),expectedRevision:z.number().int().positive().optional(),payloadSHA256:socialPrivateDraftHashSchema});
export type PrivateDraftPending=z.infer<typeof privateDraftPendingSchema>;
// Same canonical sorted-key JSON recipe as the existing API command runner.
export function privateDraftCanonicalJson(value:unknown):string{
 if(value===undefined||value===null)return 'null';
 if(typeof value==='number')return Number.isFinite(value)?JSON.stringify(value):'null';
 if(typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);
 if(Array.isArray(value))return `[${value.map(privateDraftCanonicalJson).join(',')}]`;
 if(typeof value==='object')return `{${Object.entries(value as Record<string,unknown>).filter(([,v])=>v!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>`${JSON.stringify(k)}:${privateDraftCanonicalJson(v)}`).join(',')}}`;
 return 'null';
}
export async function privateDraftSHA256(bytes:string):Promise<string>{const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(bytes));return Array.from(new Uint8Array(hash),n=>n.toString(16).padStart(2,'0')).join('');}
export class PrivateDraftCustody{
 constructor(private readonly client:BrowserClient,private readonly storage:Pick<Storage,'getItem'|'setItem'|'removeItem'>=localStorage){}
 binding():{identity:string;expiresAt:string}|null{const s=this.client.current;return s?.status==='signed_in'&&this.client.isCurrent(this.client.epoch)?{identity:JSON.stringify([s.workspaceId,s.userId,s.deviceId,s.role,s.revision]),expiresAt:s.expiresAt}:null;}
 read():PrivateDraftPending|null{
  const binding=this.binding();if(!binding)return null;
  const raw=this.storage.getItem(PRIVATE_DRAFT_PENDING_KEY);if(raw===null)return null;
  const held=privateDraftPendingSchema.parse(JSON.parse(raw));
  if(held.identity!==binding.identity||Date.parse(held.expiresAt)<=Date.now()||Date.parse(held.expiresAt)>Date.parse(binding.expiresAt)){this.storage.removeItem(PRIVATE_DRAFT_PENDING_KEY);return null;}
  return held;
 }
 async exclusive<T>(work:()=>Promise<T>):Promise<T>{
  const binding=this.binding();if(!binding||!navigator.locks)throw Error('Private save custody unavailable');
  return navigator.locks.request(`callie.private-social:${binding.identity}`,{mode:'exclusive'},work);
 }
 async prepare(raw:SocialPrivateDraftSaveInput,current:()=>boolean):Promise<{held:PrivateDraftPending;payload:SocialPrivateDraftSaveInput}>{
  const payload=socialPrivateDraftSaveInputSchema.parse(raw),binding=this.binding();if(!binding||this.read()||!current())throw Error('Reconcile pending private save');
  const payloadSHA256=await privateDraftSHA256(privateDraftCanonicalJson(payload));
  if(!current()||this.binding()?.identity!==binding.identity||this.read())throw Error('Private save authority changed');
  const held=privateDraftPendingSchema.parse({...binding,commandId:crypto.randomUUID(),operation:payload.operation,...(payload.operation==='update'?{draftId:payload.draftId,expectedRevision:payload.expectedRevision}:{}),payloadSHA256});
  const bytes=JSON.stringify(held);this.storage.setItem(PRIVATE_DRAFT_PENDING_KEY,bytes);if(this.storage.getItem(PRIVATE_DRAFT_PENDING_KEY)!==bytes)throw Error('Private save storage unavailable');
  return {held,payload};
 }
 assert(held:PrivateDraftPending):void{if(JSON.stringify(this.read())!==JSON.stringify(held))throw Error('Private save custody changed');}
 complete(held:PrivateDraftPending):void{this.assert(held);this.storage.removeItem(PRIVATE_DRAFT_PENDING_KEY);if(this.storage.getItem(PRIVATE_DRAFT_PENDING_KEY)!==null)throw Error('Private save storage unavailable');}
 clear():void{try{this.storage.removeItem(PRIVATE_DRAFT_PENDING_KEY);}catch{/* No stale binding may use held state. */}}
}
