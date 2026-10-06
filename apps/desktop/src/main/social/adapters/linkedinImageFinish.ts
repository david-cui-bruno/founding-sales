import {z} from 'zod';
import {linkedInImageEditorScript} from './linkedinImageEditor.ts';
const viewSchema=z.strictObject({kind:z.enum(['editor','alt','composer']),alt:z.string().max(1000).nullable(),single:z.boolean(),busy:z.boolean(),images:z.array(z.strictObject({alt:z.string().max(1000),loaded:z.boolean()})).max(20)});
interface Port{current():boolean;wait():Promise<void>;contents:{getURL():string;executeJavaScriptInIsolatedWorld(world:number,scripts:{code:string}[],gesture?:boolean):Promise<unknown>}}
/** Single-image completion only; multi-image navigation is not yet verified. */
export async function finishLinkedInImage(altText:string,port:Port):Promise<{ready:boolean;reason?:string}>{
 const current=()=>port.current()&&port.contents.getURL()==='https://www.linkedin.com/sharing/compose';
 async function action(input:Parameters<typeof linkedInImageEditorScript>[0]){if(!current())throw new Error('session_changed');const result=await port.contents.executeJavaScriptInIsolatedWorld(1001,[{code:linkedInImageEditorScript(input)}],false);if(!current())throw new Error('session_changed');return z.object({ok:z.literal(true),view:viewSchema.optional()}).parse(result);}
 async function read(){const result=await action({action:'read'});return viewSchema.parse(result.view);}
 async function waitFor(kind:'editor'|'alt'|'composer'){for(let i=0;i<30;i++){const view=await read();if(view.kind===kind&&!view.busy&&(kind!=='composer'||view.images.every(image=>image.loaded)))return view;await port.wait();}throw new Error('upload_timeout');}
 try{
  if(!altText.trim()||altText.length>1000)return {ready:false,reason:'invalid_alt_text'};
  if(!(await waitFor('editor')).single)return {ready:false,reason:'image_count_mismatch'};
  await action({action:'openAlt'});await waitFor('alt');await action({action:'fillAlt',text:altText});await port.wait();
  if((await read()).alt!==altText)throw new Error('alt_mismatch');
  await action({action:'saveAlt',text:altText});await waitFor('editor');
  await action({action:'openAlt'});if((await waitFor('alt')).alt!==altText)throw new Error('alt_mismatch');
  await action({action:'back'});await waitFor('editor');await action({action:'next'});
  const preview=await waitFor('composer');if(preview.images.length!==1||preview.images[0]!.alt!==altText)throw new Error('preview_mismatch');
  return current()?{ready:true}:{ready:false,reason:'session_changed'};
 }catch{return {ready:false,reason:'image_completion_unverified'};}
}
