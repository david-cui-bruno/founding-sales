import {EvidenceReview,type EvidenceReviewPorts,type EvidenceWorkIdentity,type EvidenceSource} from "./EvidenceReview.tsx";
import { useCallback, useLayoutEffect, useRef, useState, type JSX } from 'react';
import type { CanonicalSourceReference, CrmProcessingHealth } from '@fss/contracts';
import { Button } from '../ui/button.tsx';
export interface ProcessingPorts {
 evidence?:EvidenceReviewPorts;
 health(input:{sourceId:string;kind:CanonicalSourceReference['kind']}):Promise<CrmProcessingHealth>;
 request(source:Pick<CanonicalSourceReference,'workspaceId'|'sourceId'|'kind'|'revision'|'contentHash'|'locator'>):Promise<void>;
}
/** Health survives source deletion; it contains no copied excerpts or model input. */
export function ProcessingHealth({source,ports,enabled=true,recordId=source.sourceId,privacyKey=source.workspaceId,sourceVersion,workContexts,comparisonSources}:{comparisonSources?:readonly EvidenceSource[];workContexts?:readonly EvidenceWorkIdentity[];enabled?:boolean;recordId?:string;privacyKey?:string|object|null;sourceVersion?:string|undefined;source:Pick<CanonicalSourceReference,'workspaceId'|'sourceId'|'kind'|'revision'|'contentHash'|'locator'|'availability'>;ports:ProcessingPorts}):JSX.Element{
 const [health,setHealth]=useState<CrmProcessingHealth|null>(null);
 const [error,setError]=useState('');
 const [busy,setBusy]=useState(false);
 const [refresh,setRefresh]=useState(0);
 const epoch=useRef(0);
 const invalidate=useCallback(()=>{epoch.current++;},[]);
 useLayoutEffect(()=>{
  let current=true;epoch.current++;setHealth(null);setError('');setBusy(false);
  if(!enabled)return()=>{current=false;invalidate();};
  void ports.health({sourceId:source.sourceId,kind:source.kind}).then(result=>{if(current)setHealth(result);}).catch(()=>{if(current)setError('Processing status could not be loaded.');});
  return()=>{current=false;invalidate();};
 },[ports,source.sourceId,source.kind,source.revision,source.contentHash,source.workspaceId,source.availability,refresh,invalidate,enabled,recordId,privacyKey,sourceVersion]);
 const unknown=health?.unknownAcceptance===true||(health?.generations.some(g=>g.financial?.dispatchState==='calling'||g.financial?.dispatchState==='unknown_acceptance')??false);
 return <section aria-label="Evidence processing">
  <p>Evidence processing</p>
  {error&&<p role="alert">{error}</p>}
  {health===null&&!error&&<p>Loading processing status…</p>}
  {unknown&&<p>Provider acceptance is unknown. Another attempt is blocked.</p>}
  {health?.generations.map(g=><div key={g.generationId}>
   <p>Processing status: {g.state.replaceAll('_',' ')}</p>
   {g.reason&&<p>{g.reason.replaceAll('_',' ')}</p>}
   {g.financial&&<p>{g.financial.settlementState==='estimated'?'Estimated cost':'Recorded cost'}: {g.financial.settledCents}¢</p>}
  </div>)}
  {health?.truncated&&<p>Showing the most recent 50 attempts.</p>}
  {health!==null&&source.availability==='available'&&!unknown&&<Button disabled={busy||!enabled} onClick={()=>{
   const mine=epoch.current;setBusy(true);setError('');
   void ports.request({workspaceId:source.workspaceId,sourceId:source.sourceId,kind:source.kind,revision:source.revision,contentHash:source.contentHash,locator:null}).then(()=>{if(epoch.current===mine)setRefresh(value=>value+1);}).catch(()=>{if(epoch.current===mine)setError('Extraction could not be requested.');}).finally(()=>{if(epoch.current===mine)setBusy(false);});
  }}>Request extraction</Button>}
 {ports.evidence?<EvidenceReview sources={[...new Map([source,...(comparisonSources??[])].map(choice=>[`${choice.workspaceId}:${choice.kind}:${choice.sourceId}`,choice])).values()]} ports={ports.evidence} enabled={enabled} recordId={recordId} privacyKey={privacyKey} sourceVersion={sourceVersion} {...(workContexts===undefined?{}:{workContexts})}/>:null}
 </section>;
}
