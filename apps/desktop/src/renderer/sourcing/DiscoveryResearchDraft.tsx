import {useEffect,useRef,useState,type JSX} from 'react';
import type {OperationInput,OperationOutput} from '../../shared/operations.ts';
import {operations} from '../app/bridges.ts';
import {useDraft,useDraftStoreAvailable,useSessionEpoch} from '../app/drafts.tsx';
import {navigate} from '../routes.ts';
import {Button} from '../ui/button.tsx';
import {noDefiniteAnswer} from '../today/afterCallModel.ts';

export interface ResearchDraftPorts {
 create(input:OperationInput<'sourcing.discoveryCreateResearchFirm'>):Promise<OperationOutput<'sourcing.discoveryCreateResearchFirm'>>;
 link(input:OperationInput<'sourcing.discoveryLinkResearchFirm'>):Promise<OperationOutput<'sourcing.discoveryLinkResearchFirm'>>;
 read(input:OperationInput<'sourcing.discoveryResearchFirmRead'>):Promise<OperationOutput<'sourcing.discoveryResearchFirmRead'>>;
}
function bridge(){const value=operations();if(!value)throw new Error('unavailable');return value;}
const defaults:ResearchDraftPorts={create:async input=>bridge().command('sourcing.discoveryCreateResearchFirm',input),link:async input=>bridge().command('sourcing.discoveryLinkResearchFirm',input),read:async input=>bridge().read('sourcing.discoveryResearchFirmRead',input)};
type Pending={kind:'create';input:OperationInput<'sourcing.discoveryCreateResearchFirm'>}|{kind:'link';input:OperationInput<'sourcing.discoveryLinkResearchFirm'>};

/** A separately confirmed ordinary Add firm command, followed by an explicit link.
 * No contact, inferred timezone, admission or sending operation exists in this form. */
