import {useCallback,useEffect,useRef,useState,type JSX} from 'react';
import {manualProspectActivityListSchema,pluralFirmPageResponseSchema,type FirmTimeline,type ManualProspectActivityList,type ManualProspectActivityView} from '@fss/contracts';
import type {BrowserClient} from './BrowserClient.ts';
import type {CallingContextData} from './CallingContext.tsx';
import {callingTarget} from './CallingPending.ts';
import {MANUAL_ACTIVITY_PREFIX,readManualActivity} from './ManualProspectActivityDispatch.ts';

type Read={kind:'latest'}|{kind:'older';cursor:string}|{kind:'report';attemptId:string};
const eventLabels={call:'Call recorded',outcome_corrected:'Outcome corrected',email_sent:'Email sent',email_received:'Email received',stage_change:'Deal stage changed',stop_recorded:'Stop recorded',stop_lifted:'Stop lifted'};
const dateLabel=(value:string)=>new Date(value).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'});
/** Read-only projection of the existing activity owners; no outcome, task or send commands. */
export function ProspectActivity({client,context,isScopeCurrent}:{client:BrowserClient;context:CallingContextData|null;isScopeCurrent:()=>boolean}):JSX.Element {
 const subject=context?.entry.subject??null,target=subject?callingTarget(subject):null;
 const [timeline,setTimeline]=useState<FirmTimeline|null>(null),[reports,setReports]=useState<ManualProspectActivityList|null>(null),[report,setReport]=useState<ManualProspectActivityView|null>(null);
 const [publishedTarget,setPublishedTarget]=useState<string|null>(null),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
 const mounted=useRef(false),sequence=useRef(0),inFlight=useRef(false),epoch=useRef(client.epoch),scope=useRef(isScopeCurrent);scope.current=isScopeCurrent;
 const load=useCallback(async(read:Read):Promise<void>=>{
  if(!subject||inFlight.current||!mounted.current||!scope.current()||!client.isCurrent(epoch.current)||client.current?.status!=='signed_in')return;
  if(subject.kind==='candidate'&&client.current.role!=='admin')return;
  const ticket=++sequence.current;inFlight.current=true;setBusy(true);setNotice('');setReport(null);
  if(read.kind!=='report'){setPublishedTarget(null);setTimeline(null);setReports(null);}
  const current=():boolean=>mounted.current&&ticket===sequence.current&&scope.current()&&client.isCurrent(epoch.current)&&client.current?.status==='signed_in'&&(subject.kind==='firm'||client.current.role==='admin');
  try{
   if(subject.kind==='firm'){
    const answer=await client.request('/crm/firm-page-v3',pluralFirmPageResponseSchema,{firmId:subject.firmId,pageVersion:2,include:['timeline'],...(read.kind==='older'?{timelineBefore:read.cursor}:{})},()=>{if(!current())throw Error('Activity scope changed');});
    if(!current())return;
    if(answer.visibility!=='assigned_or_admin'||answer.read.firm.id!==subject.firmId||!answer.timeline)throw Error('Current activity unavailable');
    setTimeline(answer.timeline);
   }else if(read.kind==='report'){
    const answer=await readManualActivity(client,{candidateId:subject.candidateId,candidateRevision:subject.expectedCandidateRevision,attemptId:read.attemptId},current);
    if(!current())return;setReport(answer);
   }else{
    const answer=await client.request(`${MANUAL_ACTIVITY_PREFIX}/list`,manualProspectActivityListSchema,{candidateId:subject.candidateId,expectedCandidateRevision:subject.expectedCandidateRevision,...(read.kind==='older'?{afterId:read.cursor}:{})},()=>{if(!current())throw Error('Activity scope changed');});
    if(!current())return;
    if(answer.activities.some(row=>row.candidateId!==subject.candidateId||row.candidateRevision!==subject.expectedCandidateRevision))throw Error('Activity subject mismatch');
    setReports(answer);
   }
   setPublishedTarget(callingTarget(subject));
  }catch{if(current()){setTimeline(null);setReports(null);setReport(null);setPublishedTarget(null);setNotice('Current activity could not be read. This is not an empty history.');}}
  finally{if(current()){inFlight.current=false;setBusy(false);}}
 },[client,subject]);
 useEffect(()=>{
  mounted.current=true;void load({kind:'latest'});
  const unsubscribe=client.subscribe(()=>{
   if(!client.isCurrent(epoch.current)||client.current?.status!=='signed_in'){
    sequence.current++;inFlight.current=false;setTimeline(null);setReports(null);setReport(null);setPublishedTarget(null);setBusy(false);setNotice('Current access required.');
   }
  });
  return()=>{mounted.current=false;sequence.current+=1;inFlight.current=false;unsubscribe();};
 },[client,load]);
 if(!subject||!scope.current()||!client.isCurrent(epoch.current)||client.current?.status!=='signed_in')return <p role="status">Current company access is required to read activity.</p>;
 if(subject.kind==='candidate'&&client.current.role!=='admin')return <p role="status">Manual prospect activity requires administrator access.</p>;
 const visible=publishedTarget===target;
 return <section className="prospect-activity" aria-label="Company activity" aria-busy={busy}>
  <header className="calling-inline"><h3>Activity</h3><button disabled={busy} onClick={()=>{void load({kind:'latest'});}}>Refresh activity</button></header>
  {subject.kind==='candidate'?<p className="workspace-muted">Private user reports for this exact observation revision. Not canonical call history or contact permission.</p>:null}
  {busy?<p role="status">Reading current activity…</p>:null}{notice?<p role="status">{notice}</p>:null}
  {visible&&timeline?<><ol>{timeline.events.map(event=><li key={event.key}><strong>{eventLabels[event.kind]}</strong><time dateTime={event.at}>{dateLabel(event.at)}</time>{event.code?<p>{event.code.replaceAll('_',' ')}</p>:null}{event.detail?<p>{event.detail}</p>:null}</li>)}</ol>{!timeline.events.length?<p>No activity returned on this page.</p>:null}{timeline.nextBefore?<button disabled={busy} onClick={()=>{void load({kind:'older',cursor:timeline.nextBefore!});}}>Older activity</button>:null}</>:null}
  {visible&&reports?<><ul>{reports.activities.map(row=><li key={row.attemptId}><button disabled={busy} onClick={()=>{void load({kind:'report',attemptId:row.attemptId});}}>Read report from {dateLabel(row.recordedAt)}</button><span> · {row.availability} · revision {row.activityRevision}</span></li>)}</ul>{!reports.activities.length?<p>No manual reports returned on this page.</p>:null}{reports.nextAfterId?<button disabled={busy} onClick={()=>{void load({kind:'older',cursor:reports.nextAfterId!});}}>Older reports</button>:null}</>:null}
  {visible&&report?<article aria-label="Current manual report"><h4>Reported {dateLabel(report.recordedAt)}</h4>{report.availability==='available'?<><p>{report.result.replaceAll('_',' ')} · User-reported, unverified</p>{report.note?<p>{report.note}</p>:null}{report.callback?<p>Callback intention: {report.callback.note??'No private note'} · {report.callback.timing.kind==='unknown'?'Time unknown':dateLabel(report.callback.timing.dueAt)}. No automatic reminder.</p>:null}</>:<p>Current report content is {report.availability}. Historical acceptance does not restore it.</p>}</article>:null}
 </section>;
}
