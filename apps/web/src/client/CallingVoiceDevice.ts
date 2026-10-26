export type CallingVoiceEvent='ringing'|'accept'|'disconnect'|'cancel'|'reject'|'error';
export interface CallingVoiceCall{on(event:CallingVoiceEvent,listener:(detail?:unknown)=>void):void;mute(value:boolean):void;disconnect():void;}
export interface CallingVoiceDevice{onError(listener:()=>void):()=>void;connect(params:{sessionId:string}):Promise<CallingVoiceCall>;destroy():void;}
export type CallingVoiceDeviceFactory=(token:string)=>Promise<CallingVoiceDevice>;
/** Browser SDK is bundled locally. Only an original, current explicit start calls it. */
export const browserCallingVoiceDevice:CallingVoiceDeviceFactory=async token=>{
 const {Device}=await import('@twilio/voice-sdk');
 const device=new Device(token,{logLevel:'error'});
 let closed=false,failed=false;const listeners=new Set<()=>void>();
 const error=():void=>{if(closed)return;failed=true;for(const listener of listeners)listener();};
 device.on('error',error);
 return {onError:listener=>{listeners.add(listener);if(failed&&!closed)listener();return()=>{listeners.delete(listener);};},connect:async({sessionId})=>{if(closed||failed)throw Error('Voice device unavailable');const call=await device.connect({params:{sessionId}});return {on:(event,listener)=>{call.on(event,listener);},mute:value=>{call.mute(value);},disconnect:()=>{call.disconnect();}};},destroy:()=>{if(closed)return;closed=true;listeners.clear();try{device.destroy();}finally{device.removeListener('error',error);}}};
};
/** Explicit permission acquisition before any session/token. Tracks never escape. */
export async function requestCallingMicrophone():Promise<void>{
 if(!globalThis.isSecureContext||!navigator.mediaDevices?.getUserMedia)throw Error('Microphone unavailable on this origin');
 const stream=await navigator.mediaDevices.getUserMedia({audio:true,video:false});
 for(const track of stream.getTracks())track.stop();
}
