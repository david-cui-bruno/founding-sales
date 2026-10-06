/** @vitest-environment jsdom */
import {afterEach,expect,it} from 'vitest';
import {linkedInCancelScript} from '../src/main/social/adapters/linkedinCancelDom.ts';
const target={receiptId:'urn:li:share:123',text:'Approved',scheduleLabel:'Posting Tue, Oct 13, 2026 at 12:00 PM',token:'12345678-1234-4234-8234-123456789012'};
function run(action:'openMenu'|'deleteMenu'|'confirm'){return new Function('document','window',`return ${linkedInCancelScript({action,...target})}`)(document,window);}
afterEach(()=>{document.body.innerHTML='';delete (window as unknown as Record<string,unknown>)['__callieLinkedInCancellation'];});
function fixture(){document.body.innerHTML=`<dialog open data-testid="dialog"><div data-sdui-screen="com.linkedin.sdui.flagshipnav.sharing.ShareSchedulePostList"><a>Scheduled (1)</a><div id="ScheduledPostRowSlot_urn:li:share:123_gen3"><p>${target.scheduleLabel}</p><div role="listitem"><p>Approved</p></div><div role="button"><svg aria-label="More options"></svg></div></div></div></dialog>`;}
it('requires exact target and a bound menu sequence before one confirmation click',()=>{fixture();let clicked=0;document.querySelector('[role="button"]')!.addEventListener('click',()=>{document.body.innerHTML+='<div popover="manual" style="display:block"><div role="menu"><div role="menuitem">Post now</div><div role="menuitem">Delete post</div></div></div>';});
 expect(run('confirm')).toEqual({ok:false});expect(run('openMenu')).toEqual({ok:true});
 document.querySelectorAll('[role="menuitem"]')[1]!.addEventListener('click',()=>{document.body.innerHTML='<dialog open data-testid="dialog"><h2>Delete this post?</h2><p>Your post will be discarded. This action cannot be undone.</p><button>Delete Post</button></dialog>';document.querySelector('button')!.onclick=()=>clicked++;});
 expect(run('deleteMenu')).toEqual({ok:true});expect(run('confirm')).toEqual({ok:true});expect(run('confirm')).toEqual({ok:false});expect(clicked).toBe(1);
});
it('refuses a changed target and a confirmation from another document flow',()=>{fixture();document.querySelector('[role="listitem"] p')!.textContent='Different';expect(run('openMenu')).toEqual({ok:false});document.body.innerHTML='<dialog open data-testid="dialog"><h2>Delete this post?</h2><button>Delete Post</button></dialog>';expect(run('confirm')).toEqual({ok:false});});
