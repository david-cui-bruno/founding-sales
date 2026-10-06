import {z} from 'zod';
const date=z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/),time=z.string().regex(/^\d{1,2}:\d{2} (AM|PM)$/);
const actionSchema=z.discriminatedUnion('action',[
 z.strictObject({action:z.literal('read')}),z.strictObject({action:z.literal('focusText')}),
 z.strictObject({action:z.literal('openSchedule')}),
 z.strictObject({action:z.literal('openIdentity'),name:z.string().min(1).max(200)}),
 z.strictObject({action:z.literal('fillSchedule'),date,time}),z.strictObject({action:z.literal('confirmSchedule'),date,time}),
]);
export type LinkedInDomAction=z.infer<typeof actionSchema>;
/** Closed, code-owned actions observed on LinkedIn 6 Oct 2026.
 * No generic selector/action and deliberately no final Schedule/Post click.
 * Execute only in the isolated account world's approved composer URL.
 */
export function linkedInDomScript(raw:LinkedInDomAction):string{
 const input=actionSchema.parse(raw);
 return `(()=>{
 const input=${JSON.stringify(input)};
 const visible=e=>{for(let p=e;p;p=p.parentElement){const s=window.getComputedStyle(p);if(p.hidden||p.getAttribute('aria-hidden')==='true'||s.display==='none'||s.visibility==='hidden')return false;}return true;};
 const dialogs=Array.from(document.querySelectorAll('dialog[open][data-testid="dialog"]')).filter(visible);
 const refuse=reason=>({ok:false,reason});if(dialogs.length!==1)return refuse('layout_changed');const root=dialogs[0];
 const all=selector=>Array.from(root.querySelectorAll(selector)).filter(visible);
 const one=selector=>{const found=all(selector);return found.length===1?found[0]:null;};
 const text=e=>(e.innerText??e.textContent??'').replace(/\\r\\n/g,'\\n').trim();
 const click=e=>{if(!e||e.disabled||e.getAttribute('aria-disabled')==='true')return refuse('control_not_found');e.click();return {ok:true};};
 const editor=one('[contenteditable="true"][role="textbox"][componentkey="ShareBox_textEditor"]');
 const date=one('input[data-testid="date-picker-input"]'),time=one('input[data-testid="time-picker-input"]');
 const headers=all('[role="button"]').filter(e=>!['Post to Anyone','Comments: Anyone'].includes(text(e)));
 if(input.action==='read')return {ok:true,view:{zone:Intl.DateTimeFormat().resolvedOptions().timeZone,kind:editor?'composer':date&&time?'schedule':'unknown',postingName:headers.length===1?text(headers[0]):null,text:editor?text(editor):null,date:date?.value??null,time:time?.value??null,identities:all('[role="radio"]').map(e=>({name:text(e),selected:e.getAttribute('aria-checked')==='true'})),scheduleLabel:all('p,span,div').map(text).filter(t=>/^Posting at [^\\n]{1,100}$/.test(t)).sort((a,b)=>a.length-b.length)[0]??null}};
 if(input.action==='focusText'){if(!editor)return refuse('layout_changed');editor.focus();const range=document.createRange();range.selectNodeContents(editor);const selection=window.getSelection();if(!selection)return refuse('editor_unavailable');selection.removeAllRanges();selection.addRange(range);return {ok:true};}
 if(input.action==='openIdentity'){const targets=headers.filter(e=>text(e)===input.name);return click(targets.length===1?targets[0]:null);}
 if(input.action==='openSchedule')return editor?click(one('a[aria-label="Scheduled"]')):refuse('layout_changed');
 if(!date||!time||editor)return refuse('layout_changed');
 if(input.action==='fillSchedule'){
  const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')?.set;if(!setter)return refuse('input_unavailable');
  for(const [element,value] of [[date,input.date],[time,input.time]]){setter.call(element,value);element.dispatchEvent(new window.Event('input',{bubbles:true}));element.dispatchEvent(new window.Event('change',{bubbles:true}));element.blur();}return {ok:true};
 }
 if(input.action==='confirmSchedule'){
  if(date.value!==input.date||time.value!==input.time)return refuse('schedule_mismatch');
  const buttons=all('button').filter(e=>text(e)==='Confirm');return click(buttons.length===1?buttons[0]:null);
 }
 return refuse('unsupported_action');
})()`;
}
