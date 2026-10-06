import {linkedinComposerFixture} from './linkedinComposerFixture.ts';
/** Entirely local synthetic platform; localStorage simulates persistence across
 * document/window reloads. Every HTTPS request is intercepted by the host probe.
 */
export function linkedinFlowFixture(changed:boolean):string{
 return linkedinComposerFixture
 .replace('<dialog open data-testid="dialog"></dialog>', '<aside aria-label="Sidebar"><a href="https://www.linkedin.com/in/fixture/"><img alt="Fixture Founder"></a><a href="https://www.linkedin.com/in/fixture/"><div aria-label="Fixture Founder, Founder"><p>Fixture Founder</p></div></a></aside><dialog open data-testid="dialog"></dialog>')
 .replace('<button disabled>Schedule</button>', '<button id="send">Schedule</button>')
 .replace("root.querySelector('[aria-label=\"Media\"]').onclick=openMedia;", `root.querySelector('#send').onclick=()=>{localStorage.setItem('submits',String(Number(localStorage.getItem('submits')||0)+1));localStorage.setItem('receipt',JSON.stringify({text:${changed?"'Changed by platform'":'text'},schedule}));list();};root.querySelector('[aria-label="Media"]').onclick=openMedia;`)
 .replace('<button id="confirm">Confirm</button>', '<a id="scheduled">Scheduled (0)</a><button id="confirm">Confirm</button>')
 .replace("root.querySelector('#confirm').onclick=", "root.querySelector('#scheduled').onclick=list;root.querySelector('#confirm').onclick=")
 .replace('composer();</script>', `
function list(){
 const saved=JSON.parse(localStorage.getItem('receipt')||'null');
 const f=Object.fromEntries(new Intl.DateTimeFormat('en-US',{year:'numeric',month:'short',weekday:'short',day:'numeric',hour:'numeric',minute:'2-digit',hour12:true}).formatToParts(new Date('2026-11-02T15:00:00Z')).map(p=>[p.type,p.value]));
 const label='Posting '+f.weekday+', '+f.month+' '+f.day+', '+f.year+' at '+f.hour+':'+f.minute+' '+f.dayPeriod;
 root.innerHTML='<div data-sdui-screen="com.linkedin.sdui.flagshipnav.sharing.ShareSchedulePostList"><a>Scheduled ('+(saved?'1':'0')+')</a>'+(saved?'<div id="ScheduledPostRowSlot_urn:li:share:123_gen3"><a id="edit" href="https://www.linkedin.com/sharing/compose"><p id="label"></p><div role="listitem"><p id="savedText"></p></div></a><div role="button" id="more"><svg aria-label="More options"></svg></div></div>':'<p>When you schedule a post, it automatically posts at the date and time you chose</p>')+'</div>';
 if(!saved)return;
 root.querySelector('#label').textContent=label;root.querySelector('#savedText').textContent=saved.text;
 root.querySelector('#edit').onclick=e=>{e.preventDefault();text=saved.text;schedule=saved.schedule;composer();const back=document.createElement('button');back.textContent='Back';back.onclick=list;root.append(back);};
 root.querySelector('#more').onclick=()=>{const menu=document.createElement('div');menu.setAttribute('popover','manual');menu.innerHTML='<div role="menuitem">Delete post</div>';document.body.append(menu);menu.showPopover();menu.firstChild.onclick=()=>{menu.remove();root.innerHTML='<h2>Delete this post?</h2><button id="delete">Delete Post</button>';root.querySelector('#delete').onclick=()=>{localStorage.removeItem('receipt');localStorage.setItem('deletes',String(Number(localStorage.getItem('deletes')||0)+1));list();};};};
}
composer();</script>`);
}
