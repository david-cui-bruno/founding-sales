/** Read-only evidence from the observed native post-detail layout. A scheduled
 * share ID differs from its activity permalink ID. Never derive one from the other.
 * The caller must verify current account, exact approved text and requested receipt.
 * Media and layouts without an explicit share mapping remain unsupported.
 */
export function linkedInPublishedDetailScript():string {
 return `(()=>{
 const roots=document.querySelectorAll('main[aria-label="Feed detail update"]');if(roots.length!==1)return {ok:false};
 const root=roots[0],posts=root.querySelectorAll('[role="article"][data-urn]');if(posts.length!==1)return {ok:false};
 const post=posts[0],activityId=post.getAttribute('data-urn');if(!/^urn:li:activity:[0-9]+$/.test(activityId??''))return {ok:false};
 const links=root.querySelectorAll('a[aria-label="Go to boost post page"]');if(links.length!==1)return {ok:false};
 const parse=value=>{try{const u=new URL(value);return u.protocol==='https:'&&u.hostname==='www.linkedin.com'&&!u.username&&!u.password&&!u.port?u:null;}catch{return null;}};
 const mapping=parse(links[0].getAttribute('href'));if(!mapping||mapping.pathname!=='/ad-beta/boost/campaigns/new/details'||mapping.searchParams.getAll('content').length!==1)return {ok:false};
 const shareId=mapping.searchParams.get('content');if(!/^urn:li:share:[0-9]+$/.test(shareId??''))return {ok:false};
 const authors=post.querySelectorAll('.update-components-actor__meta-link');if(authors.length!==1)return {ok:false};
 const author=parse(authors[0].getAttribute('href'));if(!author||!/^\\/in\\/[A-Za-z0-9_-]+\\/?$/.test(author.pathname))return {ok:false};
 const bodies=post.querySelectorAll('.update-components-update-v2__commentary');if(bodies.length!==1||post.querySelector('.feed-shared-update-v2__content,video')||bodies[0].querySelector('button'))return {ok:false};
 // Clone locally to preserve explicit line breaks without including comment text.
 const body=bodies[0].cloneNode(true);for(const br of body.querySelectorAll('br'))br.replaceWith('\\n');
 const text=body.textContent.trim();if(!text||text.length>10000)return {ok:false};
 return {ok:true,view:{shareId,activityId,authorExternalId:'https://www.linkedin.com'+author.pathname.replace(/\\/$/,'')+'/',text,permalink:'https://www.linkedin.com/feed/update/'+activityId+'/',publishedAt:null}};
 })()`;
}
