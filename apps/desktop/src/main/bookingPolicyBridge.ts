import {bookingPolicySettingsViewSchema,bookingPolicyChangedSchema,type BookingPolicyChange} from '@fss/contracts';
import type {AuthedClient} from './authedClient.ts';
export interface BookingPolicyBridgeDeps {api:AuthedClient;identity:{current():unknown}}
export async function readBookingPolicySettingsOperation(deps:BookingPolicyBridgeDeps) {
  const generation=deps.identity.current();
  const answer=await deps.api.read('/meetings/booking-policy?view=settings',value=>bookingPolicySettingsViewSchema.parse(value));
  return {view:generation===deps.identity.current()&&answer.ok?answer.value:null};
}
export async function changeBookingPolicySettingsOperation(deps:BookingPolicyBridgeDeps,input:BookingPolicyChange) {
  const generation=deps.identity.current(),{commandId,...body}=input;
  const answer=await deps.api.command('/meetings/booking-policy',body,value=>bookingPolicyChangedSchema.parse(value),{commandId});
  if(generation!==deps.identity.current())return {revision:null,reason:'session_changed'};
  return answer.ok?{revision:answer.value.revision,reason:null}:{revision:null,reason:answer.reason.slice(0,80)};
}
