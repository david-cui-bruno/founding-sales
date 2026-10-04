import {useCallback,useEffect,useReducer} from 'react';
import type {MeetingRecordingSetupView} from '@fss/contracts';
import {useSessionEpoch} from '../app/drafts.tsx';
interface Entry {view:MeetingRecordingSetupView|null;open:boolean;busy:boolean;generation:number;message:string|null;pending:{meetingId:string;expectedVersion:number;commandId:string}|null}
let memory:{epoch:object|null;entries:Map<string,Entry>}={epoch:null,entries:new Map()};
const listeners=new Set<()=>void>();
export function useRecordingSetupMemory(id:string){
  const epoch=useSessionEpoch(),[,bump]=useReducer((n:number)=>n+1,0);
  if(memory.epoch!==epoch)memory={epoch,entries:new Map()};
  let entry=memory.entries.get(id);if(!entry){entry={view:null,open:false,busy:false,generation:0,message:null,pending:null};memory.entries.set(id,entry);}
  useEffect(()=>{const listener=()=>{bump();};listeners.add(listener);return()=>{listeners.delete(listener);};},[]);
  const touch=useCallback(()=>{for(const listener of listeners)listener();},[]);
  return {entry,touch};
}
