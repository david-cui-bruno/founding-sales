import {useEffect,useRef,useState} from 'react';
import {callNeedSaveSchema,type CallNeedSave,type CallNeedView,type QualificationAnswer} from '@fss/contracts';
import {Button} from '../ui/button.tsx';
import {useDraft} from '../app/drafts.tsx';
import {noDefiniteAnswer} from '../today/afterCallModel.ts';
export interface CallNeedPorts {
 read(sessionId:string):Promise<{view:CallNeedView|null;reason:string|null}>;
 save(input:CallNeedSave):Promise<{result:{revision:number}|null;reason:string|null}>;
}
const defaults:CallNeedPorts={read:async sessionId=>await globalThis.callieApi?.read('sourcing.callNeed',{sessionId})??{view:null,reason:'offline'},save:async input=>await globalThis.callieApi?.command('sourcing.saveCallNeed',input)??{result:null,reason:'offline'}};
export function CallNeed({sessionId,ports=defaults,enabled=true}:{sessionId:string;ports?:CallNeedPorts;enabled?:boolean}){
 const [open,setOpen]=useDraft(`call-need:${sessionId}:open`,'false'),[pending,setPending]=useDraft(`call-need:${sessionId}:pending`,'');
 const [view,setView]=useState<CallNeedView|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState<string|null>(null);
 const epoch=useRef(0),p=useRef(ports);p.current=ports;
 useEffect(()=>{const activeEpoch=epoch;setBusy(false);setView(null);if(open!=='true')return;const generation=++activeEpoch.current;void p.current.read(sessionId).then(result=>{if(epoch.current!==generation)return;setView(result.view);setMessage(result.view?null:'Save an answered call outcome first, then reopen this section.');},()=>{if(epoch.current===generation)setMessage('Could not load this call. Reopen to retry.');});return()=>{activeEpoch.current++;};},[open,sessionId]);
 const save=async(answer:QualificationAnswer)=>{
  if(!enabled||busy||!view)return;
  let command:CallNeedSave;
  if(pending){let value:unknown;try{value=JSON.parse(pending);}catch{return;}const parsed=callNeedSaveSchema.safeParse(value);if(!parsed.success)return;command=parsed.data;}
  else{command={callLogId:view.callLogId,expectedRevision:view.revision,expectedSourceRevision:view.sourceRevision,answer,commandId:crypto.randomUUID()};setPending(JSON.stringify(command));}
  const generation=++epoch.current;setBusy(true);setMessage(null);
  try{const result=await p.current.save(command);if(generation!==epoch.current)return;
   if(result.result){setView({...view,answer:command.answer,revision:result.result.revision,stale:false});setPending('');setMessage('Saved for this call.');}
   else if(noDefiniteAnswer(result.reason))setMessage('Save not confirmed. Retry safely.');
   else{setPending('');setView(null);setMessage('The call changed or could not be saved. Reopen to review its current outcome.');}
  }catch{if(generation===epoch.current)setMessage('Save not confirmed. Retry safely.');}
  finally{if(generation===epoch.current)setBusy(false);}
 };
 return <div><Button size="sm" variant="quiet" aria-expanded={open==='true'} disabled={busy} onClick={()=>setOpen(open==='true'?'false':'true')}>Maintenance need</Button>{open==='true'?<section aria-label="Call maintenance need" className="space-y-2 rounded-lg border border-border p-3">
  <p className="text-sm">Did they confirm a maintenance problem on this call?</p>
  {view?<><p className="text-xs text-muted-foreground">{view.stale?'Outcome changed — confirm again.':`Saved: ${view.answer==='yes'?'confirmed need':view.answer==='no'?'not confirmed':'unknown'}`}</p><div className="flex gap-2">{(['yes','no','unknown'] as const).map(answer=><Button key={answer} size="sm" variant="outline" disabled={!enabled||busy||!!pending||(!view.canConfirm&&answer!=='unknown')} onClick={()=>void save(answer)}>{answer==='yes'?'Confirmed need':answer==='no'?'Not confirmed':'Unknown'}</Button>)}</div>{pending?<Button disabled={!enabled||busy} onClick={()=>void save('unknown')}>Retry confirmation</Button>:null}</>:null}
  {message?<p role="status" className="text-xs">{message}</p>:null}
 </section>:null}</div>;
}
