import type {PluralFirmPageResponse} from '@fss/contracts';
export const CALLING_SOURCE_UNAVAILABLE='[source unavailable company]';
type Lease={callingPreparationExpiresAt?:string|undefined};
const expired=(value:Lease,now:number)=>value.callingPreparationExpiresAt!==undefined&&Date.parse(value.callingPreparationExpiresAt)<=now;
/** One known source deadline, no remote purge/caching service or new permission. */
export function callingPreparationDelay(values:readonly Lease[],now=Date.now()):number|null{
 const deadlines=values.flatMap(v=>v.callingPreparationExpiresAt?[Date.parse(v.callingPreparationExpiresAt)]:[]);return deadlines.length?Math.max(0,Math.min(...deadlines)-now):null;
}
export function expireCallingCompany<T extends Lease&{name:string}>(value:T,now=Date.now()):T{
 if(!expired(value,now))return value;
 const next={...value,name:CALLING_SOURCE_UNAVAILABLE,website:null,locality:null,regionCode:null,timeZone:null,timeZoneUnresolvedReason:null};delete next.callingPreparationExpiresAt;
 if('phoneRoutes'in value)Object.assign(next,{addressLine:null,postalCode:null,countryCode:'ZZ',timeZoneConfidence:null,timeZoneSource:null,phoneRoutes:[]});
 return next;
}
export function expireCallingPage(value:PluralFirmPageResponse,now=Date.now()):PluralFirmPageResponse{
 if(!expired(value.read.firm,now))return value;
 return value.read.visibility==='assigned_or_admin'?{...value,read:{visibility:value.read.visibility,firm:expireCallingCompany(value.read.firm,now)}}:{...value,read:{visibility:value.read.visibility,firm:expireCallingCompany(value.read.firm,now)}};
}
export function expireCallingCard<T extends Lease&{firmName:string}>(value:T,now=Date.now()):T{
 if(!expired(value,now))return value;const next={...value,firmName:CALLING_SOURCE_UNAVAILABLE};delete next.callingPreparationExpiresAt;return next;
}
export function expireCallingAction<T extends Lease&{subject:string;firms?:readonly (Lease&{name:string})[]|null|undefined}>(value:T,now=Date.now()):T{
 const next={...value,...(value.firms?{firms:value.firms.map(f=>expireCallingCompany(f,now))}:{}),subject:expired(value,now)?CALLING_SOURCE_UNAVAILABLE:value.subject};if(expired(value,now))delete next.callingPreparationExpiresAt;return next;
}
