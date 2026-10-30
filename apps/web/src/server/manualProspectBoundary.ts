import {z} from 'zod';
import {preparedProspectRefusalSchema} from '@fss/contracts';
const refused=z.strictObject({status:z.literal('refused'),replayed:z.boolean(),reason:z.enum(['candidate_changed','candidate_unavailable','invalid_input','phone_source_changed'])});
const activityRefused=z.strictObject({status:z.literal('refused'),replayed:z.boolean(),reason:z.enum(['invalid_input','already_exists','not_found','removed','stale_revision','invalid_time'])});
const unavailable=z.strictObject({error:z.enum(['candidate_unavailable','candidate_changed'])});
/** Product-state refusal only. Auth, membership, session and command collisions stay generic. */
export function manualProspectBrowserResult(path:string,status:number,body:unknown):{status:number;body:unknown}|null{
 if(status===409&&['/sourcing/prepared-prospects/list','/sourcing/prepared-prospects/read'].includes(path)){
  const result=preparedProspectRefusalSchema.safeParse(body);return result.success?{status:200,body:result.data}:null;
 }
 if(status===409&&path.startsWith('/sourcing/candidates/prospects/priority/')){
  const action=path.slice('/sourcing/candidates/prospects/priority/'.length);
  const reason=z.enum(['view_changed','assessment_changed','role_unavailable','source_unavailable','source_changed','source_expired','candidate_changed','candidate_unavailable','invalid_input']);
  if(action==='list'||action==='learning'){
   const result=z.strictObject({error:reason}).safeParse(body);
   return result.success?{status:200,body:result.data}:null;
  }
  if(action==='save'||action==='consider'){
   const changed=z.strictObject({error:reason}).safeParse(body);
   if(changed.success)return {status:200,body:{status:'refused',replayed:false,reason:changed.data.error}};
   const result=z.strictObject({status:z.literal('refused'),replayed:z.boolean(),reason}).safeParse(body);
   return result.success?{status:200,body:result.data}:null;
  }
  return null;
 }
 if(status===409&&['/sourcing/candidates/prospects/activity/list','/sourcing/candidates/prospects/activity/read','/sourcing/candidates/prospects/activity/save'].includes(path)){
  const missing=unavailable.safeParse(body);
  if(missing.success)return {status:200,body:path.endsWith('/save')?{status:'refused',replayed:false,reason:missing.data.error}:missing.data};
  if(path.endsWith('/save')){const result=activityRefused.safeParse(body);return result.success?{status:200,body:result.data}:null;}
 }
 if(path!=='/sourcing/candidates/prospects/feedback'||status!==409)return null;
 const changed=z.strictObject({error:z.literal('phone_source_changed')}).safeParse(body);
 if(changed.success)return {status:200,body:{status:'refused',replayed:false,reason:changed.data.error}};
 const parsed=refused.safeParse(body);return parsed.success?{status:200,body:parsed.data}:null;
}
