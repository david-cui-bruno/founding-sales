import {z} from 'zod';
import {linkedInSavedDetailScript} from './linkedinSavedDetail.ts';
import {linkedInImageEditorScript} from './linkedinImageEditor.ts';
const schema=z.strictObject({action:z.enum(['open','openAlt','read']),token:z.string().uuid(),receiptId:z.string().regex(/^urn:li:share:\d+$/),platformId:z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),postingName:z.string().min(1).max(200),text:z.string().min(1).max(3000),scheduleLabel:z.string().min(1).max(150),zone:z.string().min(1).max(100)});
/** Opens the already-saved single image's alt panel, then reads its actual field.
 * No input dispatch, Update, Next, Schedule or Post action is exposed. The caller
 * must first inspect this receipt through the same document's detail binding.
 */
export function linkedInSavedAltScript(raw:z.infer<typeof schema>):string{
 const input=schema.parse(raw);
 return `(()=>{const input=${JSON.stringify(input)},key='__callieLinkedInSavedAlt';const fail=()=>({ok:false});
 const detailBinding=window.__callieLinkedInDetail;
 if(!detailBinding||detailBinding.token!==input.token||detailBinding.receiptId!==input.receiptId||detailBinding.phase!=='read')return fail();
 const visible=e=>{for(let p=e;p;p=p.parentElement){const s=window.getComputedStyle(p);if(p.hidden||p.getAttribute('aria-hidden')==='true'||s.display==='none'||s.visibility==='hidden')return false;}return true;};
 const roots=Array.from(document.querySelectorAll('dialog[open][data-testid="dialog"]')).filter(visible);if(roots.length!==1)return fail();const root=roots[0];
 if(root.querySelector('[role="progressbar"],progress,[aria-busy="true"]'))return fail();
 if(input.action==='open'){
  if(window[key]?.token===input.token)return fail();
  const detail=${linkedInSavedDetailScript()};if(!detail.ok)return fail();
  if(['postingName','text','scheduleLabel','zone'].some(k=>detail.view[k]!==input[k])||detail.view.images.length!==1||detail.view.images[0].platformId!==input.platformId)return fail();
  const edits=Array.from(root.querySelectorAll('button[aria-label="Edit"]')).filter(visible);
  if(edits.length!==1||edits[0].disabled||edits[0].getAttribute('aria-disabled')==='true')return fail();
  window[key]={token:input.token,receiptId:input.receiptId,platformId:input.platformId,root,phase:'opened'};
  edits[0].click();return {ok:true};
 }
 const binding=window[key];if(!binding||binding.token!==input.token||binding.receiptId!==input.receiptId||binding.platformId!==input.platformId||binding.root!==root)return fail();
 const editor=${linkedInImageEditorScript({action:'read'})};if(!editor.ok||!editor.view.single||editor.view.busy)return fail();
 if(input.action==='openAlt'){
  if(binding.phase!=='opened'||editor.view.kind!=='editor')return fail();
  binding.phase='alt-attempted';return ${linkedInImageEditorScript({action:'openAlt'})};
 }
 if(binding.phase!=='alt-attempted'||editor.view.kind!=='alt'||typeof editor.view.alt!=='string'||editor.view.alt.length>1000)return fail();
 return {ok:true,view:{receiptId:binding.receiptId,platformId:binding.platformId,altText:editor.view.alt}};
 })()`;
}
