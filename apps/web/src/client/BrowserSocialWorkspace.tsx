import {useLayoutEffect,useMemo,useRef,useState,type JSX} from 'react';
import {BrowserSocialConversations} from './BrowserSocialConversations.tsx';
import {BrowserSocialReview} from './BrowserSocialReview.tsx';
import {BrowserSocialFounderInputs} from './BrowserSocialFounderInputs.tsx';
import {BrowserSocialVoice} from './BrowserSocialVoice.tsx';
import {BrowserSocialApprovedMedia} from './BrowserSocialApprovedMedia.tsx';
import {BrowserSocialStandingPlan} from './BrowserSocialStandingPlan.tsx';
import {BrowserSocialStandingActivity} from './BrowserSocialStandingActivity.tsx';
import {BrowserSocialOverview} from './BrowserSocialOverview.tsx';
import {BrowserSocialAccount} from './BrowserSocialAccount.tsx';
import {socialMediaBrowser} from './SocialMediaBrowser.ts';
import {standingBrowserRequest} from './SocialStandingBrowser.ts';
import type {WorkspaceScreenProps} from './workspaceNavigation.ts';
import type {BrowserClient} from './BrowserClient.ts';
import './workspaceSocial.css';

type View='Overview'|'Drafts'|'Publishing'|'Activity'|'Account'|'Updates'|'Photos'|'Voice'|'Conversations';
const publishingViews=['Publishing','Activity','Account'] as const;
const libraryViews=['Updates','Photos','Voice','Conversations'] as const;

/** Switching identity unmounts every private subview; no private projection cache. */
export function BrowserSocialWorkspace({client}:WorkspaceScreenProps):JSX.Element|null{
 const binding=useRef({client,key:0});
 if(binding.current.client!==client)binding.current={client,key:binding.current.key+1};
 const [,invalidate]=useState(0);
 useLayoutEffect(()=>client.subscribe(()=>invalidate(value=>value+1)),[client]);
 if(client.current?.status!=='signed_in')return null;
 return <SocialSession key={`${binding.current.key}:${client.epoch}`} client={client}/>;
}
function SocialSession({client}:WorkspaceScreenProps):JSX.Element{
 const managed=client.current?.status==='signed_in'&&client.current.role==='admin';
 const [view,setView]=useState<View>(managed?'Overview':'Drafts');
 const scope=useRef<BrowserClient|null>(client);scope.current=client;
 useLayoutEffect(()=>{scope.current=client;return()=>{scope.current=null;};},[client]);
 const current=useMemo(()=>{const epoch=client.epoch;return()=>{if(scope.current!==client||!client.isCurrent(epoch))throw Error('Social workspace changed');};},[client]);
 const media=useMemo(()=>socialMediaBrowser(client,current),[client,current]);
 const request=useMemo(()=>standingBrowserRequest(client,current),[client,current]);
 const publishing=publishingViews.some(name=>name===view),library=libraryViews.some(name=>name===view);
 const primary=publishing?'Publishing':library?'Library':view;
 return <section className="social-workspace" aria-label="Social workspace">
  <header className="social-workspace-heading"><div><p className="social-eyebrow">Your personal brand</p><h1>Social</h1><p>Your ideas, in your voice. A little more consistently.</p></div><span className="social-private-badge">Private workspace</span></header>
  <nav className="social-view-switch" aria-label="Social views">
   {(managed?['Overview','Drafts','Publishing','Library'] as const:['Drafts','Library'] as const).map(name=><button key={name} type="button" aria-pressed={primary===name} onClick={()=>setView(name==='Library'?(managed?'Updates':'Conversations'):name)}>{name}</button>)}
  </nav>
  {publishing&&managed?<nav className="social-subnav" aria-label="Publishing views">{publishingViews.map(name=><button key={name} aria-pressed={view===name} onClick={()=>setView(name)}>{name==='Publishing'?'Plan':name==='Account'?'LinkedIn account':name}</button>)}</nav>:null}
  {library?<><div className="social-page-intro"><h2>Your library</h2><p>{managed?'Real experiences, approved photos and the voice behind your posts.':'Your private voice preferences and retained public conversations.'}</p></div><nav className="social-subnav" aria-label="Library views">{(managed?libraryViews:['Voice','Conversations'] as const).map(name=><button key={name} aria-pressed={view===name} onClick={()=>setView(name)}>{name==='Updates'?'Updates & ideas':name}</button>)}</nav></>:null}
  <div className="social-view-content" key={view}>
   {view==='Overview'&&managed?<BrowserSocialOverview request={request} onNavigate={setView}/>:null}
   {view==='Drafts'?<BrowserSocialReview client={client}/>:null}
   {view==='Publishing'&&managed?<BrowserSocialStandingPlan request={request} onConnect={()=>setView('Account')} onMaterial={()=>setView('Updates')} onVoice={()=>setView('Voice')}/>:null}
   {view==='Activity'&&managed?<BrowserSocialStandingActivity request={request}/>:null}
   {view==='Account'&&managed?<BrowserSocialAccount client={client} onReviewPlan={()=>setView('Publishing')}/>:null}
   {view==='Updates'&&managed?<div className="social-surface social-library-panel"><BrowserSocialFounderInputs client={client}/></div>:null}
   {view==='Photos'&&managed?<div className="social-surface social-library-panel"><BrowserSocialApprovedMedia port={media}/></div>:null}
   {view==='Voice'?<div className="social-surface social-library-panel"><BrowserSocialVoice client={client}/></div>:null}
   {view==='Conversations'?<div className="social-surface social-library-panel"><BrowserSocialConversations client={client}/></div>:null}
  </div>
  <details className="social-details social-scope"><summary>How privacy and publishing work</summary>
   <p>Drafts and voice calibration stay private. Public-safe updates and exact approved photos are eligible material, not permission to publish. Connecting LinkedIn does not activate your plan.</p>
   <p>Only an explicitly activated current plan authorizes scheduled generation and up to three personal posts per local week. Activity distinguishes queued, scheduled, published, cancelled and uncertain outcomes. Pausing cannot guarantee that remote schedules were cancelled; uncertain submissions are inspected, never blindly repeated.</p>
   <p>No automated comments, messages, invitations, photo-library access or new public-conversation acquisition is included. Conversations contains retained public snapshots, not a feed or inbox.</p>
  </details>
 </section>;
}
