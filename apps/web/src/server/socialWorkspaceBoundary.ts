import {socialBrowserRequests,socialBrowserResponses,socialCommandRefusalSchema} from '../shared/socialBrowserContract.ts';
import {socialMediaRequests,socialMediaResponses} from '../shared/socialMediaBrowserContract.ts';
import {socialMediaSignedPreviewSchema,socialMediaUploadUrlSchema} from '../shared/socialMediaBrowserContract.ts';
import {socialStandingRequests,socialStandingResponses} from '../shared/socialStandingBrowserContract.ts';
export function socialStorageResultAllowed(path:string,status:number,body:unknown,origin:string|undefined):boolean{
 if(status!==200||!['/social/media/preview','/social/assets/upload-url'].includes(path))return true;
 if(origin===undefined)return false;
 const parsed=(path==='/social/assets/upload-url'?socialMediaUploadUrlSchema:socialMediaSignedPreviewSchema).safeParse(body);
 if(!parsed.success)return false;
 const url=new URL(parsed.data.url),deadline=Date.parse(parsed.data.expiresAt);
 if(url.origin!==origin||url.username||url.password||url.hash||!url.searchParams.has('X-Amz-Signature')||deadline<=Date.now()||deadline>Date.now()+601_000)return false;
 if('headers' in parsed.data){
  const allowed:Readonly<Record<string,true>>={'content-type':true,'content-length':true,'x-amz-checksum-sha256':true,'x-amz-meta-callie-upload':true,'if-none-match':true};
  const headers=parsed.data.headers;
  if(headers===null||typeof headers!=='object'||Array.isArray(headers))return false;
  if(Object.entries(headers).some(([name,value])=>!allowed[name]||typeof value!=='string'))return false;
 }
 return true;
}
const AUTHORITY_REFUSALS:Readonly<Record<string,true>>={unauthenticated:true,session_changed:true,owner_unavailable:true,owner_changed:true,not_assigned:true,device_revoked:true,command_device_mismatch:true,command_payload_mismatch:true,command_kind_mismatch:true};
export function socialWorkspaceRequestAllowed(path:string,body:unknown):boolean{
 const schema=socialBrowserRequests[path]??socialMediaRequests[path]??socialStandingRequests[path];return schema===undefined||schema.safeParse(body).success;
}
export function socialWorkspaceBrowserResult(path:string,status:number,body:unknown):{status:number;body:unknown}|null{
 const schema=socialBrowserResponses[path]??socialMediaResponses[path]??socialStandingResponses[path];if(!schema)return null;
 if(status===409){
  const refusal=socialCommandRefusalSchema.safeParse(body);
  if(!refusal.success||AUTHORITY_REFUSALS[refusal.data.reason])return {status:409,body:{error:'browser_request_refused'}};
  const parsed=schema.safeParse(refusal.data);
  return parsed.success?{status:200,body:parsed.data}:{status:409,body:{error:'browser_request_refused'}};
 }
 if(status!==200)return {status,body:{error:'browser_request_refused'}};
 const parsed=schema.safeParse(body);
 return parsed.success?{status:200,body:parsed.data}:{status:502,body:{error:'browser_response_invalid'}};
}
