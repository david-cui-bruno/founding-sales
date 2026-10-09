import {useEffect,useState,type JSX} from 'react';
import type {CrmProcessingRecordHealth,CrmProcessingHealth} from '@fss/contracts';
export interface ProcessingRecordPorts {read(input:{kind:'call_session'|'meeting';recordId:string}):Promise<CrmProcessingRecordHealth>}
export const processingRecordPorts:ProcessingRecordPorts={read:async input=>await globalThis.callieApi?.read('crm.processingRecordHealth',input)??{sources:[],truncated:false}};
function Status({health}:{health:CrmProcessingHealth}){return <>
 {health.unknownAcceptance&&<p>Provider acceptance is unknown. Another attempt is blocked.</p>}
 {health.generations.map(g=><div key={g.generationId}><p>Processing status: {g.state.replaceAll('_',' ')}</p>{g.reason&&<p>{g.reason.replaceAll('_',' ')}</p>}{g.financial&&<p>{g.financial.settlementState==='estimated'?'Estimated cost':'Recorded cost'}: {g.financial.settledCents}¢</p>}</div>)}
 {health.truncated&&<p>Showing the most recent 50 attempts.</p>}
 </>;}
/** Original identities/status only: deletion never requires opening or reconstructing a transcript. */
export function ProcessingRecordHealth({kind,recordId,ports=processingRecordPorts}:{kind:'call_session'|'meeting';recordId:string;ports?:ProcessingRecordPorts}):JSX.Element|null{
 const [view,setView]=useState<{key:string;answer:CrmProcessingRecordHealth|null;error:boolean}|null>(null);const key=`${kind}:${recordId}`;
 useEffect(()=>{let current=true;setView(null);void ports.read({kind,recordId}).then(answer=>{if(current)setView({key,answer,error:false});}).catch(()=>{if(current)setView({key,answer:null,error:true});});return()=>{current=false;};},[kind,recordId,ports,key]);
 if(view?.key!==key)return null;if(view.error)return <p>Processing status could not be loaded.</p>;if(view.answer===null||view.answer.sources.length===0&&!view.answer.truncated)return null;
 return <section aria-label="Record evidence processing">{view.answer.sources.map(health=><Status key={health.sourceId} health={health}/>)}{view.answer.truncated&&<p>Some processing sources are outside this page.</p>}</section>;
}
