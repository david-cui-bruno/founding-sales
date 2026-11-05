import {useCallback,useEffect,useRef,useState,type JSX} from 'react';
import {socialStandingPlanReadSchema,socialStandingOptionsSchema,socialFounderInputViewSchema,type SocialStandingPlanView,type SocialFounderInputView} from '@fss/contracts';
import {z} from 'zod';
export type StandingBrowserRequest=(path:string,body:unknown)=>Promise<unknown>;
type Options=z.infer<typeof socialStandingOptionsSchema>;
const days=['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
const inputRead=z.strictObject({input:socialFounderInputViewSchema});

export function BrowserSocialStandingPlan({request,onConnect,onMaterial,onVoice}:{request:StandingBrowserRequest;onConnect?:()=>void;onMaterial?:()=>void;onVoice?:()=>void}):JSX.Element{
 const [plan,setPlan]=useState<SocialStandingPlanView|null>(null),[options,setOptions]=useState<Options|null>(null),[inputs,setInputs]=useState<SocialFounderInputView[]>([]);
 const [busy,setBusy]=useState(true),[message,setMessage]=useState(''),[unknown,setUnknown]=useState(false),[editing,setEditing]=useState(false);
 const [zone,setZone]=useState('America/New_York'),[cadence,setCadence]=useState([{weekday:1,time:'10:00'},{weekday:3,time:'10:00'},{weekday:5,time:'10:00'}]);
 const [generation,setGeneration]=useState(false),[publication,setPublication]=useState(false),[cancel,setCancel]=useState(true),[media,setMedia]=useState(false),[selected,setSelected]=useState<string[]>([]);
 const alive=useRef(false),locked=useRef(false),version=useRef(0);
 const load=useCallback(async()=>{
  if(locked.current)return false;
  locked.current=true;setBusy(true);const operation=++version.current;
  const current=()=>alive.current&&version.current===operation;
  try{
   const [saved,available]=await Promise.all([request('/social/standing-plan/read',{}),request('/social/standing-plan/options',{})]);
   const next=socialStandingPlanReadSchema.parse(saved).plan,choices=socialStandingOptionsSchema.parse(available);
   const material=await Promise.all(choices.inputIds.map(async inputId=>{
    try{return inputRead.parse(await request('/social/inputs/read',{inputId})).input;}catch{return null;}
   }));
   if(!current())return false;
   setPlan(next);setOptions(choices);setInputs(material.filter((input):input is SocialFounderInputView=>input!==null));
   setSelected(next?.configuration.inputIds??choices.inputIds);setEditing(next?.state!=='active');
   setGeneration(false);setPublication(false);
   if(next){setZone(next.configuration.timezone);setCadence(next.configuration.cadence);setCancel(next.configuration.cancelRemoteOnPause);setMedia(next.configuration.mediaScope==='approved_pool');}
   return true;
  }catch{if(current()){setOptions(null);setInputs([]);setMessage('The current plan couldn’t be read. Refresh below; a prior accepted change is not undone by a failed read.');}return false;}
  finally{if(current()){locked.current=false;setBusy(false);}}
 },[request]);
 useEffect(()=>{alive.current=true;void load();return()=>{alive.current=false;locked.current=false;};},[load]);
 useEffect(()=>{
  const deadlines=inputs.map(input=>Date.parse(input.expiresAt));
  if(!deadlines.length)return;
  const timer=setTimeout(()=>setInputs(rows=>rows.filter(input=>Date.parse(input.expiresAt)>Date.now())),Math.max(0,Math.min(2147483647,Math.min(...deadlines)-Date.now())));
  return()=>clearTimeout(timer);
 },[inputs]);
 const change=async(body:unknown)=>{
  if(locked.current||unknown)return;
  locked.current=true;setBusy(true);setMessage('');const operation=++version.current;
  const current=()=>alive.current&&version.current===operation;
  let accepted=false;
  try{
   const result=await request('/social/standing-plan/command',body);
   if(!current())return;
   if(result&&typeof result==='object'&&'status' in result&&result.status==='refused')setMessage(`Plan change refused${'reason' in result?`: ${String(result.reason).replaceAll('_',' ')}`:''}. Refresh the plan before trying a revised change.`);
   else{accepted=true;setMessage('Plan change accepted. Loading its current state…');}
  }catch{if(current()){setUnknown(true);setMessage('Outcome not confirmed. Check the existing change below before making another. Nothing will be sent again automatically.');}}
  finally{if(current()){locked.current=false;setBusy(false);}}
  if(accepted&&current()&&await load()&&alive.current)setMessage('Plan change accepted. The current saved plan is shown below; Activity records actual outcomes.');
 };
 const reconcile=async()=>{
  if(locked.current)return;locked.current=true;setBusy(true);const operation=++version.current;
  let resolved=false;
  try{await request('/social/standing-plan/reconcile',{});if(alive.current&&version.current===operation){setUnknown(false);setMessage('Existing change checked. Refreshing the saved plan.');resolved=true;}}
  catch{if(alive.current&&version.current===operation){setUnknown(true);setMessage('Outcome still unknown. Do not repeat the change.');}}
  finally{if(alive.current&&version.current===operation){locked.current=false;setBusy(false);}}
  if(resolved)await load();
 };
 const available=inputs.filter(input=>input.state==='available'&&input.publicSafe&&Date.parse(input.expiresAt)>Date.now());
 const validSelection=selected.length>0&&selected.every(id=>options?.inputIds.includes(id)&&available.some(input=>input.inputId===id));
 const ready=Boolean(options?.binding&&options.calibrationId&&options.inputIds.length);
 return <section aria-label="Standing publishing plan" className="social-plan">
  <div className="social-section-heading social-page-intro"><div><h2>Your publishing plan</h2><p>Three posts per week. Your material, your account, your say.</p></div><span className={`social-status${options&&plan?.state==='active'?' is-ready':''}`}>{!options?'Not loaded':plan?plan.state==='active'?'Plan active':'Paused':'Not activated'}</span></div>
  {message?<p role={unknown?'alert':'status'} className={`social-feedback${unknown?' is-warning':''}`}>{message}</p>:null}
  {busy?<p role="status" className="social-caption">Loading the current plan…</p>:null}
  {options?<>
   <div className="social-plan-prerequisites social-surface">
    <div role="group" aria-label="Publishing profile"><span className="social-caption">LinkedIn account</span><strong>{options.binding?options.accountDisplayName??'Connected personal profile':'Connection needed'}</strong>{options.binding?<p>LinkedIn profile ID: <span>{options.binding.externalId}</span></p>:null}{onConnect?<button onClick={onConnect}>{options.binding?'Review connected account':'Connect with Buffer'}</button>:<p>{options.binding?'This exact Buffer-connected profile is used for publication.':'Connect and select your personal profile first.'}</p>}</div>
    <div><span className="social-caption">Your voice</span><strong>{options.calibrationId?'Calibration accepted':'Review needed'}</strong>{!options.calibrationId&&onVoice?<button onClick={onVoice}>Review your voice</button>:<p>{options.guideRef?'Current private voice guide':'No optional voice guide selected'}</p>}</div>
    <div><span className="social-caption">Source material</span><strong>{options.inputIds.length} public-safe update{options.inputIds.length===1?'':'s'}</strong>{onMaterial?<button className="workspace-quiet" onClick={onMaterial}>Review updates</button>:null}</div>
   </div>
   {!ready?<div className="social-empty"><h3>Finish setup before activating publishing.</h3><p>Private drafts remain available. Connecting an account or accepting your voice never turns on publishing.</p></div>:null}
   {plan&&!editing?<div className="social-surface social-plan-summary"><div className="social-section-heading"><h3>Your weekly rhythm</h3><span className="social-caption">{plan.configuration.timezone}</span></div><div className="social-cadence">{plan.configuration.cadence.map((slot,index)=><div key={index}><span>{days[slot.weekday-1]}</span><strong>{slot.time}</strong></div>)}</div><p>{plan.configuration.inputIds.length} selected updates · {plan.configuration.mediaScope==='approved_pool'?'Approved photos allowed':'Text only'}</p><button disabled={busy||unknown} onClick={()=>{setGeneration(false);setPublication(false);setEditing(true);}}>Edit plan</button></div>:null}
   {ready&&editing?<form className="social-plan-editor" onSubmit={event=>{event.preventDefault();if(!options.binding||!options.calibrationId||!validSelection||!generation||!publication)return;void change({operation:'save',plan:{expectedRevision:plan?.revision??0,binding:options.binding,calibrationId:options.calibrationId,guideRef:options.guideRef,inputIds:selected,mediaScope:media?'approved_pool':'none',timezone:zone,cadence,scheduledGenerationGrant:'bedrock_haiku_founder_scheduled_v1',publicationGrant:'linkedin_personal_standing_v1',cancelRemoteOnPause:cancel}});}}>
    <fieldset disabled={busy||unknown} className="social-surface"><legend>1. Choose your rhythm</legend><p>Three slots in your local week. Missing material is skipped, never invented.</p><label className="social-timezone">Timezone<input value={zone} required maxLength={64} onChange={event=>setZone(event.target.value)}/></label><div className="social-cadence">{cadence.map((slot,index)=><div key={index}><label>Post {index+1} day<select value={slot.weekday} onChange={event=>setCadence(rows=>rows.map((row,i)=>i===index?{...row,weekday:Number(event.target.value)}:row))}>{days.map((day,i)=><option key={day} value={i+1}>{day}</option>)}</select></label><label>Post {index+1} time<input type="time" required value={slot.time} onChange={event=>setCadence(rows=>rows.map((row,i)=>i===index?{...row,time:event.target.value}:row))}/></label></div>)}</div></fieldset>
    <fieldset disabled={busy||unknown} className="social-surface"><legend>2. Choose what can be used</legend><p>Only these current public-safe updates may support generated posts.</p><div className="social-material-choices">{options.inputIds.map((id,index)=>{const input=available.find(item=>item.inputId===id);return <label key={id} className="social-check"><input type="checkbox" checked={selected.includes(id)} onChange={event=>setSelected(rows=>event.target.checked?[...rows,id]:rows.filter(value=>value!==id))}/><span><strong>{input?.state==='available'?input.bullets.split('\n')[0]?.slice(0,180)||`Update ${index+1}`:`Update ${index+1} is unavailable`}</strong><small>{input?`Update ${id.slice(0,8)} · Revision ${input.revision}`:'Refresh or deselect this update before activation.'}</small></span></label>;})}</div><label className="social-check"><input type="checkbox" checked={media} onChange={event=>setMedia(event.target.checked)}/><span><strong>Allow approved photos</strong><small>Only exact sanitized images you have approved, with matching context and alt text. Otherwise, text only.</small></span></label></fieldset>
    <p id="social-publication-image-disclosure" className="social-feedback">If you allow approved photos, the exact sanitized public-use derivative becomes publicly retrievable at a stable delivery URL when handed to Buffer, before the scheduled post, and remains available until withdrawal, pause or expiry. This is an intentionally public image, not a secret or protected link. Unlisted does not mean private. Buffer or LinkedIn may retain a fetched copy.</p>
    <fieldset disabled={busy||unknown} className="social-surface social-approval"><legend>3. Review and activate</legend><p>These are separate permissions. Neither is selected for you.</p><label className="social-check"><input type="checkbox" checked={generation} onChange={event=>setGeneration(event.target.checked)}/><span><strong>Allow scheduled AI drafting</strong><small>Bedrock/Haiku may use the selected current updates and current voice guide within existing Social and shared spending limits.</small></span></label><label className="social-check"><input type="checkbox" checked={publication} aria-describedby="social-publication-image-disclosure" onChange={event=>setPublication(event.target.checked)}/><span><strong>Allow automatic LinkedIn publishing</strong><small>Eligible generated posts may publish on the exact linked personal account through Buffer, up to three slots per local week, without per-post approval. No comments, messages or invitations.</small></span></label><label className="social-check"><input type="checkbox" checked={cancel} onChange={event=>setCancel(event.target.checked)}/><span><strong>Also cancel future remote schedules when I pause</strong><small>Cancellation is requested for this plan’s schedules only. Publication can win a cancellation race; pausing never unpublishes history.</small></span></label><div className="social-actions"><button type="submit" className="workspace-primary" disabled={!generation||!publication||!validSelection}>{plan?'Activate revised plan':'Activate publishing'}</button>{plan?<button type="button" onClick={()=>setEditing(false)}>Cancel editing</button>:null}</div></fieldset>
   </form>:null}
  </>:null}
  {plan?.state==='active'?<div className="social-pause-row"><div><strong>Need a break?</strong><p>Pause new work. Existing remote schedules follow your cancellation choice.</p></div><button disabled={busy||unknown} onClick={()=>{void change({operation:'pause',planId:plan.planId,expectedRevision:plan.revision});}}>Pause publishing</button></div>:null}
  <details className="social-details" open={unknown}><summary>Refresh & recovery</summary><p>Reconnects and edits do not reset used or skipped slots. An uncertain change must be checked, not repeated.</p><div className="social-actions"><button disabled={busy} onClick={()=>{setMessage('');void load();}}>Refresh plan</button><button disabled={busy} onClick={()=>{void reconcile();}}>Check existing plan change</button></div></details>
 </section>;
}
