import {z} from 'zod';
const refused=z.strictObject({status:z.literal('refused'),replayed:z.boolean(),reason:z.enum(['candidate_changed','candidate_unavailable','invalid_input'])});
const activityRefused=z.strictObject({status:z.literal('refused'),replayed:z.boolean(),reason:z.enum(['invalid_input','already_exists','not_found','removed','stale_revision','invalid_time'])});
const unavailable=z.strictObject({error:z.enum(['candidate_unavailable','candidate_changed'])});
/** Product-state refusal only. Auth, membership, session and command collisions stay generic. */
export function manualProspectBrowserResult(path:string,status:number,body:unknown):{status:number;body:unknown}|null{
 if(status===409&&['/sourcing/candidates/prospects/activity/list','/sourcing/candidates/prospects/activity/read','/sourcing/candidates/prospects/activity/save'].includes(path)){
  const missing=unavailable.safeParse(body);
  if(missing.success)return {status:200,body:path.endsWith('/save')?{status:'refused',replayed:false,reason:missing.data.error}:missing.data};
  if(path.endsWith('/save')){const result=activityRefused.safeParse(body);return result.success?{status:200,body:result.data}:null;}
 }
 if(path!=='/sourcing/candidates/prospects/feedback'||status!==409)return null;
 const parsed=refused.safeParse(body);return parsed.success?{status:200,body:parsed.data}:null;
}
