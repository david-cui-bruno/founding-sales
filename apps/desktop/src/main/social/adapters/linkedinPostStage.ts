import {z} from 'zod';
import {linkedInDraftImageProofScript} from './linkedinDraftImageProof.ts';
import type {ApprovedPost} from '../adapters.ts';
import {linkedInDomScript} from './linkedinDom.ts';
import {linkedInImageEditorScript} from './linkedinImageEditor.ts';
import {stageLinkedInText} from './linkedinStage.ts';
import {stageLinkedInImages} from './linkedinImages.ts';
import {finishLinkedInImage} from './linkedinImageFinish.ts';
type Ports=Parameters<typeof stageLinkedInText>[1]&{root:string};
const composerSchema=z.object({kind:z.literal('composer'),text:z.string(),postingName:z.string(),zone:z.string(),scheduleLabel:z.string()});
/** Preparation only. Submission still requires a separate exact-content check and server marker. */
export async function stageLinkedInPost(input:ApprovedPost,port:Ports):Promise<{ready:boolean;reason?:string}>{
 const post=structuredClone(input);
 const current=()=>port.current()&&port.contents.getURL()==='https://www.linkedin.com/sharing/compose';
 async function execute(code:string){if(!current())throw new Error('session_changed');const result=await port.contents.executeJavaScriptInIsolatedWorld(1001,[{code}],false);if(!current())throw new Error('session_changed');return z.object({ok:z.literal(true),view:z.unknown().optional()}).parse(result);}
 try{
  if(post.account.platform!=='linkedin'||post.images.length>1)return {ready:false,reason:'format_not_verified'};
  const initial=await execute(linkedInImageEditorScript({action:'read'}));
  z.object({kind:z.literal('composer'),busy:z.literal(false),images:z.array(z.unknown()).length(0)}).parse(initial.view);
  const staged=await stageLinkedInText({...post,images:[]},port);if(!staged.ready)return staged;
  if(!post.images.length)return staged;
  const before=composerSchema.parse((await execute(linkedInDomScript({action:'read'}))).view);
  if(before.text!==post.text||before.postingName!==post.account.displayName)throw new Error('content_changed');
  await execute(linkedInDomScript({action:'openMedia'}));
  let editorReady=false;
  for(let i=0;i<30;i++){
   const result=await execute(linkedInImageEditorScript({action:'read'}));
   if(z.object({kind:z.literal('editor')}).safeParse(result.view).success){editorReady=true;break;}
   await port.wait();
  }
  if(!editorReady)return {ready:false,reason:'media_editor_unavailable'};
  const transferred=await stageLinkedInImages(post.images,port);if(!transferred.ready)return transferred;
  const finished=await finishLinkedInImage(post.images[0]!.altText,port);if(!finished.ready)return finished;
  const proof=z.strictObject({sha256:z.string().regex(/^[a-f0-9]{64}$/),altText:z.string().max(1000),bytes:z.number().int().positive().max(5*1024*1024)}).parse((await execute(linkedInDraftImageProofScript())).view);
  if(proof.sha256!==post.images[0]!.sha256||proof.altText!==post.images[0]!.altText)return {ready:false,reason:'image_identity_unverified'};
  const after=composerSchema.parse((await execute(linkedInDomScript({action:'read'}))).view);
  if(JSON.stringify(before)!==JSON.stringify(after))return {ready:false,reason:'staged_content_changed'};
  return current()&&Date.parse(post.publishAt)>port.now()?{ready:true}:{ready:false,reason:'session_or_schedule_changed'};
 }catch{return {ready:false,reason:'post_staging_unverified'};}
}
