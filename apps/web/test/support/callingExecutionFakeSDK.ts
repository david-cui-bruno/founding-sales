// Test-only SDK replacement selected exclusively by the acceptance esbuild plugin.
// It cannot reach a provider, obtain audio, or mint a ticket. The production SDK is unchanged.
declare global { interface Window { __callingFake:{constructed:number;connects:{sessionId:string}[];destroyed:number;disconnects:number;microphones:number}; __callingFakeConnect:(input:{sessionId:string})=>Promise<void>; } }
export class Device{
 constructor(_token:string,_options:unknown){window.__callingFake.constructed++;}
 async connect({params}:{params:{sessionId:string}}){
  if(Object.keys(params).join(',')!=='sessionId')throw Error('Only sessionId allowed');
  window.__callingFake.connects.push(params);await window.__callingFakeConnect(params);
  let disconnected=false;const listeners=new Map<string,()=>void>();
  return {on(event:string,listener:()=>void){listeners.set(event,listener);if(event==='accept')setTimeout(()=>{if(!disconnected)listener();},10);},mute(_value:boolean){},disconnect(){if(disconnected)return;disconnected=true;window.__callingFake.disconnects++;listeners.get('disconnect')?.();}};
 }
 destroy(){window.__callingFake.destroyed++;}
}
