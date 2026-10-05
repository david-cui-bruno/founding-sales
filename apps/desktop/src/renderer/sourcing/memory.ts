import {useCallback,useEffect,useReducer,useState} from 'react';
import type {OperationInput,OperationOutput} from '../../shared/operations.ts';
import {useSessionEpoch} from '../app/drafts.tsx';
export type Pending = {kind:'check';input:OperationInput<'sourcing.check'>}|{kind:'save';input:OperationInput<'sourcing.save'>}|{kind:'review';input:OperationInput<'sourcing.review'>}|{kind:'remove';input:OperationInput<'sourcing.delete'>};
export type EvidencePending={kind:'qualify';input:OperationInput<'sourcing.qualify'>}|{kind:'admit';input:OperationInput<'sourcing.admit'>}|{kind:'feedback';input:OperationInput<'sourcing.feedback'>};
export interface EvidenceMemory {open:boolean;busy:boolean;loading:boolean;view:OperationOutput<'sourcing.qualification'>['view'];message:string|null;pending:EvidencePending|null;generation:number}
interface Memory {
  evidence:Map<string,EvidenceMemory>;
  draft:Record<string,string>;adding:boolean;filter:OperationInput<'sourcing.list'>;
  view:OperationOutput<'sourcing.list'>['view'];loading:boolean;failed:boolean;generation:number;
  busy:boolean;pending:Pending|null;message:string|null;deleteId:string|null;listeners:Set<()=>void>;
}
const fresh=():Memory=>({evidence:new Map(),draft:{region:'TX',signal:'fit_only'},adding:false,filter:{status:'needs_review',offset:0},view:null,loading:false,failed:false,generation:0,busy:false,pending:null,message:null,deleteId:null,listeners:new Set()});
const sessions=new WeakMap<object,Memory>();
export function useCandidateMemory() {
  const epoch=useSessionEpoch(),[fallback]=useState(fresh),[,bump]=useReducer((n:number)=>n+1,0);
  let memory=epoch===null?fallback:sessions.get(epoch);
  if(memory===undefined){memory=fresh();sessions.set(epoch!,memory);}
  const state=memory;
  useEffect(()=>{const listener=()=>{bump();};state.listeners.add(listener);return()=>{state.listeners.delete(listener);};},[state]);
  const touch=useCallback(()=>{for(const listener of state.listeners)listener();},[state]);
  return {memory:state,touch};
}
