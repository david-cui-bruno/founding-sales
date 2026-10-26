export type CallingVoiceEvent='ringing'|'accept'|'disconnect'|'cancel'|'reject'|'error';
export interface CallingVoiceCall{on(event:CallingVoiceEvent,listener:(detail?:unknown)=>void):void;mute(value:boolean):void;disconnect():void;}
export interface CallingVoiceDevice{connect(params:{sessionId:string}):Promise<CallingVoiceCall>;destroy():void;}
export type CallingVoiceDeviceFactory=(token:string)=>Promise<CallingVoiceDevice>;
/** Browser SDK is bundled locally. Only an original, current explicit start calls it. */
export const browserCallingVoiceDevice:CallingVoiceDeviceFactory=async token=>{
 const {Device}=await import('@twilio/voice-sdk');
 const device=new Device(token,{logLevel:'error'});
 return {connect:async({sessionId})=>{const call=await device.connect({params:{sessionId}});return {on:(event,listener)=>{call.on(event,listener);},mute:value=>{call.mute(value);},disconnect:()=>{call.disconnect();}};},destroy:()=>{device.destroy();}};
};
/** Explicit permission acquisition before any session/token. Tracks never escape. */
export async function requestCallingMicrophone():Promise<void>{
 if(!globalThis.isSecureContext||!navigator.mediaDevices?.getUserMedia)throw Error('Microphone unavailable on this origin');
 const stream=await navigator.mediaDevices.getUserMedia({audio:true,video:false});
 for(const track of stream.getTracks())track.stop();
}
