import {z} from 'zod';
const refused=z.strictObject({status:z.literal('refused'),replayed:z.boolean(),reason:z.enum(['candidate_changed','candidate_unavailable','invalid_input'])});
/** Product-state refusal only. Auth, membership, session and command collisions stay generic. */
export function manualProspectBrowserResult(path:string,status:number,body:unknown):{status:number;body:unknown}|null{
 if(path!=='/sourcing/candidates/prospects/feedback'||status!==409)return null;
 const parsed=refused.safeParse(body);return parsed.success?{status:200,body:parsed.data}:null;
}
