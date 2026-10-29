import {US_BUSINESS_REGIONS,US_BUSINESS_STATE_NAMES,usBusinessRegionSchema,type NativeFirmPolicyVersion} from '../../contracts/src/usBusinessGeography.ts';
import {isTargetGeography} from './qualificationPolicy.ts';

const fold=(value:string)=>value.normalize('NFKC').replace(/\s+/gu,' ').trim().toLowerCase();
const escape=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&');
export function isCurrentUSBusinessGeography(region:string,locality:string):boolean {
 return usBusinessRegionSchema.safeParse(region).success&&locality.trim().length>0;
}
/** Existing coverage retains its exact policy identity. Added coverage is explicit. */
export function currentNativeFirmPolicy(region:string,locality:string):NativeFirmPolicyVersion|null {
 if(!isCurrentUSBusinessGeography(region,locality))return null;
 return isTargetGeography(region,locality)?'native-firm-eligibility-v1':'native-firm-eligibility-us-v1';
}
const provinces=['Alberta','British Columbia','Manitoba','New Brunswick','Newfoundland and Labrador','Nova Scotia',
 'Ontario','Prince Edward Island','Quebec','Saskatchewan','Northwest Territories','Nunavut','Yukon',
 'AB','BC','MB','NB','NL','NS','ON','PE','QC','SK','NT','NU','YT'];
// Literal geography in a prospective/conditional claim does not establish current service.
const nonCurrentService=/\b(?:if|unless|would|could|might|may|will|plans?|planned|planning|intends?|intended|intending|expects?|expected|expecting|hopes?|hoped|hoping|future|upcoming|proposed|potential|conditional|previously|formerly|historically|never|not|cannot|ceased|stopped|discontinued|excluded|outside)\b|\b(?:going to|don['’]t|doesn['’]t|can['’]t|used to)\b/iu;
/** A current-US location needs the literal city followed by its FULL state name.
 * Codes such as CA never establish country. Unknown, conflicting and negative
 * locations stay held; this performs no geocoding or outside lookup. */
export function supportsCurrentUSServiceLocation(value:string,region:string,locality:string):boolean {
 const parsed=usBusinessRegionSchema.safeParse(region);
 if(!parsed.success||!locality.trim())return false;
 const text=fold(value),city=escape(fold(locality)),state=fold(US_BUSINESS_STATE_NAMES[parsed.data]);
 if(/\b(?:canada|canadian|province|provincial)\b/iu.test(text)||nonCurrentService.test(text))return false;
 const adjacent=(label:string)=>new RegExp(`(?:^|[^\\p{L}\\p{N}])${city}(?:\\s*,\\s*|\\s+)${escape(label)}(?=$|[^\\p{L}\\p{N}])`,'u').test(text);
 if(!adjacent(state))return false;
 // A second interpretation of this same city cannot borrow the positive pair.
 const alternatives=[...US_BUSINESS_REGIONS,...Object.values(US_BUSINESS_STATE_NAMES),...provinces];
 return !alternatives.some(label=>fold(label)!==state&&adjacent(fold(label)));
}
