import {useEffect,useRef,useState,type JSX} from 'react';
import {z} from 'zod';
import {callingIdentityListSchema,callingStatusResponseSchema,dialCheckResponseSchema,pluralFirmPageResponseSchema,type DialRefusalCode} from '@fss/contracts';
import type {BrowserClient} from './BrowserClient.ts';

const statusSchema=z.union([callingStatusResponseSchema,z.strictObject({availability:z.literal('unavailable'),reason:z.enum(['calling_off','firm_unknown','integration_unconfigured'])})]);
type Readiness={binding:string;advice:z.infer<typeof dialCheckResponseSchema>['advice'];status:z.infer<typeof statusSchema>;ownIdentity:boolean};
type Route={id:string;version:number;value:string};
const reasons:Record<DialRefusalCode,string>={
 not_assigned:'This Firm is not assigned to you.',zone_unresolved:'The Firm’s time zone is unresolved.',
 outside_calling_window:'It is outside this Firm’s calling hours.',posture_missing:'The state’s required calling confirmation is missing.',
 posture_overlapping:'The state’s calling confirmations need review.',firm_suppressed:'Calling this Firm is suppressed.',
 handle_suppressed:'This phone route or another route for the same person is suppressed.',manual_suppression_review:'A suppression needs manual review.',
 route_missing:'The selected phone route is unavailable.',route_invalid:'The selected phone route is invalid.',route_retired:'The selected phone route is retired.',
 dnc_coverage_unknown:'Current National DNC clearance is not established.',dnc_registry_match:'The number matches the National DNC registry.',
 restore_in_progress:'A restore is in progress.',uncertain_reply:'An uncertain reply keeps this Firm held.',
 route_candidate:'The phone route needs eligibility review.',posture_overdue:'The state’s calling confirmation needs review.',
 scoped_pause:'Calling is paused for this scope.',reassignment:'The Firm’s assignment is changing.',ambiguous_match:'An ambiguous match needs review.',
 opportunity_manual:'The opportunity is under manual control.',long_hold_review:'A long-standing hold needs review.',provider_refusal:'The provider has refused this route.',
 outreach_touch_unavailable:'The current outreach history is unavailable.',firm_unknown:'This Firm is unavailable.',route_version_stale:'The recorded phone route changed.',
 identity_missing:'A calling identity is missing.',identity_not_owned:'The selected calling number is not owned by this signed-in identity.',
 identity_unverified:'The calling number needs verification.',identity_disabled:'The calling number is disabled.',identity_shared_line_disabled:'The shared calling line is disabled.',
 ticket_unknown:'The call reservation is unknown.',ticket_expired:'The call reservation expired.',ticket_wrong_device:'The call reservation belongs to another device.',already_consumed:'The call reservation has already been used.',
};
const providerMessage=(status:Readiness['status']):string=>'availability'in status
 ?status.reason==='calling_off'?'Browser calling is off. Use Browser calling setup above to review the provider and existing cost cap.'
 :status.reason==='integration_unconfigured'?'The calling provider is not configured. Setup needs operator attention.'
 :'This Firm is unavailable to the calling provider.'
 :status.cadence.parked?'Calling cadence is parked. Review the existing call history before resuming.'
 :status.cadence.refusal==='call_attempt_today'?'An attempt is already recorded for this Firm’s local day.'
 :status.cadence.refusal==='call_attempt_too_soon'?'The next attempt is too soon under the current calling cadence.'
 :status.cadence.refusal?'Calling cadence currently blocks another attempt.'
 :'The provider is configured and cadence has no listed refusal in this snapshot.';

