import {z} from 'zod';
import {linkedInMediaCaptureScript} from './linkedinMediaCapture.ts';
import {linkedInDomScript} from './linkedinDom.ts';
import {linkedInImageEditorScript} from './linkedinImageEditor.ts';
const schema=z.strictObject({token:z.string().uuid(),postingName:z.string().min(1).max(200),text:z.string().min(1).max(3000),zone:z.string().min(1).max(100),scheduleLabel:z.string().min(1).max(150),image:z.strictObject({sha256:z.string().regex(/^[a-f0-9]{64}$/),altText:z.string().min(1).max(1000)}).optional()});
/** Final click primitive for text or one verified image. Caller must have a durable server submission
 * marker, current account/session and a live approved schedule before invoking.
 * An attempted click is never a receipt; recover via independent inspection.
 * Image capture is required before clicking; missing native identity afterwards
 * stays unknown. This primitive is not adapter activation.
 */
export function linkedInSubmitScript(raw:z.infer<typeof schema>):string{
 const input=schema.parse(raw);
 return `(${input.image?'async ':''}()=>{const input=${JSON.stringify(input)};const key='__callieLinkedInSubmission';
 const refuse=()=>({attempted:false});if(window[key])return refuse();
 ${input.image?`const capture=await ${linkedInMediaCaptureScript({action:'arm',token:input.token,...input.image})};if(!capture.ok||window[key])return refuse();`:''}
 const composer=${linkedInDomScript({action:'read'})};
 if(!composer.ok||composer.view.kind!=='composer')return refuse();
 for(const field of ['postingName','text','zone','scheduleLabel'])if(composer.view[field]!==input[field])return refuse();
 const media=${linkedInImageEditorScript({action:'read'})};
 if(!media.ok||media.view.kind!=='composer'||media.view.busy||media.view.images.length!==(input.image?1:0))return refuse();
 if(input.image&&(!media.view.images[0].loaded||media.view.images[0].alt!==input.image.altText))return refuse();
 const visible=e=>{for(let p=e;p;p=p.parentElement){const s=window.getComputedStyle(p);if(p.hidden||p.getAttribute('aria-hidden')==='true'||s.display==='none'||s.visibility==='hidden')return false;}return true;};
 const roots=Array.from(document.querySelectorAll('dialog[open][data-testid="dialog"]')).filter(visible);if(roots.length!==1)return refuse();
 const buttons=Array.from(roots[0].querySelectorAll('button')).filter(e=>visible(e)&&e.textContent.trim()==='Schedule');
 if(buttons.length!==1||buttons[0].disabled||buttons[0].getAttribute('aria-disabled')==='true')return refuse();
 // Persist the attempt before dispatch: a thrown handler or lost response must
 // never permit another click in this document, even with a fresh local token.
 window[key]={token:input.token,attempted:true};buttons[0].click();return {attempted:true};
 })()`;
}
