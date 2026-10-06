import {z} from 'zod';
import {linkedInScheduledListScript} from './linkedinScheduledList.ts';
import {linkedInSavedDetailScript} from './linkedinSavedDetail.ts';
const schema=z.strictObject({action:z.enum(['open','read']),receiptId:z.string().regex(/^urn:li:share:\d+$/),token:z.string().uuid()});
/** Navigation only: no save/edit/submit operations. Binding is confined to the
 * isolated world's current document. A reload loses it and must be reinspected.
 */
export function linkedInDetailNavigationScript(raw:z.infer<typeof schema>):string{
 const input=schema.parse(raw);
 return `(()=>{const input=${JSON.stringify(input)};const key='__callieLinkedInDetail';const fail=()=>({ok:false});
 if(input.action==='read'){
  const binding=window[key];if(!binding||binding.token!==input.token||binding.receiptId!==input.receiptId||binding.phase!=='opened')return fail();
  const detail=${linkedInSavedDetailScript()};if(!detail.ok||detail.view.images.length!==binding.imageCount)return fail();
  window[key]={...binding,phase:'read'};return {ok:true,view:{receiptId:binding.receiptId,...detail.view}};
 }
 if(window[key]?.token===input.token)return fail();
 const list=${linkedInScheduledListScript()};if(!list.ok||list.rows.filter(r=>r.receiptId===input.receiptId).length!==1)return fail();
 const rows=Array.from(document.querySelectorAll('[id^="ScheduledPostRowSlot_"]')).filter(e=>e.id.match(/^ScheduledPostRowSlot_(urn:li:share:\\d+)_gen\\d+$/)?.[1]===input.receiptId);if(rows.length!==1)return fail();
 const cards=rows[0].querySelectorAll('[role="listitem"]');if(cards.length!==1)return fail();const link=cards[0].closest('a');if(!link||!rows[0].contains(link))return fail();
 let url;try{url=new URL(link.getAttribute('href'));}catch{return fail();}
 if(url.href!=='https://www.linkedin.com/sharing/compose'||link.getAttribute('aria-disabled')==='true')return fail();
 window[key]={token:input.token,receiptId:input.receiptId,phase:'opened',imageCount:list.rows.find(r=>r.receiptId===input.receiptId).images.length};link.click();return {ok:true};
 })()`;
}
