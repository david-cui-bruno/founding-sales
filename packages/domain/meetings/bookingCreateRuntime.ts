import type {BookingPolicyRuntime,BookingPolicySnapshot} from './bookingPolicyTypes.ts';
import type {BookingCreateProvider} from './bookingCreateProvider.ts';
/** Trusted configured adapter contract, never caller-supplied prices or permission. */
export interface BookingCreateCostContract {
 readonly accountId:string;readonly eventTypeId:number;
 readonly operationScope:'availability_create_inspection';
 readonly maximumCents:number;readonly verifiedAt:string;readonly validUntil:string;
 readonly reference:string;
}
export interface BookingCreateRuntime {
 readonly policy:BookingPolicyRuntime;
 readonly provider:BookingCreateProvider;
 readCostContract(snapshot:BookingPolicySnapshot):Promise<BookingCreateCostContract|null>;
}
export async function bookingCreateCostReason(runtime:BookingCreateRuntime,snapshot:BookingPolicySnapshot):Promise<string|null>{
 return bookingCreateCostContractReason(await runtime.readCostContract(snapshot),snapshot,runtime.policy.now());
}
export function bookingCreateCostContractReason(contract:BookingCreateCostContract|null,snapshot:BookingPolicySnapshot,at:string):string|null{
 const now=Date.parse(at);
 if(!Number.isFinite(now)||contract===null||contract.accountId!==snapshot.bindings.account.accountId||contract.eventTypeId!==snapshot.bindings.event.eventTypeId||contract.operationScope!=='availability_create_inspection'||contract.reference.length===0||!Number.isSafeInteger(contract.maximumCents)||contract.maximumCents<0||!Number.isFinite(Date.parse(contract.verifiedAt))||Date.parse(contract.verifiedAt)>now||Date.parse(contract.validUntil)<=now||!Number.isFinite(Date.parse(contract.validUntil)))return 'unknown_cost';
 return contract.maximumCents===0?null:'unsupported_provider_cost';
}
