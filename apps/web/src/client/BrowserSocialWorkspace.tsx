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
  <p className="social-route-note">LinkedIn personal profile · Facebook personal profile / groups · Publishing not activated</p>
  {view==='posts'?<BrowserSocialReview client={client} autoList/>:<section className="social-conversations-unavailable" aria-label="Public conversations">
   <h2>Public conversations</h2><p>Public posts and group discussions, not direct messages.</p>
   <p>No supported retained public-discussion list or thread reader is available in this browser workspace. No discussions have been fetched or invented.</p>
   <button type="button" disabled aria-describedby="social-discussion-limit">Open public discussion</button>
   <p id="social-discussion-limit">LinkedIn public participation and Facebook profile/group routes are not connected here. Private comment composition is available in Posts, without a platform destination.</p>
  </section>}
  <details className="social-details"><summary>Platform limits & publishing</summary>
   <p>Automatic publishing with channel-specific cadence is a product target, not an active capability or permission. This screen does not connect accounts, join groups, send messages, publish, or schedule posts.</p>
   <p>LinkedIn personal-profile and Facebook personal-profile/group publishing routes require separately supported platform operations and current authority. A private draft is destination-independent and does not establish either.</p>
  </details>
 </section>;
}
