import {z} from 'zod';
const voiceRefusal=z.strictObject({status:z.literal('refused'),replayed:z.boolean(),reason:z.enum(['invalid_input','owner_unavailable','already_exists','not_found','stale_revision','not_removed','removed'])});
const contentRefusal=z.strictObject({status:z.literal('refused'),replayed:z.boolean(),reason:z.enum(['invalid_input','not_found','owner_unavailable','stale_revision','expired','removed','source_changed_or_unavailable','suggestion_changed_or_expired'])});
/** Only finite domain-state refusals survive as content responses. Never convert
 * command-device/payload/kind collisions or unknown/auth failures into success. */
export function privateDraftBrowserResult(path:string,status:number,body:unknown):{status:number;body:unknown}|null{
 if(path==='/social/voice-preferences/save'&&status===409){const result=voiceRefusal.safeParse(body);return result.success?{status:200,body:result.data}:null;}
 if(path!=='/social/private-drafts/save'||status!==409)return null;
 const result=contentRefusal.safeParse(body);return result.success?{status:200,body:result.data}:null;
}
