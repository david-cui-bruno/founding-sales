import {discoveryIntakeSavedSchema} from '@fss/contracts';
import type {OperationOutput} from '../../shared/operations.ts';
import type {DiscoveryBatch,DiscoveryCommand} from './discoveryImportBatch.ts';
import {reconcileDiscovery,type DiscoveryListPort,type DiscoveryPresence} from './discoveryImportReconcile.ts';
export type DiscoverySavePort=(input:DiscoveryCommand)=>Promise<OperationOutput<'sourcing.discoverySave'>>;
export interface DiscoveryProgress {
  phase:'ready'|'saving'|'paused'|'refused'|'reconciling'|'observed';
  acknowledged:number;
  // Historical receipt fields, not new rows this run. Replayed receipts repeat these fields.
  receiptNewlyPersisted:number;
  receiptExactDuplicates:number;
  refusal:boolean;
  uncertain:boolean;
  busy:boolean;
  reason:string|null;
  presence:DiscoveryPresence|null;
}
export interface DiscoveryImportController {
  state():DiscoveryProgress;
  run():Promise<void>;
  reconcile():Promise<void>;
  cancel():void;
}
let savePending=false;
const ambiguous=(reason:string|null)=>reason===null||['offline','unavailable','unreadable_answer','internal_error','session_changed_after_dispatch','refused','http_408','http_429'].includes(reason)||/^http_5\d\d$/u.test(reason);
const safeRefusals=new Set(['not_signed_in','not_authorized','forbidden','device_revoked','upgrade_required','session_changed','source_conflict','source_identity_conflict','candidate_identity_conflict','candidate_changed','candidate_format_not_supported','command_mismatch','command_id_conflict']);

/** Memory only. No automatic retry. Each explicit resume uses the unchanged command object. */
export function createDiscoveryImportController(batch:DiscoveryBatch,ports:{save:DiscoverySavePort;list:DiscoveryListPort},current:()=>boolean,changed:(state:DiscoveryProgress)=>void):DiscoveryImportController {
  let state:DiscoveryProgress={phase:'ready',acknowledged:0,receiptNewlyPersisted:0,receiptExactDuplicates:0,refusal:false,uncertain:false,busy:false,reason:null,presence:null};
  let turn=0,terminalRefusal=false;
  const publish=(patch:Partial<DiscoveryProgress>)=>{state={...state,...patch};if(current())changed({...state});};
  const valid=(mine:number)=>current()&&mine===turn;
  const observe=async(mine:number)=>{
    if(!valid(mine))return;
    publish({phase:'reconciling',presence:null,reason:null});
    try{
      const presence=await reconcileDiscovery(batch,ports.list,()=>valid(mine));
      if(!valid(mine))return;
      publish({phase:'observed',presence});
    }catch{
      if(valid(mine))publish({phase:'paused',presence:null,reason:'reconciliation_unverified'});
    }
  };
  return {
    state:()=>({...state}),
    cancel(){++turn;publish({phase:'paused',uncertain:state.uncertain||state.busy,reason:'cancelled',presence:null});},
    async run(){
      if(!current()||state.busy||terminalRefusal||(state.phase==='observed'&&state.acknowledged===batch.commands.length))return;
      const mine=++turn;publish({busy:true,phase:'saving',reason:null,presence:null});
      try{
        while(state.acknowledged<batch.commands.length){
          if(!valid(mine))return;
          const command=batch.commands[state.acknowledged]!;
          let answer:OperationOutput<'sourcing.discoverySave'>;
          if(savePending){publish({phase:'paused',uncertain:true,reason:'another_save_pending'});return;}
          savePending=true;
          try{answer=await ports.save(command);}catch{
            if(valid(mine))publish({phase:'paused',uncertain:true,reason:'ambiguous_response'});
            return;
          }finally{savePending=false;}
          if(!valid(mine))return;
          const receipt=discoveryIntakeSavedSchema.safeParse(answer.result);
          if(!receipt.success||answer.reason!==null){
            const uncertain=answer.result!==null||ambiguous(answer.reason);
            terminalRefusal=!uncertain;
            publish({phase:uncertain?'paused':'refused',refusal:terminalRefusal,uncertain,reason:uncertain?'ambiguous_response':safeRefusals.has(answer.reason??'')?answer.reason:'save_refused'});
            return;
          }
          publish({acknowledged:state.acknowledged+1,receiptNewlyPersisted:state.receiptNewlyPersisted+receipt.data.newlyPersisted,receiptExactDuplicates:state.receiptExactDuplicates+receipt.data.exactDuplicates,uncertain:false});
        }
        if(valid(mine))await observe(mine);
      }finally{publish({busy:false});}
    },
    async reconcile(){
      if(!current()||state.busy)return;
      const mine=++turn;publish({busy:true});
      try{if(valid(mine))await observe(mine);}finally{publish({busy:false});}
    },
  };
}
