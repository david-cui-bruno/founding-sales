import { bookingInterpretationReadSchema, bookingInterpretationRequestSchema } from '@fss/contracts';
import { readBookingInterpretation, requestBookingInterpretation } from '@fss/domain/crm/bookingInterpretation.ts';
import { withTransaction } from '@fss/domain/db/queryable.ts';
import { contextForPrincipal, requirePrincipal, runRouteCommand } from './routeSupport.ts';
import { redactError } from '../limits.ts';
import type { ApiRequest, RoutingOptions, RouteResult } from './types.ts';
export const BOOKING_INTERPRETATION_PATHS = ['/crm/booking/interpretation/request', '/crm/booking/interpretation/read'] as const;
export async function routeBookingInterpretation(request: ApiRequest, options: RoutingOptions): Promise<RouteResult | null> {
  if (!(BOOKING_INTERPRETATION_PATHS as readonly string[]).includes(request.path)) return null;
  if (!options.auth) return { status: 401, body: redactError('unauthenticated') };
  const verified = await requirePrincipal(options.auth, request);
  if (!verified.ok) return verified.result;
  const scoped = contextForPrincipal(options.auth, verified.principal);
  if (!scoped.ok) return scoped.result;
  if (request.method !== 'POST') return { status: 405, body: redactError('method_not_allowed') };
  if (request.path === '/crm/booking/interpretation/request') return runRouteCommand(
    { auth: options.auth, request, principal: verified.principal }, bookingInterpretationRequestSchema,
    'crm.booking_interpretation_requested', (context, body) => requestBookingInterpretation(context, body));
  const parsed = bookingInterpretationReadSchema.safeParse(request.body);
  if (!parsed.success) return { status: 400, body: redactError('malformed_body') };
  const result = await withTransaction(options.auth.db, () => readBookingInterpretation(scoped.context, parsed.data));
  return result === null ? { status: 404, body: redactError('not_found') } : { status: 200, body: result };
}
