import type {BookingPolicyRuntime,BookingPolicySnapshot} from './bookingPolicyTypes.ts';
import type {BookingCreateAvailability,BookingCreateEvidence} from './bookingCreateProvider.ts';
export interface BookingChangeCall {
 readonly submissionId:string;readonly action:'reschedule'|'cancel';readonly bookingUid:string;
 readonly accountId:number;readonly eventTypeId:number;readonly organizerEmail:string;readonly attendeeEmail:string;
 readonly originalStartsAt:string;readonly originalEndsAt:string;
 readonly startsAt:string|null;readonly timeZone:string|null;
}
export interface BookingChangeEvidence extends BookingCreateEvidence {
 readonly previousUid:string;
 readonly action:'reschedule'|'cancel';
 /** Verified provider reminder configuration/transition, not a Callie reminder. */
 readonly reminderState:'replaced'|'stopped';
}
export type BookingChangeObservation={readonly state:'accepted';readonly booking:BookingChangeEvidence}|{readonly state:'failed'|'pending'|'unknown';readonly reason:string};
export interface BookingChangeTarget extends Omit<BookingCreateEvidence,'submissionId'> {readonly status:'accepted'|'cancelled'|'unsupported'}
export interface BookingChangeProvider {
 readTarget(input:BookingChangeCall):Promise<BookingChangeTarget|null>;
 availability(input:BookingCreateAvailability&{readonly excludeBookingUid:string}):Promise<{readonly available:boolean;readonly reason:string|null}>;
 change(input:BookingChangeCall):Promise<BookingChangeObservation>;
 inspect(input:BookingChangeCall):Promise<BookingChangeObservation>;
}
export interface BookingChangeCostContract {
 readonly accountId:string;readonly eventTypeId:number;readonly operationScope:'availability_reschedule_cancel_inspection';
 readonly maximumCents:number;readonly verifiedAt:string;readonly validUntil:string;readonly reference:string;
}
export interface BookingChangeRuntime {
 readonly policy:BookingPolicyRuntime;readonly provider:BookingChangeProvider;
 readCostContract(snapshot:BookingPolicySnapshot):Promise<BookingChangeCostContract|null>;
}
export function bookingChangeCostReason(contract:BookingChangeCostContract|null,snapshot:BookingPolicySnapshot,now:string):string|null {
 const time=Date.parse(now);
 if(contract===null||contract.accountId!==snapshot.bindings.account.accountId||contract.eventTypeId!==snapshot.bindings.event.eventTypeId||contract.operationScope!=='availability_reschedule_cancel_inspection'||!contract.reference||!Number.isSafeInteger(contract.maximumCents)||contract.maximumCents<0||!Number.isFinite(Date.parse(contract.verifiedAt))||Date.parse(contract.verifiedAt)>time||!Number.isFinite(Date.parse(contract.validUntil))||Date.parse(contract.validUntil)<=time)return 'unknown_cost';
 return contract.maximumCents===0?null:'unsupported_provider_cost';
}
