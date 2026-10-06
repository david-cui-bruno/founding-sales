import {z} from 'zod';
import {linkedInScheduledListScript} from './linkedinScheduledList.ts';
const schema=z.strictObject({action:z.enum(['openMenu','deleteMenu','confirm']),receiptId:z.string().regex(/^urn:li:share:\d+$/),text:z.string().min(1).max(10000),scheduleLabel:z.string().min(1).max(150),token:z.string().uuid()});
/** Isolated-world, document-bound cancellation handshake. Never chooses Post now. */
export function linkedInCancelScript(input:z.infer<typeof schema>):string{
 const data=schema.parse(input);
 return `(()=>{const input=${JSON.stringify(data)};const key='__callieLinkedInCancellation';
 const visible=e=>{for(let p=e;p;p=p.parentElement){const s=window.getComputedStyle(p);if(p.hidden||p.getAttribute('aria-hidden')==='true'||s.display==='none'||s.visibility==='hidden')return false;}return true;};
 const one=xs=>xs.length===1?xs[0]:null;const fail=()=>({ok:false});
 const click=e=>{if(!e||e.disabled||e.getAttribute('aria-disabled')==='true')return fail();e.click();return {ok:true};};
 const previous=window[key];
 if(input.action==='confirm'){
  if(!previous||previous.token!==input.token||previous.receiptId!==input.receiptId||previous.phase!=='confirm')return fail();
  const dialog=one(Array.from(document.querySelectorAll('dialog[open][data-testid="dialog"]')).filter(e=>visible(e)&&Array.from(e.querySelectorAll('h2')).some(h=>h.textContent.trim()==='Delete this post?')));if(!dialog)return fail();
  const button=one(Array.from(dialog.querySelectorAll('button')).filter(e=>visible(e)&&e.textContent.trim()==='Delete Post'));
  if(!button||button.disabled)return fail();window[key]={...previous,phase:'attempted'};return click(button);
 }
 const list=${linkedInScheduledListScript()};if(!list.ok)return fail();const target=one(list.rows.filter(r=>r.receiptId===input.receiptId));if(!target||target.text!==input.text||target.scheduleLabel!==input.scheduleLabel)return fail();
 const row=one(Array.from(document.querySelectorAll('[id^="ScheduledPostRowSlot_"]')).filter(e=>visible(e)&&e.id.match(/^ScheduledPostRowSlot_(urn:li:share:\\d+)_gen\\d+$/)?.[1]===input.receiptId));if(!row)return fail();
 if(input.action==='openMenu'){
  if(previous?.token===input.token)return fail();
  const button=one(Array.from(row.querySelectorAll('[role="button"]')).filter(e=>visible(e)&&e.querySelector('svg[aria-label="More options"]')));if(!button)return fail();
  window[key]={token:input.token,receiptId:input.receiptId,phase:'menu'};return click(button);
 }
 if(!previous||previous.token!==input.token||previous.receiptId!==input.receiptId||previous.phase!=='menu')return fail();
 const item=one(Array.from(document.querySelectorAll('[popover] [role="menuitem"]')).filter(e=>visible(e)&&e.textContent.trim()==='Delete post'));if(!item)return fail();
 window[key]={...previous,phase:'confirm'};return click(item);
 })()`;
}
