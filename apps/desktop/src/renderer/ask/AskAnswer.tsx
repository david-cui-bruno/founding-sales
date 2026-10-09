import {AskFollowOn,type AskFollowOnPorts} from "./AskFollowOn.tsx";
import {useCallback,useEffect,useRef,useState} from 'react';
import type {z} from 'zod';
import type {askAnswerRequestPayloadSchema,askAnswerAcknowledgmentSchema,askAnswerReadSchema,AskAnswerReadResult,askAnswerSourceReadSchema,askAnswerSourceResultSchema} from '@fss/contracts';
export interface AskAnswerPorts {
 answerRequest(input:z.infer<typeof askAnswerRequestPayloadSchema>):Promise<z.infer<typeof askAnswerAcknowledgmentSchema>>;
 answerRead(input:z.infer<typeof askAnswerReadSchema>):Promise<AskAnswerReadResult>;
 answerSourceRead(input:z.infer<typeof askAnswerSourceReadSchema>):Promise<z.infer<typeof askAnswerSourceResultSchema>>;
}
const reasons={
 purpose_unavailable:'Explanations are unavailable until processing is configured.',
 evaluation_unavailable:'Explanations are unavailable until evaluation is verified.',
 processing_authority_unavailable:'Processing permission is unavailable.',
 budget_held:'Processing budget is held.',
 input_bound_reached:'The selected input exceeds the processing limit.',
 source_unavailable:'Selected sources are unavailable. Select current source versions again.',
 source_changed:'Source evidence changed. Select current source versions again.',
 purpose_changed:'Processing configuration changed. Check current availability.',
 provider_acceptance_unknown:'Processing acceptance is unknown. Check this request; do not submit it again.',
 processing_failed:'Processing failed. Original evidence may still be available below.',
 unsupported_answer:'No supported explanation could be established.',
 deleted:'This explanation was deleted.',
};
const missingEvidence={
 no_supported_answer:'No supported answer was established.',
 inference_unverified:'An inference could not be verified.',
 conflict_unresolved:'Conflicting evidence remains unresolved.',
 input_partial:'Some input evidence was not processed.',
 semantic_coverage_unverified:'Semantic coverage is unverified.',
 no_relevant_passages:'No relevant passages were established.',
};
function resultNotice(result:AskAnswerReadResult){
 if(result.state==='stale')return 'This explanation is stale. Select current source versions again.';
 if(result.state==='deleted')return reasons.deleted;
 if(result.state==='unknown_acceptance')return reasons.provider_acceptance_unknown;
 return result.reason===null?null:reasons[result.reason];
}
type AskAnswerProps={ports:Partial<AskAnswerPorts>&Partial<AskFollowOnPorts>;enabled:boolean;onUnavailable?:()=>void}&((z.infer<typeof askAnswerRequestPayloadSchema>&{existingRequestId?:never})|{existingRequestId:string;question?:never;scope?:never});
export function AskAnswer({ports,enabled,question,scope,existingRequestId,onUnavailable}:AskAnswerProps){
 const [finding,setFinding]=useState<{kind:'answer_claim'|'keyword_passage';index:number}|null>(null);
 const [result,setResult]=useState<AskAnswerReadResult|null>(null);
 const [opened,setOpened]=useState<z.infer<typeof askAnswerSourceResultSchema>|null>(null);
 const sourceEpoch=useRef(0);
 const [notice,setNotice]=useState<string|null>(null);
 const [requestId,setRequestId]=useState<string|null>(existingRequestId??null);
 const [requested,setRequested]=useState(existingRequestId!==undefined);
 const [reading,setReading]=useState(false);
 const epoch=useRef(0);
 const invalidate=useCallback(()=>++epoch.current,[]);
 const answerRead=ports.answerRead;
 const timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
 const readAnswer=useCallback(async function readCurrent(id:string,captured:number,remaining=10){
  if(!answerRead||captured!==epoch.current)return;
  setReading(true);setFinding(null);setOpened(null);sourceEpoch.current++;
  try{
   const fresh=await answerRead({requestId:id});
   if(captured!==epoch.current)return;
   if(fresh.requestId!==id)throw new Error('request_changed');
   setResult(fresh);
   if(fresh.state==='stale'||fresh.state==='deleted'||fresh.reason==='source_unavailable')onUnavailable?.();
   if(fresh.state==='pending'){
    setNotice(remaining>1?'Explanation pending.':'Still pending. Automatic checks stopped; check this request again when ready.');
    if(remaining>1)timer.current=setTimeout(()=>{void readCurrent(id,captured,remaining-1);},2000);
   }else setNotice(null);
  }catch{
   if(captured===epoch.current){setResult(null);onUnavailable?.();setNotice('Explanation unavailable. Search selected copies for original evidence.');}
  }finally{if(captured===epoch.current)setReading(false);}
 },[answerRead,onUnavailable]);
 useEffect(()=>{
  if(existingRequestId!==undefined&&enabled)void readAnswer(existingRequestId,invalidate());
  return ()=>{invalidate();clearTimeout(timer.current);};
 },[existingRequestId,enabled,readAnswer,invalidate]);
 async function explain(){
  if(!enabled||existingRequestId!==undefined||question===undefined||scope===undefined||!ports.answerRequest||!ports.answerRead)return;
  const captured=++epoch.current;
  setRequested(true);setResult(null);setNotice('Requesting explanation…');
  try{
   const ack=await ports.answerRequest({question:question.trim(),scope});
   if(captured!==epoch.current)return;
   setRequestId(ack.requestId);
   await readAnswer(ack.requestId,captured);
  }catch{if(captured===epoch.current)setNotice('Explanation unavailable. Search selected copies for original evidence.');}
 }
 async function openCitation(windowId:string){
  if(!enabled||!ports.answerSourceRead||result?.state!=='complete')return;
  const captured=epoch.current,selected=++sourceEpoch.current;
  setOpened(null);setNotice('Reading current source…');
  try{
   const next=await ports.answerSourceRead({requestId:result.requestId,expectedVersion:result.version,windowId});
   if(captured!==epoch.current||selected!==sourceEpoch.current)return;
   if(next.requestId!==result.requestId||next.version!==result.version||next.windowId!==windowId)throw new Error('source_changed');
   setOpened(next);setNotice(null);
  }catch{
   if(captured===epoch.current&&selected===sourceEpoch.current){setOpened(null);setResult(null);onUnavailable?.();setNotice('Citation unavailable. Check this explanation again before using it.');}
  }
 }
 return <div>
  {existingRequestId===undefined&&<button disabled={requested||!enabled||!question?.trim()||!ports.answerRequest||!ports.answerRead} onClick={()=>{void explain();}}>Explain selected copies</button>}
  {requestId!==null&&<button disabled={!enabled||reading} onClick={()=>{clearTimeout(timer.current);setResult(null);void readAnswer(requestId,++epoch.current);}}>Check explanation</button>}
  {existingRequestId!==undefined&&result?.question!=null&&<p>{result.question}</p>}
  {notice!==null&&<p role='status'>{notice}</p>}
  {result!==null&&resultNotice(result)!==null&&<p role='status'>{resultNotice(result)}</p>}
  {result?.state==='complete'&&result.answer!==null&&<div>
   <h2>Explanation from selected copies</h2>
   <p>Input coverage: {result.answer.coverage.input}. Semantic coverage: {result.answer.coverage.semantic}. Acquisition coverage: {result.answer.coverage.acquisition}.</p>
   <p>Bounded to at most 10 selected copies; this does not establish complete business history.</p>
   {result.answer.abstained&&<p>No supported explanation could be established.</p>}
   {result.answer.conflicts.length>0&&<p>{result.answer.conflicts.length} unresolved conflict. Evidence may disagree.</p>}
   {result.answer.missingEvidence.map(reason=><p key={reason}>{missingEvidence[reason]}</p>)}
  </div>}
  {result?.state==='complete'&&result.answer?.claims.map((claim,index)=><div key={index}>
   <p>{claim.kind==='inferred'?'Inference from source evidence':'Supported by source evidence'}</p>
   <p>{claim.text}</p>
   <button disabled={!enabled||!ports.actionCreate} onClick={()=>setFinding({kind:'answer_claim',index})}>Act on claim {index+1}</button>
   {claim.citationWindowIds.map((id,citation)=><button key={id} disabled={!enabled||!ports.answerSourceRead} onClick={()=>{void openCitation(id);}}>Open citation {citation+1} for claim {index+1}</button>)}
  </div>)}
  {result?.fallback!==null&&result?.fallback!==undefined&&<section aria-label='Keyword evidence'>
   <h2>Keyword evidence from the same selected copies</h2>
   <p>Keyword matching only. Acquisition and semantic coverage are unverified.</p>
   {result.fallback.passages.length===0&&<p>No matching keyword passages in the inspected copies.</p>}
   {(result.fallback.truncated||!result.fallback.coverage.scanComplete)&&<p>Keyword coverage is partial; some evidence was not inspected.</p>}
   {result.fallback.passages.map((passage,index)=><div key={index}>
    <pre className='whitespace-pre-wrap break-words'>{passage.text}</pre>
    <button disabled={!enabled||index>19||!ports.actionCreate} onClick={()=>setFinding({kind:'keyword_passage',index})}>Act on keyword passage {index+1}</button>
    {passage.sources.map(item=><p key={`${item.kind}:${item.sourceId}:${item.locator}`}>Source {item.sourceId} · Version {item.revision} · {item.occurredAt??'Date unknown'} · {item.completeness}</p>)}
   </div>)}
  </section>}
  {finding!==null&&result!==null&&<AskFollowOn key={`${result.requestId}:${result.version}:${finding.kind}:${finding.index}`} ports={ports} enabled={enabled} requestId={result.requestId} expectedVersion={result.version} finding={finding} onUnavailable={()=>{setResult(null);setOpened(null);setFinding(null);onUnavailable?.();setNotice('Action could not be confirmed. Check current evidence before trying again.');}}/>}
  {opened!==null&&<section aria-label='Current citation'>
   <h3>Current original evidence</h3>
   <p>{{selected_note:'Selected note',call_transcript:'Call transcript',meeting_transcript:'Meeting transcript',mail:'Email'}[opened.source.source.kind]} · Version {opened.source.source.revision} · {opened.source.source.occurredAt??'Date unknown'} · {opened.source.passage?.speaker??'Speaker unknown'}</p>
   <pre className='whitespace-pre-wrap break-words'>{opened.source.passage?.text??'No quote is available.'}</pre>
   <p>{opened.source.source.completeness} · {opened.source.passage?.locator??opened.source.source.locator??'Locator unavailable'}</p>
  </section>}
 </div>;
}
