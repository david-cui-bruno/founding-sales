/** @vitest-environment jsdom */
import {afterEach,expect,it} from 'vitest';
import {linkedInDetailNavigationScript} from '../src/main/social/adapters/linkedinDetailNavigation.ts';
const receiptId='urn:li:share:123',token='b6bacf0c-28b2-4290-8eaa-c8647020c3c8';
function run(action:'open'|'read'){return new Function('document','window',`return ${linkedInDetailNavigationScript({action,receiptId,token})}`)(document,window);}
function list(){document.body.innerHTML='<dialog open data-testid="dialog"><div data-sdui-screen="com.linkedin.sdui.flagshipnav.sharing.ShareSchedulePostList"><a>Scheduled (1)</a><div id="ScheduledPostRowSlot_urn:li:share:123_gen3"><a href="https://www.linkedin.com/sharing/compose"><p>Posting Tue, Oct 13, 2026 at 12:00 PM</p><div role="listitem"><p>Approved text</p></div></a></div></div></dialog>';}
function detail(){document.body.innerHTML='<dialog open data-testid="dialog"><div role="button">Founder</div><div contenteditable="true" role="textbox" componentkey="ShareBox_textEditor">Approved text</div><div>Posting at Tue, Oct 13, 12:00 PM</div><button>Back</button><button>Schedule</button></dialog>';}
afterEach(()=>{document.body.innerHTML='';delete (window as unknown as Record<string,unknown>)['__callieLinkedInDetail'];});
it('binds saved detail to the exact clicked native row and consumes the read binding',()=>{list();const a=document.querySelector('a[href]')!;a.addEventListener('click',e=>{e.preventDefault();detail();});expect(run('open')).toEqual({ok:true});expect(run('read')).toMatchObject({ok:true,view:{receiptId,text:'Approved text',images:[]}});expect(run('read')).toEqual({ok:false});});
it('does not label an independently opened composer with a supplied receipt',()=>{detail();expect(run('read')).toEqual({ok:false});});
it('refuses foreign edit links and never clicks a sibling row',()=>{list();document.querySelector('a[href]')!.setAttribute('href','https://evil.test/');let clicks=0;document.querySelector('a[href]')!.addEventListener('click',()=>clicks++);expect(run('open')).toEqual({ok:false});expect(clicks).toBe(0);});
