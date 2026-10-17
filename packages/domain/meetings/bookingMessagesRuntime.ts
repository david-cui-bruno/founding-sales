import type {RepositoryContext} from '../db/workspaceScope.ts';
import type {OutboundSendDeps} from '../outbound/send.ts';
import type {BookingPolicyRuntime,BookingPolicySnapshot} from './bookingPolicyTypes.ts';
import type {BookingConversationRuntime} from './bookingConversation.ts';
/** Already observed normal configured sender capability. Never a caller permission bit. */
export interface BookingMessageSenderObservation {
 readonly mailboxId:string;readonly accountBinding:string;readonly generation:number;
 readonly authorityRevision:string;readonly verifiedAt:string;readonly validUntil:string;
 readonly maximumCents:0;readonly reference:string;
}
export interface BookingMessageRuntime {
 readonly policy:BookingPolicyRuntime;
 readonly conversation:BookingConversationRuntime;
 readonly send:OutboundSendDeps;
 readSender(context:RepositoryContext,snapshot:BookingPolicySnapshot):Promise<BookingMessageSenderObservation|null>;
}
export function bookingMessageSenderCurrent(observation:BookingMessageSenderObservation|null,snapshot:BookingPolicySnapshot,at:string):boolean {
 const now=Date.parse(at);
 return observation!==null&&Number.isFinite(now)&&observation.accountBinding===snapshot.bindings.sender.accountId&&snapshot.bindings.sender.channel==='email'&&observation.authorityRevision===snapshot.bindings.sender.authorityRevision&&observation.maximumCents===0&&observation.reference.length>0&&Number.isInteger(observation.generation)&&observation.generation>0&&Number.isFinite(Date.parse(observation.verifiedAt))&&Date.parse(observation.verifiedAt)<=now&&Number.isFinite(Date.parse(observation.validUntil))&&now<Date.parse(observation.validUntil);
}
