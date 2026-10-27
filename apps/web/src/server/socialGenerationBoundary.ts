import {z} from 'zod';
const refusal=z.strictObject({status:z.literal('refused'),replayed:z.boolean(),reason:z.enum([
 'invalid_input','owner_unavailable','owner_required','draft_requests_pending','sanitized_facts_required',
 'voice_guide_unavailable','voice_guide_changed_or_unavailable','input_too_large','not_found',
 'block_changed','block_retired','block_unapproved','news_original_required',
 'news_source_stale_or_unavailable','news_original_support_unavailable','source_changed_or_unavailable',
])});
/** Domain business refusals are content. Envelope, auth and receipt collisions
 * remain transport failures and must never clear uncertain command custody. */
export function socialGenerationBrowserResult(path:string,status:number,body:unknown):{status:number;body:unknown}|null{
 if(path!=='/social/drafts/request'||status!==409)return null;
 const parsed=refusal.safeParse(body);return parsed.success?{status:200,body:parsed.data}:null;
}
