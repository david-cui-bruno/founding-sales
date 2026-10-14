import { bookingInterpretationReadSchema, bookingInterpretationRequestSchema } from '@fss/contracts';
import { readBookingInterpretationObservation, requestBookingInterpretation } from '@fss/domain/crm/bookingInterpretation.ts';
import {bookingPolicySnapshotReadyAt} from '@fss/domain/meetings/bookingPolicy.ts';
import { withTransaction } from '@fss/domain/db/queryable.ts';
import { contextForPrincipal, requirePrincipal, runRouteCommand } from './routeSupport.ts';
import { redactError } from '../limits.ts';
import type { ApiRequest, RoutingOptions, RouteResult } from './types.ts';
export const BOOKING_INTERPRETATION_PATHS = ['/crm/booking/interpretation/request', '/crm/booking/interpretation/read'] as const;
class BookingInterpretationAdmissionLost extends Error {}
export async function routeBookingInterpretation(request: ApiRequest, options: RoutingOptions): Promise<RouteResult | null> {
  if (!(BOOKING_INTERPRETATION_PATHS as readonly string[]).includes(request.path)) return null;
  if (!options.auth) return { status: 401, body: redactError('unauthenticated') };
  const verified = await requirePrincipal(options.auth, request);
  if (!verified.ok) return verified.result;
  const scoped = contextForPrincipal(options.auth, verified.principal);
  if (!scoped.ok) return scoped.result;
  if (request.method !== 'POST') return { status: 405, body: redactError('method_not_allowed') };
  const authorize=async()=>{
    const current=await requirePrincipal(options.auth!,request);
    return current.ok&&current.principal.workspaceId===verified.principal.workspaceId&&current.principal.userId===verified.principal.userId&&current.principal.sessionId===verified.principal.sessionId&&current.principal.deviceId===verified.principal.deviceId&&current.principal.role===verified.principal.role;
  };
  if (request.path === '/crm/booking/interpretation/request') {
   let receipt:RouteResult;
   try{receipt=await runRouteCommand(
    { auth: options.auth, request, principal: verified.principal }, bookingInterpretationRequestSchema,
    'crm.booking_interpretation_requested', (context, body) => requestBookingInterpretation(context, body,options.bookingInterpretationAuthority,async()=>{
      // Throw only for this admission loss so the ordinary command transaction
      // rolls back without even a receipt for an unauthorized request.
      if(!await authorize())throw new BookingInterpretationAdmissionLost();
      return true;
    }));}
   catch(error){if(error instanceof BookingInterpretationAdmissionLost)return {status:404,body:redactError('not_found')};throw error;}
   if(receipt.status!==200)return receipt;
   const body=receipt.body as {status:unknown;replayed:unknown;result?:{requestId?:unknown}};
   const reference=bookingInterpretationReadSchema.safeParse({requestId:body.result?.requestId});
   if(!reference.success)return {status:404,body:redactError('not_found')};
   const observed=await withTransaction(options.auth.db,()=>readBookingInterpretationObservation(scoped.context,reference.data,options.bookingInterpretationAuthority,authorize));
   if(!await authorize())return {status:404,body:redactError('not_found')};
   // This pure clock check is last, after COMMIT and final session waits.
   const result=observed.snapshot!==null&&!bookingPolicySnapshotReadyAt(observed.snapshot,new Date().toISOString())?null:observed.value;
   return result===null?{status:404,body:redactError('not_found')}:{status:200,body:{status:body.status,replayed:body.replayed,result}};
  }
  const parsed = bookingInterpretationReadSchema.safeParse(request.body);
  if (!parsed.success) return { status: 400, body: redactError('malformed_body') };
  const observed = await withTransaction(options.auth.db, () => readBookingInterpretationObservation(scoped.context, parsed.data,options.bookingInterpretationAuthority,authorize));
  if(!await authorize())return {status:404,body:redactError('not_found')};
  // Never renew the evidence grant merely to survive the response wait.
  const result=observed.snapshot!==null&&!bookingPolicySnapshotReadyAt(observed.snapshot,new Date().toISOString())?null:observed.value;
  return result === null ? { status: 404, body: redactError('not_found') } : { status: 200, body: result };
}
