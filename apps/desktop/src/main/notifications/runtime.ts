import type {NotificationRuntimeStatus,TodayActionTarget} from '@fss/contracts';
import type {AuthedClient} from '../authedClient.ts';
import {createNotificationApiPort} from './api.ts';
import {createActionableNotificationPump} from './pump.ts';
import type {NativeNotificationPort} from './native.ts';
import type {NotificationIdentity} from './runner.ts';

/** Session composition: awaits current identity and guards late wakeups across sleep/sign-out. */
export function createNotificationRuntime(deps:{api:AuthedClient;native:NativeNotificationPort;identity():Promise<NotificationIdentity|null>;generation():number;now():string;openTarget(target:TodayActionTarget,generation:number):void}){
 let enabled=false,epoch=0;
 let held:NotificationIdentity|null=null,boundGeneration:number|null=null;
 let pump:ReturnType<typeof createActionableNotificationPump>|null=null;
 const activations=new Set<string>();
 async function refresh(){
  if(!enabled)return;
  const issued=epoch,generation=deps.generation();
  let identity:NotificationIdentity|null;
  try{identity=await deps.identity();}catch{identity=null;}
  if(!enabled||issued!==epoch||generation!==deps.generation())return;
  if(identity===null){pump?.stop();pump=null;held=null;boundGeneration=null;return;}
  if(pump===null||boundGeneration!==generation||held?.workspaceId!==identity.workspaceId||held?.userId!==identity.userId){
   pump?.stop();held=identity;boundGeneration=generation;
   const current=()=>enabled&&boundGeneration===generation&&deps.generation()===generation;
   pump=createActionableNotificationPump({api:createNotificationApiPort(deps.api,current),native:deps.native,identity:()=>current()?held:null,now:deps.now,openTarget:target=>{if(current())deps.openTarget(target,generation);}});
   pump.start();
  }else{pump.start();pump.wake();}
  for(const identifier of activations)pump.activate(identifier);
  activations.clear();
 }
 return {
  start(){enabled=true;void refresh();},
  wake(){void refresh();},
  activate(identifier:string){if(activations.size>=25)return;if(pump!==null){pump.activate(identifier);}else{activations.add(identifier);void refresh();}},
  stop(options:{clear?:boolean}={}){enabled=false;epoch++;pump?.stop(options);if(options.clear!==false){activations.clear();pump=null;held=null;boundGeneration=null;}},
  reset(){epoch++;activations.clear();pump?.stop();pump=null;held=null;boundGeneration=null;if(enabled)void refresh();},
  status():NotificationRuntimeStatus{return pump?.status()??{state:'stopped',lastCheckedAt:null};},
 };
}
