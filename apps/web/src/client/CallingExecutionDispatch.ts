import {z} from 'zod';
import {callSessionCreatedSchema,callingStatusResponseSchema,callingIdentityListSchema,voiceAccessTokenResponseSchema,pluralFirmPageResponseSchema,callingExecutionReceiptSchema,type CallingExecutionReceipt} from '@fss/contracts';
import type {CallingExecutionCustody,CallingExecutionPending,CallingExecutionPayload} from './CallingExecutionPending.ts';
import {browserCallingVoiceDevice,requestCallingMicrophone,type CallingVoiceCall,type CallingVoiceDevice,type CallingVoiceDeviceFactory} from './CallingVoiceDevice.ts';
const unavailable=z.strictObject({availability:z.literal('unavailable'),reason:z.string()});
const sessionAnswer=z.union([z.strictObject({status:z.literal('accepted'),replayed:z.boolean(),result:callSessionCreatedSchema}),z.strictObject({status:z.literal('refused'),replayed:z.boolean(),reason:z.string()}),unavailable]);
export interface CallingExecutionLink{firmId:string;sessionId:string;routeId:string;callingIdentityId:string;contactId?:string;}
export interface CallingExecutionState{phase:'idle'|'starting'|'ringing'|'connected'|'unknown'|'terminal'|'refused';message:string;muted:boolean;link:CallingExecutionLink|null;}
export interface CallingExecutionPorts{device?:CallingVoiceDeviceFactory;microphone?:()=>Promise<void>;}
const terminal=new Set(['completed','failed','canceled']);
/** No replay operation exists. Receipt recovery cannot reach the SDK factory. */
export class CallingExecutionController{
 private generation=0;
 private running=false;
 private device:CallingVoiceDevice|null=null;
 private call:CallingVoiceCall|null=null;
 private release:(()=>void)|null=null;
 private state:CallingExecutionState={phase:'idle',message:'No browser call started.',muted:false,link:null};
 constructor(readonly custody:CallingExecutionCustody,private readonly publish:(state:CallingExecutionState)=>void,private readonly ports:CallingExecutionPorts={}){}
 private update(state:CallingExecutionState):void{this.state=state;this.publish(state);}
 private teardown():void{const call=this.call,device=this.device;this.call=null;this.device=null;try{call?.disconnect();}catch{/* Keep uncertainty. */}try{device?.destroy();}catch{/* Keep uncertainty. */}this.release?.();this.release=null;}
 stop():void{this.generation++;this.teardown();this.update({phase:'unknown',message:'Local audio stopped or setup abandoned. Remote termination is not confirmed. Recover the exact receipt.',muted:false,link:null});}
 dispose():void{this.generation++;this.teardown();}
 mute():void{if(!this.call)return;try{const muted=!this.state.muted;this.call.mute(muted);this.update({...this.state,muted});}catch{this.stop();}}
 async start(input:CallingExecutionPayload,isScopeCurrent:()=>boolean):Promise<void>{
  if(this.running)return;
  this.running=true;const mine=++this.generation,epoch=this.custody.client.epoch;
  const current=():boolean=>mine===this.generation&&isScopeCurrent()&&this.custody.client.isCurrent(epoch)&&this.custody.binding()!==null;
  const check=():void=>{if(!current())throw Error('Call scope changed');};
  this.update({phase:'starting',message:'Requesting microphone and checking the current route. No call is confirmed.',muted:false,link:null});
  try{await this.custody.lifecycle(async()=>{
   check();if(this.custody.read())throw Error('Another call is uncertain');
   await (this.ports.microphone??requestCallingMicrophone)();check();
   const client=this.custody.client,session=client.current;if(session?.status!=='signed_in')throw Error('Call authority changed');const userId=session.userId;
   const page=await client.request('/crm/firm-page-v3',pluralFirmPageResponseSchema,{firmId:input.firmId,pageVersion:2,include:['stops']},check);check();
   const firm=page.read.firm;
   if(page.read.visibility!=='assigned_or_admin'||firm.id!==input.firmId||firm.status!=='active'||firm.assignedUserId!==userId)throw Error('Current assigned Firm unavailable');
   const route=page.read.firm.phoneRoutes.find(r=>r.id===input.routeId);
   if(!route||route.version!==input.routeVersion||route.contactId!==input.contactId&&!(route.contactId===null&&input.contactId===undefined))throw Error('Displayed route changed');
   const identities=await client.request('/calling-identities',callingIdentityListSchema,undefined,check);check();
   if(!identities.identities.some(i=>i.id===input.callingIdentityId&&i.ownerUserId===userId&&i.disabledAt===null&&(i.enabled||i.verificationStatus==='unverified')))throw Error('Own calling identity unavailable');
   const status=await client.request(`/calls/calling?firmId=${input.firmId}`,z.union([callingStatusResponseSchema,unavailable]),undefined,check);check();
   if('availability'in status||status.cadence.parked||status.cadence.refusal)throw Error('Calling unavailable or held');
   const token=await client.request('/calls/access-token',z.union([voiceAccessTokenResponseSchema,unavailable]),{},check);check();
   if('availability'in token||token.identity!==userId||Date.parse(token.expiresAt)<=Date.now())throw Error('Calling token unavailable');
   let held=await this.custody.prepare(input,current);check();
   const created=await client.request('/calls/session',sessionAnswer,{...input,commandId:held.commandId},()=>{check();this.custody.assert(held);});check();
   if('status'in created&&created.status==='refused'){await this.custody.complete(held,current);this.update({phase:'refused',message:'The call was refused by current calling policy. No automatic retry.',muted:false,link:null});return;}
   if(!('status'in created))throw Error('Session creation not confirmed');
   if(created.replayed)throw Error('Historical session cannot reconnect');
   held=await this.custody.session(held,created.result.sessionId,current);check();
   if(Date.parse(created.result.expiresAt)<=Date.now())throw Error('Session expired before connection');
   const made=await (this.ports.device??browserCallingVoiceDevice)(token.token);
   if(!current()){made.destroy();return;}this.device=made;
   if(Date.parse(created.result.expiresAt)<=Date.now()){made.destroy();throw Error('Session expired during device setup');}
   const placed=await made.connect({sessionId:created.result.sessionId});
   if(!current()){placed.disconnect();made.destroy();return;}
   this.call=placed;
   const end=():void=>{if(current())this.stop();};
   placed.on('accept',()=>{if(current())this.update({phase:'connected',message:'Audio connected. Record the actual disposition separately after server-confirmed termination.',muted:false,link:null});});
   for(const event of ['disconnect','cancel','reject','error'] as const)placed.on(event,end);
   this.update({phase:'ringing',message:'Connecting the browser audio. Hang up is local until server termination is confirmed.',muted:false,link:null});
   await new Promise<void>(resolve=>{this.release=resolve;});
  });}catch{
   if(current()){this.teardown();let held:CallingExecutionPending|null=null;try{held=this.custody.read();}catch{/* Storage failure remains fail-closed. */}this.update({phase:held?'unknown':'refused',message:held?'Call UNKNOWN. No replay or reconnect. Recover the exact receipt.':'Call not started or calling custody unavailable. Check microphone permission and current calling configuration before a new explicit attempt.',muted:false,link:null});}
  }finally{this.running=false;}
 }
 async recover(isScopeCurrent:()=>boolean):Promise<CallingExecutionReceipt|null>{
  if(this.running||this.call)return null;
  const mine=++this.generation,epoch=this.custody.client.epoch,current=():boolean=>mine===this.generation&&isScopeCurrent()&&this.custody.client.isCurrent(epoch)&&this.custody.binding()!==null;
  try{return await this.custody.lifecycle(async()=>{
   const held=this.custody.read();if(!held||!current())return null;
   const receipt=await this.custody.client.request('/calling/execution/receipt',callingExecutionReceiptSchema,{firmId:held.firmId,commandId:held.commandId,payloadSHA256:held.payloadSHA256},()=>{if(!current())throw Error('Call scope changed');this.custody.assert(held);});
   if(!current())return null;
   if(receipt.state==='accepted'&&(receipt.firmId!==held.firmId||held.sessionId!==undefined&&held.sessionId!==receipt.sessionId))throw Error('Receipt identity changed');
   if(receipt.state==='refused'||receipt.state==='accepted'&&(terminal.has(receipt.status)||receipt.status==='expired_unconsumed')){
    await this.custody.complete(held,current);
    const link=receipt.state==='accepted'&&terminal.has(receipt.status)?{firmId:held.firmId,sessionId:receipt.sessionId,routeId:held.routeId,callingIdentityId:held.callingIdentityId,...(held.contactId?{contactId:held.contactId}:{})}:null;
    this.update({phase:'terminal',message:link?'Server confirmed call termination. Select the actual disposition, no outcome is inferred.':'Server confirmed refusal or expiry without consumption. No call disposition is inferred.',muted:false,link});
   }else this.update({phase:'unknown',message:'Call remains UNKNOWN or active on the server. No reconnect or replacement call.',muted:false,link:null});
   return receipt;
  });}catch{if(current())this.update({phase:'unknown',message:'Receipt unavailable. Uncertainty remains held, no reconnect or replacement call.',muted:false,link:null});return null;}
 }
}
