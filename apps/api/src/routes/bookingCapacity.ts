import {bookingCapacityResponseSchema} from '@fss/contracts';
import {readBookingCapacity,type CalcomCapacityClient} from '@fss/domain/meetings/bookingCapacity.ts';
import {REFUSAL_STATUS,redactError} from '../limits.ts';
import {contextForPrincipal,requirePrincipal} from './routeSupport.ts';
import type {ApiRequest,RouteResult,RoutingOptions} from './types.ts';
export const BOOKING_CAPACITY_PATHS:readonly string[]=['/meetings/booking-capacity'];
export interface BookingCapacityDeps {readonly client:CalcomCapacityClient|null;readonly missingKeyReason?:'api_key_missing'|'api_key_invalid'}
/** Authenticated, read-only provider configuration evidence plus existing retained bookings. */
export async function routeBookingCapacity(request:ApiRequest,options:RoutingOptions&{bookingCapacity?:BookingCapacityDeps}):Promise<RouteResult|null> {
  if(!BOOKING_CAPACITY_PATHS.includes(request.path))return null;
  if(options.auth===undefined)return {status:REFUSAL_STATUS.not_found,body:redactError('not_found')};
  if(request.method!=='GET')return {status:REFUSAL_STATUS.method_not_allowed,body:redactError('method_not_allowed')};
  const principal=await requirePrincipal(options.auth,request);if(!principal.ok)return principal.result;
  const scoped=contextForPrincipal(options.auth,principal.principal);if(!scoped.ok)return scoped.result;
  const capacity=await readBookingCapacity(scoped.context,{...options.bookingCapacity,client:options.bookingCapacity?.client??null,now:new Date().toISOString()});
  return {status:200,body:bookingCapacityResponseSchema.parse(capacity)};
}
