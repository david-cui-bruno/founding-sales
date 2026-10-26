import {z} from 'zod';
import {PROSPECT_PHONE_DISCOVERY_PATHS} from '@fss/contracts';

export const PROSPECT_PHONE_DISCOVERY_BROWSER_PATHS=new Set<string>(PROSPECT_PHONE_DISCOVERY_PATHS);
const refusalSchema=z.strictObject({status:z.literal('refused'),replayed:z.boolean(),reason:z.string()});
// Deliberately finite. New domain reasons need presentation review, not automatic
// exposure. Authentication, roles and command custody remain generic failures.
const productReasons=new Set([
 'candidate_unavailable','candidate_changed','source_unavailable','source_not_permitted','source_changed',
 'source_expired','official_site_unknown','retained_only','research_disabled','research_held','daily_firm_ceiling',
 'discovery_interrupted','discovery_expired','no_readable_text','bounded_capture_incomplete',
]);

/** Presentation only. Never dispatch, reconcile UNKNOWN, or change clientVersion. */
export function prospectPhoneDiscoveryBrowserResult(path:string,status:number,body:unknown):{status:number;body:unknown}|null {
 if(path===PROSPECT_PHONE_DISCOVERY_PATHS[1]&&status===404&&z.strictObject({error:z.literal('not_found')}).safeParse(body).success)return {status:200,body:null};
 if(path!==PROSPECT_PHONE_DISCOVERY_PATHS[0]||status!==409)return null;
 const refusal=refusalSchema.safeParse(body);
 return refusal.success&&productReasons.has(refusal.data.reason)?{status:200,body:refusal.data}:null;
}
