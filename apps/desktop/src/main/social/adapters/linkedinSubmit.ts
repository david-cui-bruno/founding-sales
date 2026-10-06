import {z} from 'zod';
import {linkedInDomScript} from './linkedinDom.ts';
import {linkedInImageEditorScript} from './linkedinImageEditor.ts';
const schema=z.strictObject({token:z.string().uuid(),postingName:z.string().min(1).max(200),text:z.string().min(1).max(3000),zone:z.string().min(1).max(100),scheduleLabel:z.string().min(1).max(150)});
/** Text-only final click primitive. Caller must have a durable server submission
 * marker, current account/session and a live approved schedule before invoking.
 * An attempted click is never a receipt; recover via independent inspection.
 * Images stay refused until saved media identity/alt persistence is verified.
 */
export function linkedInSubmitScript(raw:z.infer<typeof schema>):string{
 const input=schema.parse(raw);
 return `(()=>{const input=${JSON.stringify(input)};const key='__callieLinkedInSubmission';
 const refuse=()=>({attempted:false});if(window[key])return refuse();
 const composer=${linkedInDomScript({action:'read'})};
 if(!composer.ok||composer.view.kind!=='composer')return refuse();
 for(const field of ['postingName','text','zone','scheduleLabel'])if(composer.view[field]!==input[field])return refuse();
 const media=${linkedInImageEditorScript({action:'read'})};
 if(!media.ok||media.view.kind!=='composer'||media.view.busy||media.view.images.length)return refuse();
 const visible=e=>{for(let p=e;p;p=p.parentElement){const s=window.getComputedStyle(p);if(p.hidden||p.getAttribute('aria-hidden')==='true'||s.display==='none'||s.visibility==='hidden')return false;}return true;};
 const roots=Array.from(document.querySelectorAll('dialog[open][data-testid="dialog"]')).filter(visible);if(roots.length!==1)return refuse();
 const buttons=Array.from(roots[0].querySelectorAll('button')).filter(e=>visible(e)&&e.textContent.trim()==='Schedule');
 if(buttons.length!==1||buttons[0].disabled||buttons[0].getAttribute('aria-disabled')==='true')return refuse();
 // Persist the attempt before dispatch: a thrown handler or lost response must
 // never permit another click in this document, even with a fresh local token.
 window[key]={token:input.token,attempted:true};buttons[0].click();return {attempted:true};
 })()`;
}
