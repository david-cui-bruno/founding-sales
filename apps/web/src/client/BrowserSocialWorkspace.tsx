import {useEffect,useLayoutEffect,useMemo,useRef,useState,type JSX} from 'react';
import {socialStandingOptionsSchema,socialPublisherConnectionInputSchema,socialPublisherConnectionResultSchema} from '@fss/contracts';
import {BrowserSocialConversations} from './BrowserSocialConversations.tsx';
import {BrowserSocialReview} from './BrowserSocialReview.tsx';
import {BrowserSocialFounderInputs} from './BrowserSocialFounderInputs.tsx';
import {BrowserSocialCalibration} from './BrowserSocialCalibration.tsx';
import {BrowserSocialApprovedMedia} from './BrowserSocialApprovedMedia.tsx';
import {BrowserSocialPublisherConnection} from './BrowserSocialPublisherConnection.tsx';
import {BrowserSocialPublishingReadiness} from './BrowserSocialPublishingReadiness.tsx';
import {BrowserSocialStandingPlan} from './BrowserSocialStandingPlan.tsx';
import {BrowserSocialStandingActivity} from './BrowserSocialStandingActivity.tsx';
import {socialMediaBrowser} from './SocialMediaBrowser.ts';
import {standingBrowserRequest} from './SocialStandingBrowser.ts';
import type {WorkspaceScreenProps} from './workspaceNavigation.ts';
import type {BrowserClient} from './BrowserClient.ts';
import './workspaceSocial.css';
const VIEWS=['Updates','Media','Calibration','Plan','Activity','Posts','Conversations'] as const;
type View=typeof VIEWS[number];
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
 const [view,setView]=useState<View>('Posts'),[planRevision,setPlanRevision]=useState(0);
 const [accountId,setAccountId]=useState<string|null|undefined>();
 const managed=client.current?.status==='signed_in'&&client.current.role==='admin';
 const scope=useRef<BrowserClient|null>(client);scope.current=client;
 useLayoutEffect(()=>{scope.current=client;return()=>{scope.current=null;};},[client]);
 const current=useMemo(()=>{const epoch=client.epoch;return()=>{if(scope.current!==client||!client.isCurrent(epoch))throw Error('Social workspace changed');};},[client]);
 const media=useMemo(()=>socialMediaBrowser(client,current),[client,current]);
 const request=useMemo(()=>standingBrowserRequest(client,current),[client,current]);
 useEffect(()=>{
  if(view!=='Plan'||!managed)return;
  let active=true;setAccountId(undefined);
  void client.request('/social/standing-plan/options',socialStandingOptionsSchema,{}).then(options=>{if(active)setAccountId(options.intendedAccountId);}).catch(()=>{if(active)setAccountId(undefined);});
  return()=>{active=false;};
 },[client,view,planRevision,managed]);
 return <section className="social-workspace" aria-label="Social workspace">
  <header className="social-workspace-heading"><div><h1>Social</h1><p>Your public-safe updates, private voice and managed personal LinkedIn posts.</p></div><span className="social-private-badge">Owner-private workspace</span></header>
  <nav className="social-view-switch" aria-label="Social views">{VIEWS.map(name=><button key={name} type="button" aria-pressed={view===name} onClick={()=>setView(name)}>{name}</button>)}</nav>
  <p className="social-route-note">Private drafts are not publication approval. Only an explicitly activated current plan can authorize three managed posts per owner-local week.</p>
  {view==='Updates'&&managed?<BrowserSocialFounderInputs client={client}/>:null}
  {view==='Media'&&managed?<BrowserSocialApprovedMedia port={media}/>:null}
  {view==='Calibration'&&managed?<BrowserSocialCalibration client={client} onCompleted={()=>setPlanRevision(value=>value+1)}/>:null}
  {view==='Plan'&&managed?<>
   {accountId===undefined?<p role="status">Read current plan to refresh the intended account before connecting.</p>:<BrowserSocialPublisherConnection client={client} {...(accountId===null?{}:{reconnectAccountId:accountId})} transport={(input,current)=>client.request('/social/publisher/connection',socialPublisherConnectionResultSchema,socialPublisherConnectionInputSchema.parse(input),current)} onConnected={()=>setPlanRevision(value=>value+1)} onDisconnected={()=>setPlanRevision(value=>value+1)}/>}
   <BrowserSocialStandingPlan key={planRevision} request={request} onBinding={binding=>setAccountId(previous=>binding?.accountId??previous??null)}/>
   <BrowserSocialPublishingReadiness client={client}/>
  </>:null}
  {view==='Activity'&&managed?<BrowserSocialStandingActivity request={request}/>:null}
  {view==='Posts'?<BrowserSocialReview client={client}/>:null}
  {view==='Conversations'?<BrowserSocialConversations client={client}/>:null}
  {!managed&&view!=='Posts'&&view!=='Conversations'?<p role="status">Managed personal publishing requires the current workspace owner.</p>:null}
  <details className="social-details"><summary>Scope & publication evidence</summary>
   <p>Updates marked Use for my posts and exact approved sanitized images are eligible sources, not proof that a post was published. Calibration accepts three private drafts without publishing them. Plan activation separately grants scheduled generation and personal LinkedIn publication.</p>
   <p>Activity distinguishes queued, scheduled, published, cancelled and uncertain outcomes. A remote schedule is not a published post; pausing does not prove accepted remote work disappeared. Unknown submissions are inspected, never replaced blindly. Manual private composition, guide and retained history remain in Posts.</p>
   <p>No photo-library access, vision processing, automated comments, messages, invitations or public-conversation acquisition is included. Conversations remain retained public snapshots, not an authenticated feed or inbox.</p>
  </details>
 </section>;
}
