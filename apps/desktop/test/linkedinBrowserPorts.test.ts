/** @vitest-environment jsdom */
import {afterEach,expect,it,vi} from 'vitest';
import {createLinkedInBrowserPorts} from '../src/main/social/adapters/linkedinBrowserPorts.ts';
afterEach(()=>{document.body.innerHTML='';});
function setup(){let current=true;const execute=vi.fn(async(_world:number,scripts:{code:string}[])=>new Function('document','window',`return ${scripts[0]!.code}`)(document,window));const loadURL=vi.fn(async(_url:string)=>{document.body.innerHTML='<dialog open data-testid="dialog"><div componentkey="ShareBox_textEditor"></div><a aria-label="Scheduled"></a></dialog>';document.querySelector('a')!.onclick=()=>{document.querySelector('dialog')!.innerHTML='<input data-testid="date-picker-input"><input data-testid="time-picker-input"><a>Scheduled (0)</a>';document.querySelector('a')!.onclick=()=>{document.querySelector('dialog')!.innerHTML='<div data-sdui-screen="com.linkedin.sdui.flagshipnav.sharing.ShareSchedulePostList"><a>Scheduled (0)</a><p>When you schedule a post, it automatically posts at the date and time you chose</p></div>';};};});const raw={current:()=>current,now:()=>0,wait:async()=>{},loadURL,contents:{getURL:()=> 'https://www.linkedin.com/sharing/compose',insertText:vi.fn(),executeJavaScriptInIsolatedWorld:execute}};return {raw,ports:createLinkedInBrowserPorts(raw),stop:()=>{current=false;}};}
it('navigates composer to schedule list using the actual closed scripts and reads timezone',async()=>{const h=setup();await h.ports.openScheduledList();expect(await h.ports.list()).toMatchObject({ok:true,total:0,complete:true,rows:[],zone:Intl.DateTimeFormat().resolvedOptions().timeZone});expect(h.raw.loadURL).toHaveBeenCalledTimes(1);});
it('does no navigation or reads after session invalidation',async()=>{const h=setup();h.stop();await expect(h.ports.openScheduledList()).rejects.toThrow();expect(h.raw.loadURL).not.toHaveBeenCalled();expect(h.raw.contents.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();});
it('bounds a missing dialog instead of repeatedly clicking controls',async()=>{const h=setup();h.raw.loadURL.mockImplementation(async()=>{document.body.innerHTML='';});await expect(h.ports.openScheduledList()).rejects.toThrow();expect(h.raw.contents.executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(30);});
it('opens only a validated share receipt and restores the identity surface after readback',async()=>{
 const h=setup();let url='https://www.linkedin.com/feed/';h.raw.contents.getURL=()=>url;
 h.raw.loadURL.mockImplementation(async next=>{url=next;document.body.innerHTML='';});
 expect(await h.ports.published('urn:li:share:123')).toEqual({ok:false});
 expect(h.raw.loadURL.mock.calls.map(c=>c[0])).toEqual(['https://www.linkedin.com/feed/update/urn:li:share:123/','https://www.linkedin.com/feed/']);
 h.raw.loadURL.mockClear();await expect(h.ports.published('https://evil.test')).rejects.toThrow();expect(h.raw.loadURL).not.toHaveBeenCalled();
});
it('does not continue or restore a publication browser after session invalidation',async()=>{
 const h=setup();h.raw.loadURL.mockImplementation(async()=>{h.stop();});
 await expect(h.ports.published('urn:li:share:123')).rejects.toThrow();expect(h.raw.loadURL).toHaveBeenCalledTimes(1);expect(h.raw.contents.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
});
it('waits when a native navigation control has not mounted, without repeating a successful click',async()=>{const h=setup();const execute=h.raw.contents.executeJavaScriptInIsolatedWorld;const original=execute.getMockImplementation()!;let refused=false,clicked=0;execute.mockImplementation(async(world,scripts)=>{if(scripts[0]!.code.includes('const action="openSchedule"')){if(!refused){refused=true;return {ok:false};}clicked++;}return original(world,scripts);});await h.ports.openScheduledList();expect(refused).toBe(true);expect(clicked).toBe(1);expect(await h.ports.list()).toMatchObject({complete:true,total:0});});
it('opens the counted scheduling control through its accessible label',async()=>{const h=setup();const load=h.raw.loadURL.getMockImplementation()!;h.raw.loadURL.mockImplementation(async url=>{await load(url);const a=document.querySelector('a')!;a.removeAttribute('aria-label');a.setAttribute('aria-labelledby','scheduled-label');a.textContent='1';const label=document.createElement('span');label.id='scheduled-label';label.textContent='Scheduled (1)';document.body.append(label);});await h.ports.openScheduledList();expect(await h.ports.list()).toMatchObject({complete:true});});
it('waits for rows to finish loading after the list shell appears',async()=>{const h=setup();await h.ports.openScheduledList();const execute=h.raw.contents.executeJavaScriptInIsolatedWorld;execute.mockResolvedValueOnce({ok:true,total:1,complete:false,rows:[],zone:'America/New_York'});expect(await h.ports.list()).toMatchObject({complete:true,total:0});});

it('waits without navigating until the saving composer disappears onto the feed',async()=>{
 const h=setup();document.body.innerHTML='<main></main><dialog open data-testid="dialog"><div componentkey="ShareBox_textEditor"></div><progress></progress></dialog>';
 let waits=0;h.raw.wait=async()=>{if(++waits===3)document.querySelector('dialog')!.remove();};
 const ports=createLinkedInBrowserPorts(h.raw);
 expect(await ports.waitForSave()).toBe(true);expect(waits).toBe(3);expect(h.raw.loadURL).not.toHaveBeenCalled();
});
it('does not mistake a stuck composer, empty page or invalidated session for a settled save',async()=>{
 const h=setup();document.body.innerHTML='<main></main><dialog open data-testid="dialog"><div componentkey="ShareBox_textEditor"></div></dialog>';
 expect(await h.ports.waitForSave()).toBe(false);
 document.body.innerHTML='';expect(await h.ports.waitForSave()).toBe(false);
 h.stop();expect(await h.ports.waitForSave()).toBe(false);expect(h.raw.loadURL).not.toHaveBeenCalled();
});

it('allows an observed composer-to-feed route change, but refuses an unrelated redirect',async()=>{
 const h=setup();let url='https://www.linkedin.com/sharing/compose';h.raw.contents.getURL=()=>url;
 document.body.innerHTML='<main></main><dialog open data-testid="dialog"><progress></progress></dialog>';
 h.raw.wait=async()=>{url='https://www.linkedin.com/feed/?posted=true';document.querySelector('dialog')?.remove();};
 expect(await createLinkedInBrowserPorts(h.raw).waitForSave()).toBe(true);
 url='https://www.linkedin.com/login';expect(await h.ports.waitForSave()).toBe(false);
 expect(h.raw.loadURL).not.toHaveBeenCalled();
});
it('reads saved preview without opening extra editing dialogs',async()=>{
 const h=setup();let opened=false,altOpened=false;
 h.raw.contents.executeJavaScriptInIsolatedWorld.mockImplementation(async(_world,scripts)=>{
  const code=scripts[0]!.code;
  if(code.includes("key='__callieLinkedInSavedAlt'")){
   if(code.includes('"action":"open",')){opened=true;return {ok:true};}
   if(code.includes('"action":"openAlt",')){altOpened=true;return {ok:true};}
   return {ok:true,view:{receiptId:'urn:li:share:123',platformId:'native-image',altText:'Saved alt'}};
  }
  if(code.includes('"action":"open",'))return {ok:true};
  return {ok:true,view:{receiptId:'urn:li:share:123',postingName:'Founder',text:'Text',scheduleLabel:'Posting at Tue, Oct 13, 12:00 PM',zone:'America/New_York',images:[{platformId:'native-image',previewAlt:'',loaded:true}],altTextVerified:false}};
 });
 expect(await h.ports.detail('urn:li:share:123')).toMatchObject({images:[{platformId:'native-image',loaded:true}],altTextVerified:false});
 expect(opened||altOpened).toBe(false);expect(h.raw.loadURL).not.toHaveBeenCalled();
});
