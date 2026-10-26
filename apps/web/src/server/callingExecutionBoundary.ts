import {z} from 'zod';
import {CALL_SESSION_REFUSAL_CODES} from '@fss/contracts';
const reasons=z.enum([...CALL_SESSION_REFUSAL_CODES,'firm_unknown','firm_suppressed','handle_suppressed','identity_missing','identity_shared_line_disabled','identity_disabled','identity_not_owned','route_missing','route_version_stale','route_invalid','route_retired','route_ineligible','not_assigned','zone_unresolved','posture_missing','outside_calling_window','workspace_paused','owner_paused','calling_paused','restore_in_progress','manual_suppression_review','route_candidate','posture_overlapping','posture_overdue','scoped_pause','reassignment','uncertain_reply','ambiguous_match','opportunity_manual','long_hold_review','provider_refusal','outreach_touch_unavailable','identity_unverified','ticket_unknown','ticket_expired','ticket_wrong_device','already_consumed','dnc_coverage_unknown','dnc_registry_match','invalid_input']);
const refusal=z.strictObject({status:z.literal('refused'),replayed:z.boolean(),reason:reasons});
const paths=new Set(['/calls/session','/calls/access-token','/calls/calling','/calls/history','/calling-identities','/calling/execution/receipt']);
/** Closed product refusals must not masquerade as auth transitions. Unknown command,
 * payload/device collisions and actual auth errors retain the gateway's fail-closed path. */
export function callingExecutionBrowserResult(path:string,status:number,body:unknown):{status:number;body:unknown}|null{
 if(!paths.has(path))return null;
 if(path==='/calls/session'&&status===409){const parsed=refusal.safeParse(body);if(parsed.success)return {status:200,body:parsed.data};}
 if((status===404||status===503)&&path!=='/calling/execution/receipt'){
  const error=z.object({error:z.enum(['not_found','firm_unknown','integration_unconfigured'])}).safeParse(body);
  if(error.success)return {status:200,body:{availability:'unavailable',reason:error.data.error==='not_found'?'calling_off':error.data.error}};
 }
 return null;
}
