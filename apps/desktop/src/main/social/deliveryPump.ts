import type {SocialDeliveryQueue} from '@fss/contracts';
interface PumpPorts {
 read():Promise<SocialDeliveryQueue>;
 run(item:SocialDeliveryQueue['items'][number],isCurrent:()=>boolean):Promise<void>;
}
/** Local app lifecycle only. No unattended publishing authorization is created here.
 * Wire only to verified adapters; stop on identity change, wake on network/app resume.
 */
export function createSocialDeliveryPump(port:PumpPorts){
 let epoch=0,enabled=false,running=false,again=false,timer:ReturnType<typeof setInterval>|null=null;
 async function tick(){
  if(!enabled)return;if(running){again=true;return;}running=true;
  const generation=epoch,current=()=>enabled&&epoch===generation;
  try{
   const queue=await port.read();
   for(const item of queue.items.slice(0,25)){
    if(!current())break;
    try{await port.run(item,current);}catch{/* Each persisted delivery owns its recovery state. */}
   }
  }catch{/* Offline/unreadable queue: wait for a bounded timer or explicit resume. */}
  finally{running=false;if(again&&enabled){again=false;void tick();}}
 }
 return {
  start(){if(enabled)return;enabled=true;epoch++;timer=setInterval(()=>void tick(),60_000);void tick();},
  wake(){void tick();},
  stop(){enabled=false;epoch++;again=false;if(timer)clearInterval(timer);timer=null;},
 };
}
