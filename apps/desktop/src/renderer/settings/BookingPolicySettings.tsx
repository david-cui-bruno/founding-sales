import {useCallback,useEffect,useRef,useState,type JSX} from 'react';
import type {BookingPolicyChange,BookingPolicySettingsView} from '@fss/contracts';
import {Section} from '../ui/layout.tsx';
import {Button} from '../ui/button.tsx';
import {Input} from '../ui/input.tsx';
export interface BookingPolicySettingsPorts {
  read():Promise<BookingPolicySettingsView|null>;
  change(input:BookingPolicyChange):Promise<{revision:number|null;reason:string|null}>;
}
const commandResultUnknown=(reason:string|null)=>reason==='offline'||reason==='unreadable_answer'||reason==='session_changed';
export function BookingPolicySettings({ports,mayMutate}:{ports:BookingPolicySettingsPorts|null;mayMutate:boolean}):JSX.Element {
  const [view,setView]=useState<BookingPolicySettingsView|null|undefined>(),[selected,setSelected]=useState(''),[approved,setApproved]=useState(false),[busy,setBusy]=useState(false),[notice,setNotice]=useState<string|null>(null),sequence=useRef(0);
  const [dailyDraft,setDailyDraft]=useState<string|null>(null),[monthlyDraft,setMonthlyDraft]=useState<string|null>(null);
  const load=useCallback(async()=>{
    const n=++sequence.current;setBusy(true);setApproved(false);setDailyDraft(null);setMonthlyDraft(null);
    try{const next=await ports?.read()??null;if(n!==sequence.current)return;setView(next);setSelected(next?.policy.setting.bindings!==null&&next?.policy.setting.bindings!==undefined?'saved':next?.configuration.choices[0]?.id??'');}
    catch{if(n===sequence.current)setView(null);}
    finally{if(n===sequence.current)setBusy(false);}
  },[ports]);
  const invalidatePendingRead=useCallback(()=>{sequence.current++;},[]);
  useEffect(()=>{void load();return invalidatePendingRead;},[load,invalidatePendingRead]);
  const policy=view?.policy,bindings=selected==='saved'?policy?.setting.bindings:view?.configuration.choices.find(choice=>choice.id===selected)?.bindings;
  const cents=(value:string)=>/^\d+(\.\d{0,2})?$/u.test(value)?Math.round(Number(value)*100):NaN;
  const daily=dailyDraft===null?bindings?.budget.dailyCeilingCents??0:cents(dailyDraft),monthly=monthlyDraft===null?bindings?.budget.monthlyCeilingCents??0:cents(monthlyDraft);
  const budgetValid=bindings!==undefined&&bindings!==null&&Number.isSafeInteger(daily)&&Number.isSafeInteger(monthly)&&daily>=0&&monthly>=0&&daily<=bindings.budget.dailyCeilingCents&&monthly<=bindings.budget.monthlyCeilingCents;
  const save=async()=>{
    if(!mayMutate||!approved||busy||policy===undefined||!bindings||!budgetValid||ports===null)return;
    setBusy(true);const n=sequence.current;
    try{const answer=await ports.change({commandId:crypto.randomUUID(),action:'save',expectedRevision:policy.revision,bindings:{...bindings,budget:{...bindings.budget,dailyCeilingCents:daily,monthlyCeilingCents:monthly}}});if(n!==sequence.current)return;if(commandResultUnknown(answer.reason))throw new Error('Policy command result unavailable');setNotice(answer.reason===null?'Policy saved. Automation remains off.':`Policy not saved: ${answer.reason}`);await load();}
    catch{if(n===sequence.current){setNotice('The save result is unknown. Refresh before trying again.');setView(null);setBusy(false);}}
  };
  const stop=async(action:'disable'|'revoke')=>{
    if(!mayMutate||busy||policy===undefined||policy.revision===0||ports===null)return;
    setBusy(true);const n=sequence.current;
    try{const answer=await ports.change({commandId:crypto.randomUUID(),action,expectedRevision:policy.revision});if(n!==sequence.current)return;if(commandResultUnknown(answer.reason))throw new Error('Policy command result unavailable');setNotice(answer.reason===null?'Future booking work is stopped. Accepted appointments are unchanged.':`Policy not stopped: ${answer.reason}`);await load();}
    catch{if(n===sequence.current){setNotice('The stop result is unknown. Refresh before trying again.');setView(null);setBusy(false);}}
  };
  return <Section title="Standing booking policy" data-testid="booking-policy-settings" actions={<Button variant="quiet" size="sm" disabled={busy||ports===null} onClick={()=>{void load();}}>Refresh booking policy</Button>}>
    <p>20-minute introduction with a separate 10-minute after-call buffer. Weekdays 9 AM to 6 PM America/New_York, two-hour notice, 14-day horizon. No call-count cap.</p>
    <p>Explicit supported slot agreement and verified attendees only. Unconditional scheduling can proceed separately from David’s sales handoff. Conditional agreement pauses for David.</p>
    <p>One provider confirmation and one email reminder an hour before. No SMS or duplicate reminders. Two nudges on days 3 and 7 include manual nudges and stop on any reply. One next-business-day rebooking message only after David confirms a no-show.</p>
    <p>Selected authorized free/busy only, never private event descriptions or prospect calendars. Substantive replies and autonomous calling remain off.</p>
    {view===undefined?<p>Reading booking policy…</p>:view===null?<p role="status">Booking policy is unavailable. Refresh the current signed-in owner settings.</p>:<>
      <p>{`Saved policy: ${view.policy.setting.status} · revision ${view.policy.revision}`}</p><p>Enabled: no</p>
      <p>{view.policy.readiness.evidenceKind==='controlled'?'Controlled technical checks only. Actual provider acceptance is not established.':view.policy.readiness.ready?'Current applicable technical checks passed. Saving still does not enable automation.':'Operational readiness is not established.'}</p>
      {!view.policy.readiness.ready?<ul>{view.policy.readiness.reasons.map(reason=><li key={reason}>{reason.replaceAll('_',' ')}</li>)}</ul>:null}
      <p>Observed booking spend: ${(view.policy.budget.observedDailyCents/100).toFixed(2)} today, ${(view.policy.budget.observedMonthlyCents/100).toFixed(2)} this New York calendar month. Allowance: {view.policy.budget.allowance}.</p>
      {view.configuration.choices.length===0?<p>Existing account, event, calendar and model setup is unavailable. No provider settings are changed here.</p>:null}
      <label>Configured booking scope<select aria-label="Configured booking scope" value={selected} disabled={busy||!mayMutate} onChange={event=>{setSelected(event.target.value);setApproved(false);setDailyDraft(null);setMonthlyDraft(null);}}>
        {view.policy.setting.bindings!==null?<option value="saved">Current saved scope</option>:null}
        {view.configuration.choices.map(choice=><option key={choice.id} value={choice.id}>{choice.label}</option>)}
      </select></label>
      {bindings?<div><p>{bindings.account.email} · Cal.com event {bindings.event.eventTypeId} · {bindings.event.bookingUrl}</p><p>Calendars: {bindings.calendars.map(calendar=>`${calendar.credentialId}:${calendar.externalId}`).join(', ')} (free/busy only)</p><p>Exact model: {bindings.model.providerKey} · {bindings.model.route} · {bindings.model.modelVersion} · {bindings.model.accountBinding}</p><p>Purpose: booking interpretation. Source scope {bindings.source.scopeRevision}, data handling {bindings.source.dataHandlingVersion}, sender {bindings.sender.channel}:{bindings.sender.accountId} at {bindings.sender.authorityRevision}.</p><p>Consent {bindings.model.consentRevision}, quality review {bindings.model.qualityReviewRevision??'not yet reviewed'}.</p><p>Booking-only ceiling: ${(bindings.budget.dailyCeilingCents/100).toFixed(2)}/New York day and ${(bindings.budget.monthlyCeilingCents/100).toFixed(2)}/New York calendar month, within stricter shared limits.</p></div>:null}
      {bindings?<div><label>Daily booking ceiling (USD)<Input type="number" min="0" max={bindings.budget.dailyCeilingCents/100} step="0.01" value={dailyDraft??(bindings.budget.dailyCeilingCents/100).toFixed(2)} disabled={busy||!mayMutate} onChange={event=>{setDailyDraft(event.target.value);setApproved(false);}}/></label><label>Monthly booking ceiling (USD)<Input type="number" min="0" max={bindings.budget.monthlyCeilingCents/100} step="0.01" value={monthlyDraft??(bindings.budget.monthlyCeilingCents/100).toFixed(2)} disabled={busy||!mayMutate} onChange={event=>{setMonthlyDraft(event.target.value);setApproved(false);}}/></label><p>Ceilings can be lowered here. No automatic budget increase or cost shifting to posting or diagnostics.</p></div>:null}
      <label><input type="checkbox" checked={approved} disabled={busy||!mayMutate||!bindings} onChange={event=>setApproved(event.target.checked)}/>I approve this exact booking-only scope and spending allowance. Saving does not enable automation.</label>
      <Button disabled={!mayMutate||busy||!approved||!bindings||!budgetValid} onClick={()=>{void save();}}>Save booking policy</Button>
      <Button variant="quiet" disabled={!mayMutate||busy||view.policy.revision===0} onClick={()=>{void stop('disable');}}>Disable booking policy</Button>
      <Button variant="quiet" disabled={!mayMutate||busy||view.policy.revision===0} onClick={()=>{void stop('revoke');}}>Revoke booking policy</Button>
      <p>Revocation prevents future work. It does not undo accepted bookings or cancel unrelated meetings.</p>
    </>}
    {notice===null?null:<p role="status">{notice}</p>}
  </Section>;
}
