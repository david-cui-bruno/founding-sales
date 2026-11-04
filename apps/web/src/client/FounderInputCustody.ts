import {z} from 'zod';
import type {BrowserClient} from './BrowserClient.ts';
import {privateDraftCanonicalJson,privateDraftSHA256} from './PrivateDraftCustody.ts';
const pendingSchema=z.strictObject({identity:z.string(),expiresAt:z.string().datetime(),commandId:z.string().uuid(),payloadSHA256:z.string().regex(/^[a-f0-9]{64}$/u),kind:z.enum(['input','calibration'])});
export type FounderPending=z.infer<typeof pendingSchema>;
/** Only opaque command custody is durable, never notes, examples or style prose. */
export class FounderInputCustody{
 constructor(private readonly client:BrowserClient,readonly kind:'input'|'calibration'){}
 binding(){const s=this.client.current;return s?.status==='signed_in'&&this.client.isCurrent(this.client.epoch)?{key:`callie.social-founder.${this.kind}:`+JSON.stringify([s.workspaceId,s.userId,s.deviceId]),identity:JSON.stringify([s.workspaceId,s.userId,s.deviceId,s.role,s.revision]),expiresAt:s.expiresAt}:null;}
 read():FounderPending|null{const b=this.binding();if(!b||!navigator.locks)throw Error('Custody unavailable');const raw=localStorage.getItem(b.key);if(raw===null)return null;const held=pendingSchema.parse(JSON.parse(raw));if(held.identity!==b.identity||Date.parse(held.expiresAt)<=Date.now()||Date.parse(held.expiresAt)>Date.parse(b.expiresAt))throw Error('Original current authority required');return held;}
 async exclusive<T>(work:()=>Promise<T>):Promise<T>{const b=this.binding();if(!b||!navigator.locks)throw Error('Custody unavailable');return navigator.locks.request(b.key,{mode:'exclusive'},async()=>{if(this.binding()?.identity!==b.identity)throw Error('Authority changed');return work();});}
 async prepare(payload:unknown,current:()=>boolean):Promise<FounderPending>{const b=this.binding();if(!b||this.read()||!current())throw Error('Reconcile first');const hash=await privateDraftSHA256(privateDraftCanonicalJson(payload));if(!current()||this.binding()?.identity!==b.identity||this.read())throw Error('Authority changed');const held=pendingSchema.parse({identity:b.identity,expiresAt:b.expiresAt,kind:this.kind,commandId:crypto.randomUUID(),payloadSHA256:hash});const bytes=JSON.stringify(held);localStorage.setItem(b.key,bytes);if(localStorage.getItem(b.key)!==bytes)throw Error('Custody unavailable');return held;}
 assert(held:FounderPending){if(JSON.stringify(this.read())!==JSON.stringify(held))throw Error('Custody changed');}
 complete(held:FounderPending){this.assert(held);const b=this.binding();if(!b)throw Error('Authority changed');localStorage.removeItem(b.key);if(localStorage.getItem(b.key)!==null)throw Error('Custody unavailable');}
 clear(key:string):void{localStorage.removeItem(key);if(localStorage.getItem(key)!==null)throw Error('Custody unavailable');}
}