export function DiscoveryResearchDraft({prepared,name,website,enabled,ports=defaults}:{prepared:NonNullable<OperationOutput<'sourcing.discoveryPrepare'>['result']>;name:string;website:string;enabled:boolean;ports?:ResearchDraftPorts}):JSX.Element {
 const epoch=useSessionEpoch(),currentEpoch=useRef(epoch);currentEpoch.current=epoch;
 const active=useRef(true);useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
 const key=`discovery-research:${prepared.discoveryCandidateId}:${prepared.discoveryRevision}:${prepared.qualificationCandidateId}:`;
 const hasStore=useDraftStoreAvailable();
 const [savedPending,savePending]=useDraft(`${key}pending`),[savedFirm,saveFirm]=useDraft(`${key}firm`);
 const [localPending,setLocalPending]=useState<Pending|null>(null),[localFirm,setLocalFirm]=useState<string|null>(null);
 const firmId=hasStore?(savedFirm||null):localFirm;
 const setFirmId=(value:string)=>{saveFirm(value);setLocalFirm(value);};
 // Only opaque command/record identity lives in the session-private route store.
 // Reconstruct the unchanged command from the immutable preparation on reentry.
 const token=savedPending.split(':');
 const pending:Pending|null=hasStore?(token[0]==='create'&&token[1]?{kind:'create',input:{commandId:token[1],firm:{name,website}}}:token[0]==='link'&&token[1]&&firmId?{kind:'link',input:{commandId:token[1],discoveryCandidateId:prepared.discoveryCandidateId,expectedRevision:prepared.discoveryRevision,qualificationCandidateId:prepared.qualificationCandidateId,firmId}}:null):localPending;
 const setPending=(value:Pending|null)=>{savePending(value?`${value.kind}:${value.input.commandId}`:'');setLocalPending(value);};
 const [busy,setBusy]=useState(false),[linked,setLinked]=useState(false),[message,setMessage]=useState<string|null>(null);
 const current=()=>active.current&&currentEpoch.current===epoch;
 const perform=async(action:Pending)=>{
  if(busy||!enabled)return;setBusy(true);setPending(action);setMessage(null);
  try{
   if(action.kind==='create'){
    const answer=await ports.create(action.input);if(!current())return;
    if(answer.result){setFirmId(answer.result.firmId);setPending(null);setMessage('Ordinary CRM research draft created and assigned to you. Confirm its source link below. Qualification and channel permission remain unknown.');}
    else if(noDefiniteAnswer(answer.reason))setMessage('No definite answer. Retry the same Add firm command, not a new creation.');
    else{setPending(null);setMessage(answer.reason==='duplicate_in_workspace'?'An existing Firm matched. Open Firms and resolve the identity before linking. Nothing was overwritten.':'Add firm refused. No source link was created.');}
   }else{
    const answer=await ports.link(action.input);if(!current())return;
    if(answer.result){setFirmId(answer.result.firmId);setLinked(true);setPending(null);setMessage('Research draft linked. Next action: review Firm research. Not qualified or authorized for outreach.');}
    else if(noDefiniteAnswer(answer.reason))setMessage('No definite answer. Retry the same source link command.');
    else{setPending(null);setLinked(false);setMessage('Source link refused. Check current source, candidate revision, Firm identity and owner. The ordinary Firm was not deleted or overwritten.');}
   }
  }catch{if(current())setMessage('No definite answer. Retry the same action.');}
  finally{if(current())setBusy(false);}
 };
 const read=async()=>{
  setBusy(true);setLinked(false);setMessage(null);
  try{const answer=await ports.read({candidateId:prepared.discoveryCandidateId});if(!current())return;if(answer.view){setFirmId(answer.view.firmId);setLinked(true);setMessage('Current owner/source link available. Review Firm research. Qualification remains unknown.');}else{setMessage('No current accessible research draft link. An already created ordinary Firm is not recreated.');}}
  catch{if(current())setMessage('Current research draft link could not load.');}
  finally{if(current())setBusy(false);}
 };
 const blocked=!enabled||busy||pending!==null;
 return <section aria-label="Discovery CRM research draft" className="space-y-2 rounded border border-border p-3">
  <p>CRM research draft only: {name} · {website}. Existing retained source supports investigation, not verified Firm association, residential fit or contact permission.</p>
  <p>Separately confirming ordinary Add firm may start its existing best-effort research under unchanged workspace settings, holds and budgets. Preparation and source linking do not start research. CRM may collapse name whitespace and canonicalize the URL scheme, without changing the retained source or verifying identity.</p>
  <p>Qualification: not established. Calling: not authorized, phone and office evidence unknown. Email: not authorized, no endpoint or consent established. Missing phone, calling state or DNC checks do not prevent a research draft.</p>
  {!firmId?<Button disabled={blocked} onClick={()=>void perform({kind:'create',input:{commandId:crypto.randomUUID(),firm:{name,website}}})}>Confirm Add firm research draft</Button>:null}
  {firmId&&!linked?<Button disabled={blocked} onClick={()=>void perform({kind:'link',input:{commandId:crypto.randomUUID(),discoveryCandidateId:prepared.discoveryCandidateId,expectedRevision:prepared.discoveryRevision,qualificationCandidateId:prepared.qualificationCandidateId,firmId}})}>Confirm link created research draft</Button>:null}
  <Button variant="quiet" disabled={blocked} onClick={()=>void read()}>Read current research draft link</Button>
  {pending?<Button disabled={!enabled||busy} onClick={()=>void perform(pending)}>Retry same research draft action</Button>:null}
  {message?<p role="status">{message}</p>:null}
  {linked&&firmId?<><Button disabled={!enabled||busy} onClick={()=>navigate({name:'firm',firmId})}>Open Firm research</Button><Button variant="quiet" disabled={!enabled||busy} onClick={()=>navigate({name:'today'})}>Open owner Today</Button></>:null}
 </section>;
}
