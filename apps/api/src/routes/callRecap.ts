import { callRecapResponseSchema } from '@fss/contracts';
import { readDailyRecap } from '@fss/domain/calls/recap.ts';
import { readCallingProvider } from '@fss/domain/settings/integrations.ts';
import { REFUSAL_STATUS, redactError } from '../limits.ts';
import { policyRouteDeps } from './dialSupport.ts';
import { contextForPrincipal } from './routeSupport.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * `GET /calls/recap?date=YYYY-MM-DD` (slice 3a, lane C): the day's analysed calls, what
 * recurs in them, and one coaching observation. A read with no table behind it; 404 unless
 * the workspace's `calling_provider` is `twilio`, like the analysis it summarises. `date` is
 * a business date and defaults to today's.
 */

export const CALL_RECAP_PATHS: readonly string[] = ['/calls/recap'];

export async function routeCallRecap(request: ApiRequest, options: RoutingOptions): Promise<RouteResult | null> {
  if (!CALL_RECAP_PATHS.includes(request.path)) return null;
  const prepared = await policyRouteDeps(request, options);
  if (!prepared.ok) return prepared.result;
  if (request.method !== 'GET') return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
  const scoped = contextForPrincipal(prepared.deps.auth, prepared.deps.principal);
  if (!scoped.ok) return scoped.result;
  if ((await readCallingProvider(scoped.context)) !== 'twilio') {
    return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
  }
  const date = request.query.get('date');
  if (date !== null && !/^\d{4}-\d{2}-\d{2}$/u.test(date)) return { status: REFUSAL_STATUS.malformed_body, body: redactError('malformed_body') };
  return { status: 200, body: callRecapResponseSchema.parse(await readDailyRecap(scoped.context, { date: date ?? undefined })) };
}
