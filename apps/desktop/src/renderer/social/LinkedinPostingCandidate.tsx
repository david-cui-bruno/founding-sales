import {useEffect,useRef,useState} from 'react';
import type {LinkedinPostingPolicyView,LinkedinPostingCandidateBinding} from '@fss/contracts';
import {operations} from '../app/bridges.ts';
import {useSessionEpoch} from '../app/drafts.tsx';
import {Button} from '../ui/button.tsx';
export interface LinkedinPostingCandidatePorts{read():Promise<{view:LinkedinPostingPolicyView|null;reason:string|null}>;bind(input:{postId:string;postRevision:number;expectedRevision:number;commandId:string}):Promise<{binding:LinkedinPostingCandidateBinding|null;reason:string|null}>}
const defaults:LinkedinPostingCandidatePorts={read:async()=>{const api=operations();if(!api)throw new Error('unavailable');return api.read('social.postingPolicy',{});},bind:async input=>{const api=operations();if(!api)throw new Error('unavailable');return api.command('social.bindPostingCandidate',input);}};
export function LinkedinPostingCandidate({postId,postRevision,ports=defaults}:{postId:string;postRevision:number;ports?:LinkedinPostingCandidatePorts}){
 const epoch=useSessionEpoch(),live=useRef(0),port=useRef(ports);port.current=ports;
 const [view,setView]=useState<LinkedinPostingPolicyView|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState<string|null>(null),[unavailable,setUnavailable]=useState(false);
 const [bound,setBound]=useState<{policyRevision:number;current:boolean;reason:string|null}|null>(null),[pending,setPending]=useState<Parameters<LinkedinPostingCandidatePorts['bind']>[0]|null>(null);
 useEffect(()=>{const g=++live.current;setView(null);setMessage(null);setBound(null);setPending(null);setBusy(false);setUnavailable(false);void port.current.read().then(a=>{if(g===live.current)setView(a.view);}).catch(()=>{});return()=>{live.current=g+1;};},[epoch,postId,postRevision]);
 const refresh=async()=>{
  const g=live.current;setBusy(true);setMessage(null);
  try{const answer=await port.current.read();if(g!==live.current)return;setView(answer.view);setBound(null);setUnavailable(!answer.view&&answer.reason!=='session_changed');}
  catch{if(g===live.current)setUnavailable(true);}
  finally{if(g===live.current)setBusy(false);}
 };
 const bind=async()=>{
  if(!view||view.state!=='saved'||busy)return;
  const g=live.current,input=pending??{postId,postRevision,expectedRevision:view.revision,commandId:crypto.randomUUID()};setBusy(true);setPending(input);setMessage(null);
  try{
   const answer=await port.current.bind(input);if(g!==live.current)return;
   if(answer.binding){setBound({policyRevision:answer.binding.policyRevision,current:answer.binding.current,reason:answer.reason});setPending(null);}
   else if(['current_read_unavailable','session_changed'].includes(answer.reason??'')){setView(null);setBound(null);setPending(null);setUnavailable(answer.reason==='current_read_unavailable');}
   else if(['offline','unreadable_answer'].includes(answer.reason??''))setMessage('Binding is not confirmed. Retry the same request.');
   else{setPending(null);setMessage(`Binding refused: ${(answer.reason??'unavailable').replaceAll('_',' ')}. Refresh the post and policy before trying again.`);}
  }catch{if(g===live.current)setMessage('Binding is not confirmed. Retry the same request.');}
  finally{if(g===live.current)setBusy(false);}
 };
 const candidate=view?.candidates.find(c=>c.postId===postId&&c.postRevision===postRevision),revision=bound?.policyRevision??candidate?.policyRevision;
 const paused=bound?bound.current?null:bound.reason??'current_binding_unavailable':candidate?.current===false?candidate.reason:null;
 if(!view)return unavailable?<div className="space-y-2 text-xs text-muted-foreground"><p role="status">Current candidate binding is unavailable. Refresh posting policy before continuing.</p><Button variant="outline" disabled={busy} onClick={()=>void refresh()}>Refresh posting policy</Button></div>:null;
 return <div className="space-y-2 text-xs text-muted-foreground">
  {revision?<p>Owner-staged policy binding revision {revision}. {paused?`Paused: ${paused.replaceAll('_',' ')}.`:'Existing manual approval remains required.'} This is not automatic scheduling or grounding acceptance.</p>:view.state==='saved'?<Button variant="outline" disabled={busy} onClick={()=>void bind()}>{pending?'Retry same candidate binding':'Bind approved post to posting policy'}</Button>:<p>No current saved posting policy. Manual per-post approval is unchanged.</p>}
  {message&&<p role="status">{message}</p>}
 </div>;
}
