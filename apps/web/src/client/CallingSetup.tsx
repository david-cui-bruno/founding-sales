import {CallingMicrophoneCheck} from './CallingMicrophoneCheck.tsx';
import {useEffect,useMemo,useRef,useState,type JSX} from 'react';
import {callingSetupSchema,type CallingSetup as Setup} from '@fss/contracts';
import type {BrowserClient} from './BrowserClient.ts';
import {CallingSetupCustody,type CallingSetupChangeReceipt} from './CallingSetupCustody.ts';
const money=(cents:number)=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2}).format(cents/100);
const refusal={admin_only:'Only a workspace admin can change browser calling.',setting_version_conflict:'The calling setting changed. Review the current status before choosing again.',integration_unconfigured:'The calling provider is not configured. An operator must configure it before enabling.',telephony_budget_disabled:'The existing calling budget is disabled. Enabling needs an already approved, nonzero budget.'};
/** Workspace setup remains available before any Firm is selected. */
export function CallingSetup({client}: {client:BrowserClient}):JSX.Element{
 const custody=useMemo(()=>new CallingSetupCustody(client),[client]);
 const [snapshot,setSnapshot]=useState<Setup|null>(null),[busy,setBusy]=useState(false),[unknown,setUnknown]=useState(false),[storageError,setStorageError]=useState(false),[notice,setNotice]=useState(''),[dailyBudget,setDailyBudget]=useState('');
 const mounted=useRef(false),running=useRef(false),generation=useRef(0);
 const admin=client.current?.status==='signed_in'&&client.current.role==='admin';
 useEffect(()=>{
  mounted.current=true;let epoch=client.epoch;
  const clear=()=>{generation.current++;running.current=false;setBusy(false);setSnapshot(null);setUnknown(false);setStorageError(false);setNotice('');setDailyBudget('');};
  const session=client.subscribe(()=>{if(epoch!==client.epoch||client.current?.status!=='signed_in'){epoch=client.epoch;clear();}});
  try{setUnknown(custody.read()!==null);}catch{setStorageError(true);}
  const mine=++generation.current;running.current=true;setBusy(true);
  const current=()=>mounted.current&&generation.current===mine&&client.isCurrent(epoch)&&client.current?.status==='signed_in';
  void client.request('/calling/setup',callingSetupSchema,undefined,()=>{if(!current())throw Error('Setup view changed');}).then(result=>{if(current()){setSnapshot(result);setDailyBudget(String(result.telephonyBudget.dailyCeilingCents/100));}},()=>{if(current())setNotice('Calling setup unavailable. Refresh status to try the read again.');}).finally(()=>{if(current()){running.current=false;setBusy(false);}});
  return()=>{mounted.current=false;session();};
 },[client,custody]);
 const run=async(work:(current:()=>boolean)=>Promise<void>):Promise<void>=>{
  if(running.current||client.current?.status!=='signed_in')return;
  running.current=true;setBusy(true);const mine=++generation.current,epoch=client.epoch;
  const current=()=>mounted.current&&generation.current===mine&&client.isCurrent(epoch)&&client.current?.status==='signed_in';
  try{await work(current);}catch{if(current())setNotice('Calling setup unavailable. Refresh status; check the original receipt if a change is UNKNOWN.');}
  finally{if(current()){running.current=false;setBusy(false);try{setUnknown(custody.read()!==null);}catch{setStorageError(true);}}}
 };
 const read=async(current:()=>boolean)=>{
  const result=await client.request('/calling/setup',callingSetupSchema,undefined,()=>{if(!current())throw Error('Setup view changed');});
  if(current()){setSnapshot(result);setDailyBudget(String(result.telephonyBudget.dailyCeilingCents/100));}
 };
 const refresh=()=>run(async current=>{setSnapshot(null);setNotice('Reading current calling setup…');await read(current);if(current())setNotice('Current setup read. Each call still needs its own checks.');});
 const finish=async(receipt:CallingSetupChangeReceipt,current:()=>boolean)=>{
  if(!current())return;
  if(receipt.state==='unknown'){setUnknown(true);setNotice('This change is UNKNOWN. Check its original receipt before another change.');return;}
  // Historical acceptance never sets the switch display. Only a fresh snapshot does.
  await read(current);
  if(current())setNotice(receipt.state==='refused'?refusal[receipt.reason]:'Change recorded. Current setup is shown. No call was started.');
 };
 const change=(provider:'tel'|'twilio')=>run(async current=>{
  if(!snapshot||!admin||storageError||custody.read())return;
  const expectedVersion=snapshot.callingProvider.version;setSnapshot(null);setNotice('Saving browser calling choice…');
  await finish(await custody.change({expectedVersion,provider},current),current);
 });
 const saveBudget=()=>run(async current=>{
  if(!snapshot||!admin||storageError||custody.read())return;
  if(!/^(?:0|[1-9][0-9]{0,2})(?:\.[0-9]{1,2})?$/u.test(dailyBudget)||Number(dailyBudget)>100){setNotice('Enter a daily amount from $0 to $100.');return;}
  const expectedVersion=snapshot.telephonyBudget.version,dailyCeilingCents=Math.round(Number(dailyBudget)*100);
  setSnapshot(null);setNotice('Saving daily calling budget…');
  await finish(await custody.changeBudget({expectedVersion,dailyCeilingCents},current),current);
 });
 const recover=()=>run(async current=>{setSnapshot(null);setNotice('Checking the original setup receipt…');await finish(await custody.recover(current),current);});
 const enabled=snapshot?.callingProvider.provider==='twilio';
 return <section id="calling-setup" className="calling-setup" aria-label="Browser calling setup" aria-busy={busy}>
  <div className="calling-setup-heading"><h2>Browser calling setup</h2><button disabled={busy} onClick={()=>{void refresh();}}>Refresh calling status</button></div>
  <p>Allow explicit browser calls using the existing provider and approved calling budget. Changing this setting does not place a call, use your microphone or start a recording.</p>
  {snapshot?<><dl><div><dt>Browser calling</dt><dd>{enabled?'On · Twilio':'Off'}</dd></div><div><dt>Provider configuration</dt><dd>{snapshot.configured?'Configured':'Not configured'}</dd></div><div><dt>Daily cost cap</dt><dd>{money(snapshot.telephonyBudget.dailyCeilingCents)}</dd></div><div><dt>Used or reserved today</dt><dd>{money(snapshot.spentTodayCents)}</dd></div></dl><p>Calls reserve up to {snapshot.telephonyBudget.maxMinutesPerCall} minutes at {new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:6}).format(snapshot.telephonyBudget.unitPriceMicros/1000000)} per minute. The daily ceiling covers spent and reserved calling costs. Calls record both sides from answer; ask for consent verbally.</p></>:null}
  {notice?<p role="status">{notice}</p>:null}
  {storageError?<p role="alert">Setup storage unavailable. Changes are blocked to preserve the original command.</p>:null}
  {unknown?<div className="calling-setup-unknown"><p>A browser calling change is pending or UNKNOWN. No replacement change is allowed.</p><button disabled={busy||storageError||!admin} onClick={()=>{void recover();}}>Check original setup receipt</button></div>:null}
  {admin?<div className="calling-inline"><button disabled={busy||unknown||storageError||!snapshot||enabled||!snapshot.configured||snapshot.telephonyBudget.dailyCeilingCents<=0||snapshot.telephonyBudget.unitPriceMicros<=0} onClick={()=>{void change('twilio');}}>Enable browser calling</button><button disabled={busy||unknown||storageError||!snapshot||!enabled} onClick={()=>{void change('tel');}}>Turn off browser calling</button></div>:<p>A workspace admin can enable or turn off browser calling.</p>}
  {admin?<div className="calling-inline"><label>Daily calling budget ($)<input aria-label="Daily calling budget in dollars" inputMode="decimal" value={dailyBudget} disabled={busy||unknown||storageError||!snapshot} onChange={e=>setDailyBudget(e.target.value)}/></label><button disabled={busy||unknown||storageError||!snapshot} onClick={()=>{void saveBudget();}}>Save daily calling budget</button></div>:null}
  {!snapshot&&!busy?<p>Refresh calling status to see the current provider and cost cap.</p>:null}
  <CallingMicrophoneCheck client={client}/>
 </section>;
}