/** Advisory reads only. The execution controller retains every fresh call gate. */
export function CallingReadiness({client,firmId,route,identityId,disabled,isScopeCurrent}:{
 client:BrowserClient;firmId:string;route:Route|null;identityId:string;disabled:boolean;isScopeCurrent:()=>boolean;
}):JSX.Element{
 const binding=JSON.stringify([firmId,route?.id,route?.version,route?.value,identityId]);
 const scope=useRef({binding,isScopeCurrent});scope.current={binding,isScopeCurrent};
 const active=useRef(false),running=useRef(false),generation=useRef(0);
 const [busy,setBusy]=useState(false),[view,setView]=useState<Readiness|null>(null),[notice,setNotice]=useState('');
 useEffect(()=>{
  active.current=true;generation.current++;running.current=false;setBusy(false);setView(null);setNotice('');
  let epoch=client.epoch;
  const unsubscribe=client.subscribe(()=>{if(epoch!==client.epoch||client.current?.status!=='signed_in'){
   epoch=client.epoch;generation.current++;running.current=false;setBusy(false);setView(null);setNotice('');
  }});
  return()=>{active.current=false;unsubscribe();};
 },[client,binding]);
 const check=async():Promise<void>=>{
  if(running.current||disabled||!route||client.current?.status!=='signed_in')return;
  running.current=true;setBusy(true);setView(null);setNotice('Reading current calling checks…');
  const mine=++generation.current,epoch=client.epoch,userId=client.current.userId;
  const current=():boolean=>active.current&&generation.current===mine&&scope.current.binding===binding&&scope.current.isScopeCurrent()&&client.isCurrent(epoch)&&client.current?.status==='signed_in';
  const guard=():void=>{if(!current())throw Error('Calling selection changed');};
  try{
   const [answer,status,identities]=await Promise.all([
    client.request('/dial/check',dialCheckResponseSchema,{firmId,routeId:route.id},guard),
    client.request(`/calls/calling?firmId=${firmId}`,statusSchema,undefined,guard),
    client.request('/calling-identities',callingIdentityListSchema,undefined,guard),
   ]);
   guard();
   if(answer.advice.firmId!==firmId||answer.advice.routeId!==route.id||answer.advice.e164!==route.value)throw Error('Recorded route changed');
   const page=await client.request('/crm/firm-page-v3',pluralFirmPageResponseSchema,{firmId,pageVersion:2},guard);
   guard();
   if(page.read.visibility!=='assigned_or_admin')throw Error('Firm access changed');
   const recorded=page.read.firm.phoneRoutes.find(value=>value.id===route.id);
   if(page.read.firm.id!==firmId||page.read.firm.status!=='active'||!recorded||recorded.version!==route.version||recorded.value!==route.value)throw Error('Recorded route changed');
   const ownIdentity=identities.identities.some(i=>i.id===identityId&&i.ownerUserId===userId&&i.disabledAt===null&&(i.enabled||i.verificationStatus==='unverified'));
   setView({binding,advice:answer.advice,status,ownIdentity});setNotice('Calling checks read. Review the snapshot below.');
  }catch{if(current()){setView(null);setNotice('Calling checks unavailable or the recorded route changed. Refresh the exact Firm and check again.');}}
  finally{if(active.current&&generation.current===mine){running.current=false;setBusy(false);}}
 };
 const result=view?.binding===binding?view:null;
 return <div className="calling-readiness" role="region" aria-label="Call readiness" aria-busy={busy}>
  <button type="button" disabled={disabled||busy||!route} onClick={()=>{void check();}}>Check call readiness</button>
  {!route?<p>Choose the exact recorded phone route to read its current checks.</p>:null}
  <p>No call is placed by this check. Microphone and audio remain untested.</p>
  {notice?<p role="status">{notice}</p>:null}
  {result?<div>
   <p>Policy snapshot: <time dateTime={result.advice.at}>{new Date(result.advice.at).toLocaleString()}</time>{result.advice.firmLocalTime?` · ${result.advice.firmLocalTime} at the Firm`:''}.</p>
   <ul>
    <li>{providerMessage(result.status)}{'availability'in result.status&&result.status.reason==='calling_off'?<> <a href="#calling-setup">Open browser calling setup</a></>:null}</li>
    <li>{result.ownIdentity?'Your selected calling identity is currently available.':'Choose a current calling number owned by your signed-in identity.'}</li>
    {result.advice.reasons.map(reason=><li key={reason}>{reasons[reason]}</li>)}
    {!result.advice.callable&&!result.advice.reasons.length?<li>Current calling policy blocks this Firm.</li>:null}
   </ul>
   <p>This snapshot grants no permission to call or record. Call setup rechecks current eligibility, budgets and authority.</p>
  </div>:null}
 </div>;
}
