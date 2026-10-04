import { useCallback,useEffect,useReducer } from 'react';
import type { MeetingDraftEdit,MeetingFollowThroughView } from '@fss/contracts';
import { useSessionEpoch } from '../app/drafts.tsx';
export interface RecapForm { subject:string;body:string;planId:string;expectedPlanVersion:number;expectedDraftVersion:number; }
export interface FollowThroughEntry {
  open:boolean;view:MeetingFollowThroughView|null;form:RecapForm|null;editingUi:boolean;
  pending:(MeetingDraftEdit&{commandId:string})|null;busy:boolean;loading:boolean;generation:number;message:string|null;unavailable:boolean;gone:boolean;
}
let current:{epoch:object|null;entries:Map<string,FollowThroughEntry>}={epoch:null,entries:new Map()};
const listeners=new Set<()=>void>();
export function useFollowThroughMemory(meetingId:string) {
  const epoch=useSessionEpoch(),[,bump]=useReducer((n:number)=>n+1,0);
  if(current.epoch!==epoch)current={epoch,entries:new Map()};
  let entry=current.entries.get(meetingId);
  if(entry===undefined){entry={open:false,view:null,form:null,editingUi:false,pending:null,busy:false,loading:false,generation:0,message:null,unavailable:false,gone:false};current.entries.set(meetingId,entry);}
  useEffect(()=>{const listener=()=>{bump();};listeners.add(listener);return()=>{listeners.delete(listener);};},[]);
  const touch=useCallback(()=>{for(const listener of listeners)listener();},[]);
  return {entry,touch};
}
