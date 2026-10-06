/** @vitest-environment jsdom */
import {afterEach,expect,it} from 'vitest';
import {linkedInDomScript} from '../src/main/social/adapters/linkedinDom.ts';
afterEach(()=>{document.body.innerHTML='';});
function run(input:Parameters<typeof linkedInDomScript>[0]){return new Function('document','window',`return ${linkedInDomScript(input)}`)(document,window);}
function composer(){document.body.innerHTML='<dialog open data-testid="dialog"><div role="button">Founder</div><div role="button">Post to Anyone</div><div role="button">Comments: Anyone</div><div contenteditable="true" role="textbox" componentkey="ShareBox_textEditor"><p>Approved text</p></div><a aria-label="Scheduled"></a><button disabled>Post</button></dialog>';}
it('reads only the unique native composer and does not mistake a Page for the profile',()=>{composer();expect(run({action:'read'})).toMatchObject({ok:true,view:{kind:'composer',postingName:'Founder',text:'Approved text'}});document.querySelector('[role="button"]')!.textContent='Company Page';expect(run({action:'openIdentity',name:'Founder'})).toEqual({ok:false,reason:'control_not_found'});});
it('refuses ambiguous dialogs and never exposes a generic click or publish operation',()=>{composer();document.body.innerHTML+='<dialog open data-testid="dialog"></dialog>';expect(run({action:'read'})).toEqual({ok:false,reason:'layout_changed'});expect(()=>linkedInDomScript({action:'publish'} as never)).toThrow();});
it('fills only the scheduling date/time controls using literal values and emits input events',()=>{
 document.body.innerHTML='<dialog open data-testid="dialog"><input data-testid="date-picker-input"><input data-testid="time-picker-input"><button>Confirm</button></dialog>';let events=0;document.addEventListener('input',()=>events++,{once:true});
 expect(run({action:'fillSchedule',date:'11/01/2026',time:'10:00 AM'})).toMatchObject({ok:true});expect((document.querySelector('[data-testid="date-picker-input"]') as HTMLInputElement).value).toBe('11/01/2026');expect(events).toBe(1);expect(run({action:'read'})).toMatchObject({view:{kind:'schedule',date:'11/01/2026',time:'10:00 AM'}});
});
it('requires exact date/time readback before confirming and ignores disabled or duplicate controls',()=>{
 document.body.innerHTML='<dialog open data-testid="dialog"><input data-testid="date-picker-input" value="11/01/2026"><input data-testid="time-picker-input" value="10:00 AM"><button>Confirm</button></dialog>';let clicked=0;document.querySelector('button')!.onclick=()=>clicked++;
 expect(run({action:'confirmSchedule',date:'11/02/2026',time:'10:00 AM'})).toEqual({ok:false,reason:'schedule_mismatch'});expect(clicked).toBe(0);expect(run({action:'confirmSchedule',date:'11/01/2026',time:'10:00 AM'})).toMatchObject({ok:true});expect(clicked).toBe(1);
});
it('selects only the exact time option in the menu controlled by the native input',()=>{
 document.body.innerHTML='<dialog open data-testid="dialog"><input data-testid="date-picker-input"><input data-testid="time-picker-input" aria-controls="times" aria-expanded="true"><div id="times" role="menu" data-testid="time-picker-menu"><div role="menuitemradio" data-testid="time-picker-option">10:00 AM</div><div role="menuitemradio" data-testid="time-picker-option">10:15 AM</div></div></dialog>';
 let chosen='';for(const e of document.querySelectorAll('[role="menuitemradio"]'))(e as HTMLElement).onclick=()=>{chosen=e.textContent!;};
 expect(run({action:'selectTime',time:'10:15 AM'} as never)).toEqual({ok:true});expect(chosen).toBe('10:15 AM');
 chosen='';expect(run({action:'selectTime',time:'10:30 AM'} as never)).toMatchObject({ok:false});expect(chosen).toBe('');
 document.querySelector('#times')!.innerHTML+='<div role="menuitemradio" data-testid="time-picker-option">10:15 AM</div>';
 expect(run({action:'selectTime',time:'10:15 AM'} as never)).toMatchObject({ok:false});
});
it('normalizes unpadded native dates while preserving exact confirmation checks',()=>{
 document.body.innerHTML='<dialog open data-testid="dialog"><input data-testid="date-picker-input" value="10/7/2026"><input data-testid="time-picker-input" value="12:00 PM"><button>Confirm</button></dialog>';let clicked=0;document.querySelector('button')!.onclick=()=>clicked++;
 expect(run({action:'read'})).toMatchObject({view:{date:'10/07/2026'}});
 expect(run({action:'confirmSchedule',date:'10/08/2026',time:'12:00 PM'})).toMatchObject({ok:false});expect(clicked).toBe(0);
 expect(run({action:'confirmSchedule',date:'10/07/2026',time:'12:00 PM'})).toEqual({ok:true});expect(clicked).toBe(1);
});
it('does not toggle an already open input-associated time menu closed',()=>{
 document.body.innerHTML='<dialog open data-testid="dialog"><input data-testid="date-picker-input"><input data-testid="time-picker-input" aria-expanded="true" aria-controls="times"><div id="times" data-testid="time-picker-menu" role="menu"></div><button data-testid="time-picker-clock-button" aria-label="Open time picker"></button></dialog>';let clicked=0;document.querySelector('button')!.onclick=()=>clicked++;
 expect(run({action:'openTime'})).toEqual({ok:true});expect(clicked).toBe(0);
});
it('opens scheduling from a composer that already has scheduled posts',()=>{composer();const a=document.querySelector('a')!;a.removeAttribute('aria-label');a.setAttribute('aria-labelledby','count-label');a.textContent='1';const label=document.createElement('span');label.id='count-label';label.textContent='Scheduled (1)';document.body.append(label);let clicks=0;a.onclick=()=>clicks++;expect(run({action:'openSchedule'})).toEqual({ok:true});expect(clicks).toBe(1);});
it('does not count an empty image-preview button as an account name',()=>{composer();const preview=document.createElement('div');preview.setAttribute('role','button');preview.setAttribute('tabindex','0');preview.innerHTML='<img alt="Approved image">';document.querySelector('dialog')!.append(preview);expect(run({action:'read'})).toMatchObject({view:{postingName:'Founder'}});preview.textContent='Other account';expect(run({action:'read'})).toMatchObject({view:{postingName:null}});});
