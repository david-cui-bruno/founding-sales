import {z} from 'zod';
const reasons=z.enum(['invalid_input','draft_unavailable','draft_conflict','source_unavailable','source_changed','stale_revision','candidate_unavailable','candidate_changed','firm_unknown','not_assigned','occurred_at_in_future','contact_unknown','route_unknown','item_unknown','attempt_unavailable']);
const manualCreateRefusal=z.strictObject({status:z.literal('refused'),replayed:z.boolean(),reason:z.enum(['invalid_time','already_exists'])});
const refusal=z.strictObject({status:z.literal('refused'),replayed:z.boolean(),reason:reasons});
const error=z.strictObject({error:reasons});
const paths=new Set(['/calling/wrap','/calling/follow-ups/list','/calling/follow-ups/read','/calling/follow-ups/save','/calling/follow-ups/receipt']);
/** Only known product conflicts are content responses. Authentication and command
 * UUID/device/payload collisions remain fail-closed at the browser boundary. */
export function callingBrowserResult(path:string,status:number,body:unknown):{status:number;body:unknown}|null{
 if(!paths.has(path))return null;
 if(path==='/calling/wrap'&&status===409){const parsed=manualCreateRefusal.safeParse(body);if(parsed.success)return {status:200,body:parsed.data};}
 if(status===409){const parsed=refusal.safeParse(body);if(parsed.success)return {status:200,body:parsed.data};const unavailable=error.safeParse(body);if(unavailable.success)return {status:200,body:unavailable.data};}
 if(path==='/calling/follow-ups/read'&&status===404){const parsed=z.strictObject({error:z.literal('draft_unavailable')}).safeParse(body);if(parsed.success)return {status:200,body:parsed.data};}
 return null;
}
