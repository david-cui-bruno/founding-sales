import {useEffect,useState,type JSX} from 'react';
import {socialStandingOptionsSchema,socialStandingPlanReadSchema,type SocialStandingPlanView} from '@fss/contracts';
import type {z} from 'zod';
import type {StandingBrowserRequest} from './BrowserSocialStandingPlan.tsx';

type Destination='Drafts'|'Publishing'|'Updates'|'Voice'|'Account';
type Overview={options:z.infer<typeof socialStandingOptionsSchema>;plan:SocialStandingPlanView|null};

/** Local metadata only: opening Social never opens LinkedIn or starts generation. */
export function BrowserSocialOverview({request,onNavigate}:{request:StandingBrowserRequest;onNavigate:(destination:Destination)=>void}):JSX.Element{
 const [snapshot,setSnapshot]=useState<Overview|null>(null),[error,setError]=useState(false),[refresh,setRefresh]=useState(0);
 useEffect(()=>{
  let active=true;
  void Promise.all([request('/social/standing-plan/options',{}),request('/social/standing-plan/read',{})]).then(([options,plan])=>{
   const next={options:socialStandingOptionsSchema.parse(options),plan:socialStandingPlanReadSchema.parse(plan).plan};
   if(active){setSnapshot(next);setError(false);}
  }).catch(()=>{if(active){setSnapshot(null);setError(true);}});
  return()=>{active=false;};
 },[request,refresh]);
 if(!snapshot)return <div className="social-surface social-loading" role="status">
  <h2>{error?'Your setup couldn’t be loaded':'Getting your Social workspace ready…'}</h2>
  <p>{error?'No connection or publishing action was attempted. You can still work on private drafts.':'Reading your saved setup. Nothing is being posted.'}</p>
  {error?<div className="social-actions"><button className="workspace-primary" onClick={()=>{setError(false);setRefresh(value=>value+1);}}>Try loading again</button><button onClick={()=>onNavigate('Drafts')}>Open drafts</button></div>:null}
 </div>;
 const {options,plan}=snapshot;
 const next:Destination=!options.inputIds.length?'Updates':!options.calibrationId?'Voice':!options.binding?'Account':'Publishing';
 const activePlan=plan?.state==='active';
 const title=next==='Updates'?'Start with something you know.':next==='Voice'?'Let’s make it sound like you.':next==='Account'?'Connect your LinkedIn.':activePlan?'Your publishing plan is in place.':'Choose your publishing rhythm.';
 const description=next==='Updates'?'Add an observation, a lesson, or a story. You choose which material can be used in your posts.':next==='Voice'?'Review three private drafts for voice and accuracy before setting up publishing.':next==='Account'?'Your voice is calibrated. Connect your personal LinkedIn profile through Buffer Free, then review your plan before anything is published.':activePlan?'Review your schedule and actual outcomes in Publishing. A saved plan is not confirmation that a post has been published.':'Your Buffer profile is connected. Review the account, source material and three weekly time slots, then explicitly activate your plan.';
 const action=next==='Updates'?'Add your first update':next==='Voice'?'Review your voice':next==='Account'?'Connect with Buffer':activePlan?'View publishing':'Review publishing plan';
 const steps=[
  {label:'Your material',detail:options.inputIds.length?`${options.inputIds.length} public-safe update${options.inputIds.length===1?'':'s'}`:'Add your first update',ready:options.inputIds.length>0,destination:'Updates' as const},
  {label:'Your voice',detail:options.calibrationId?'Calibration accepted':'Review three private drafts',ready:Boolean(options.calibrationId),destination:'Voice' as const},
  {label:'LinkedIn account',detail:options.binding?'Buffer connected · check in Publishing':'Connection needed',ready:Boolean(options.binding),destination:'Account' as const},
  {label:'Publishing plan',detail:activePlan?'Active plan · outcomes in Publishing':plan?'Paused':'Not activated',ready:activePlan,destination:'Publishing' as const},
 ];
 return <div className="social-overview">
  <section className="social-next-step" aria-labelledby="social-next-heading">
   <p className="social-eyebrow">{activePlan&&next==='Publishing'?'Your workspace':'Next up'}</p>
   <h2 id="social-next-heading">{title}</h2><p className="social-lead">{description}</p>
   <button className="workspace-primary" onClick={()=>onNavigate(next)}>{action}<span aria-hidden="true">→</span></button>
   <p className="social-caption">Drafts stay private. Connecting never turns on publishing.</p>
  </section>
  <section className="social-surface social-setup" aria-label="Your setup">
   <div className="social-section-heading"><h2>Your setup</h2><span className="social-caption">{steps.filter(step=>step.ready).length} of 4 ready</span></div>
   <ol>{steps.map((step,index)=><li key={step.label}>
    <span className={`social-step-number${step.ready?' is-ready':''}`} aria-label={step.ready?'Ready':`Step ${index+1}`}>{step.ready?'✓':index+1}</span>
    <button className="social-step-link" onClick={()=>onNavigate(step.destination)}><strong>{step.label}</strong><span>{step.detail}</span></button>
    <span aria-hidden="true" className="social-step-arrow">↗</span>
   </li>)}</ol>
  </section>
  <section className="social-surface social-idea-card" aria-label="Keep your ideas moving">
   <div><p className="social-eyebrow">Your library</p><h2>Good posts start with real material.</h2><p>Save a thought while it’s fresh. Add photos only when you want them used.</p></div>
   <button onClick={()=>onNavigate('Updates')}>Add an update<span aria-hidden="true">＋</span></button>
  </section>
 </div>;
}
