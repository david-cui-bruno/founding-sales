import {z} from 'zod';
import {instant,uuid,socialVoiceSaveInputSchema,type SocialVoiceSaveInput} from '@fss/contracts';
import type {BrowserClient} from './BrowserClient.ts';
import {privateDraftCanonicalJson,privateDraftSHA256} from './PrivateDraftCustody.ts';
export const VOICE_PENDING_KEY='callie.browser.pending-private-voice.v1';
export const voicePendingSchema=z.strictObject({identity:z.string().min(1),expiresAt:instant,commandId:uuid,operation:z.enum(['create','update','remove','restart']),guideId:uuid.optional(),expectedRevision:z.number().int().positive().optional(),payloadSHA256:z.string().regex(/^[a-f0-9]{64}$/u)});
export type VoicePending=z.infer<typeof voicePendingSchema>;
/** IDs and canonical payload fingerprint only. No guide content crosses storage. */
export class VoicePreferenceCustody{
 constructor(private readonly client:BrowserClient,private readonly storage:Pick<Storage,'getItem'|'setItem'|'removeItem'>=localStorage){}
 binding():{identity:string;expiresAt:string}|null{const s=this.client.current;return s?.status==='signed_in'&&this.client.isCurrent(this.client.epoch)?{identity:JSON.stringify([s.workspaceId,s.userId,s.deviceId,s.role,s.revision]),expiresAt:s.expiresAt}:null;}
 read():VoicePending|null{
  const binding=this.binding();if(!binding)return null;
  const raw=this.storage.getItem(VOICE_PENDING_KEY);if(raw===null)return null;
  const held=voicePendingSchema.parse(JSON.parse(raw));
  if(held.identity!==binding.identity){this.storage.removeItem(VOICE_PENDING_KEY);return null;}
  // Expiry is not evidence that an uncertain command did not commit.
  if(Date.parse(held.expiresAt)<=Date.now()||Date.parse(held.expiresAt)>Date.parse(binding.expiresAt))throw Error('Voice custody expired or unavailable');
  return held;
 }
 async exclusive<T>(work:()=>Promise<T>):Promise<T>{const binding=this.binding();if(!binding||!navigator.locks)throw Error('Voice custody unavailable');return navigator.locks.request(`callie.private-voice:${binding.identity}`,{mode:'exclusive'},work);}
 async prepare(raw:SocialVoiceSaveInput,current:()=>boolean):Promise<{held:VoicePending;payload:SocialVoiceSaveInput}>{
  const payload=socialVoiceSaveInputSchema.parse(raw),binding=this.binding();if(!binding||this.read()||!current())throw Error('Reconcile pending voice command');
  const payloadSHA256=await privateDraftSHA256(privateDraftCanonicalJson(payload));
  if(!current()||this.binding()?.identity!==binding.identity||this.read())throw Error('Voice authority changed');
  const held=voicePendingSchema.parse({...binding,commandId:crypto.randomUUID(),operation:payload.operation,...(payload.operation==='create'?{}:{guideId:payload.guideId,expectedRevision:payload.expectedRevision}),payloadSHA256});
  const bytes=JSON.stringify(held);this.storage.setItem(VOICE_PENDING_KEY,bytes);if(this.storage.getItem(VOICE_PENDING_KEY)!==bytes)throw Error('Voice storage unavailable');
  return {held,payload};
 }
 assert(held:VoicePending):void{if(JSON.stringify(this.read())!==JSON.stringify(held))throw Error('Voice custody changed');}
 complete(held:VoicePending):void{this.assert(held);this.storage.removeItem(VOICE_PENDING_KEY);if(this.storage.getItem(VOICE_PENDING_KEY)!==null)throw Error('Voice storage unavailable');}
 clear():void{try{this.storage.removeItem(VOICE_PENDING_KEY);}catch{/* A different binding cannot use retained identity. */}}
}
