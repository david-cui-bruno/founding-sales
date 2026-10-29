import {BrowserSocialConversations} from './BrowserSocialConversations.tsx';
import {BrowserSocialPublishingReadiness} from './BrowserSocialPublishingReadiness.tsx';
import {useState,type JSX} from 'react';
import {BrowserSocialReview} from './BrowserSocialReview.tsx';
import type {WorkspaceScreenProps} from './workspaceNavigation.ts';
import './workspaceSocial.css';

/** Presentation only. Private writes stay with the existing composer and custody owner. */
export function BrowserSocialWorkspace({client}:WorkspaceScreenProps):JSX.Element{
 const [view,setView]=useState<'posts'|'conversations'>('posts');
 return <section className="social-workspace" aria-label="Social workspace">
  <header className="social-workspace-heading"><div><h1>Social</h1><p>Make space for your next post or public conversation.</p></div><span className="social-private-badge">Private workspace</span></header>
  <nav className="social-view-switch" aria-label="Social views">
   <button type="button" aria-pressed={view==='posts'} onClick={()=>setView('posts')}>Posts</button>
   <button type="button" aria-pressed={view==='conversations'} onClick={()=>setView('conversations')}>Conversations</button>
  </nav>
  <p className="social-route-note">Private drafts · Retained public snapshots · Publishing not activated</p>
  {view==='posts'?<BrowserSocialReview client={client}/>:<BrowserSocialConversations client={client}/>}
  <BrowserSocialPublishingReadiness client={client}/>
  <details className="social-details"><summary>Platform limits & publishing</summary>
   <p>Automatic publishing with channel-specific cadence is a product target, not an active capability or permission. This screen does not connect accounts, join groups, send messages, publish, or schedule posts.</p>
   <p>LinkedIn personal-profile and Facebook personal-profile/group publishing routes require separately supported platform operations and current authority. A private draft is destination-independent and does not establish either.</p>
  </details>
 </section>;
}
