import {useCallback,useLayoutEffect,useRef,useState,type JSX} from 'react';
import type {CrmMailImportHealth,crmMailImportAcknowledgmentSchema} from '@fss/contracts';
import type {z} from 'zod';
import {Button} from '../ui/button.tsx';
export interface MailImportPorts {
 health(input:{mailboxId:string}):Promise<CrmMailImportHealth>;
 request(input:{mailboxId:string}):Promise<z.infer<typeof crmMailImportAcknowledgmentSchema>>;
}
export function MailImportStatus({ports,enabled,mailboxId,privacyKey,generation,accountBinding,sourceVersion}:{ports:MailImportPorts;enabled:boolean;mailboxId:string;privacyKey:string;generation:number;accountBinding:string;sourceVersion?:number|undefined}):JSX.Element {
 const [health,setHealth]=useState<CrmMailImportHealth>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [acknowledgement,setAcknowledgement]=useState('');
 const epoch=useRef(0);
 const invalidate=useCallback(()=>++epoch.current,[]);
 const refresh=useCallback(async()=>{
  const ticket=++epoch.current;setHealth(null);setBusy(true);setError('');
  try{const value=await ports.health({mailboxId});if(ticket===epoch.current)setHealth(value);}
  catch{if(ticket===epoch.current){setHealth(null);setError('Import status is unavailable. Check the current mailbox connection and access.');}}
  finally{if(ticket===epoch.current)setBusy(false);}
 },[ports,mailboxId]);
 useLayoutEffect(()=>{invalidate();setHealth(null);setBusy(false);setError('');setAcknowledgement('');if(enabled)void refresh();return()=>{invalidate();};},[ports,enabled,mailboxId,privacyKey,generation,accountBinding,sourceVersion,refresh,invalidate]);
 const request=async()=>{
  if(!enabled||busy)return;
  const ticket=++epoch.current;setHealth(null);setBusy(true);setError('');setAcknowledgement('');
  try{await ports.request({mailboxId});if(ticket!==epoch.current)return;setAcknowledgement('Import request queued. Coverage is reported separately after work runs.');const value=await ports.health({mailboxId});if(ticket===epoch.current)setHealth(value);}
  catch{if(ticket===epoch.current){setHealth(null);setError('Import request or status could not be verified. Refresh current status before trying again.');}}
  finally{if(ticket===epoch.current)setBusy(false);}
 };
 return <section aria-label="Mailbox import status">
  <h3>Mailbox import status</h3>
  {enabled?<><p>This view covers Callie's bounded import and permitted copies.</p><Button disabled={busy} onClick={()=>void refresh()}>Refresh import status</Button><Button disabled={busy} onClick={()=>void request()}>Request 90-day import</Button>{acknowledgement?<p role="status">{acknowledgement}</p>:null}{error?<p role="alert">{error}</p>:null}{busy?<p>Reading import status…</p>:null}{health===null&&!busy&&!error?<p>No import status is available for this mailbox.</p>:null}
  {health?<>
   <p>Import state: {health.state}</p>{health.reason?<p>{health.reason.replaceAll('_',' ')}</p>:null}<p>Mailbox connection: {health.connectionState}</p><p>Import window: {health.fromAt} to {health.toAt}</p><p>{health.windowFrozen?'Import window is frozen.':'Import window is not yet frozen.'}</p><p>Metadata enumeration slices: {health.completedSlices} of {health.totalSlices}</p><p>{health.historyComplete?'History overlap is complete.':'History overlap is incomplete.'}</p>
   <section aria-label="Metadata coverage"><p>Retained unique messages: {health.metadataCoverage.retainedUniqueMessages}</p><p>Available metadata: {health.metadataCoverage.availableMetadataMessages}</p><p>Refused metadata: {health.metadataCoverage.refusedMetadataMessages}</p><p>Confirmed missing originals: {health.metadataCoverage.confirmedMissingMessages}</p><p>Deleted metadata: {health.metadataCoverage.deletedMetadataMessages}</p></section>
   <section aria-label="Copied-body coverage"><p>Copied-body coverage: {health.copyCoverage.coverage}</p><p>Retained copied bodies: {health.copyCoverage.retainedCopiedBodies}</p><p>Unavailable copies: {health.copyCoverage.unavailableCopies}</p><p>Pending captures: {health.copyCoverage.pendingCaptures}</p><p>Metadata requiring review: {health.copyCoverage.reviewRequiredMetadata}</p><p>Uncaptured metadata: {health.copyCoverage.uncapturedMetadata}</p><p>Unresolved metadata: {health.copyCoverage.unresolvedMetadata}</p></section>
   <section aria-label="Import allocation"><p>These units cover only Callie's backfill allocation.</p><p>Callie import allocation reserved: {health.quotaAccounting.reservedUnits} units</p><p>Observed allocation usage: {health.quotaAccounting.observedUnits} units</p><p>Unknown allocation usage held: {health.quotaAccounting.unknownUnits} units</p></section>
   <section aria-label="Older retained-copy traversal"><p>{health.olderCopyReconciliation.traversalExhausted?'Current retained-copy traversal reached its end. Coverage remains partial.':'Current retained-copy traversal is ongoing. Coverage remains partial.'}</p><p>Older copies visited: {health.olderCopyReconciliation.visitedCopies} · refreshed: {health.olderCopyReconciliation.refreshedCopies} · unresolved: {health.olderCopyReconciliation.unresolvedCopies}</p></section>
   <section aria-label="Recovery-gap coverage">{health.gapCoverage?<><p>Recovery-gap state: {health.gapCoverage.state}</p><p>Surviving-message enumeration and fresh history: {health.gapCoverage.completedDays} of {health.gapCoverage.totalDays??'unknown'} days</p><p>Recovery window: {health.gapCoverage.fromAt??'unknown'} to {health.gapCoverage.toAt??'unknown'}</p><p>Original history cursor is unavailable.</p><p>{health.gapCoverage.historyComplete?'Fresh recovery history is complete.':'Fresh recovery history is incomplete.'}</p>{health.gapCoverage.reason?<p>{health.gapCoverage.reason.replaceAll('_',' ')}</p>:null}</>:<p>No recovery-gap status is available.</p>}</section>
  </>:null}</>:<p>Import status unavailable.</p>}
 </section>;
}
