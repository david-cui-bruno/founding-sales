import { callTrialResponseSchema, instant } from '@fss/contracts';
import { readCallTrial } from '@fss/domain/calls/trialReport.ts';
import { readCallingProvider } from '@fss/domain/settings/integrations.ts';
import { REFUSAL_STATUS, redactError } from '../limits.ts';
import { policyRouteDeps } from './dialSupport.ts';
import { contextForPrincipal } from './routeSupport.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * `GET /calls/trial?since=<ISO instant>` (slice S3T): the 10-call shadow trial — which calls
 * count, which are excluded and why, what happened to each counted call's analysis, and the
 * per-type decisions (`calls/trialReport.ts`). A read; `since` defaults to the 3a release.
 * Gated as the acceptance read beside it is: 404 unless the workspace's `calling_provider` is
 * `twilio`. A salesperson is read their own firms' calls, an administrator the workspace's.
 */

export const CALL_TRIAL_PATHS: readonly string[] = ['/calls/trial'];

export async function routeCallTrial(request: ApiRequest, options: RoutingOptions): Promise<RouteResult | null> {
  if (!CALL_TRIAL_PATHS.includes(request.path)) return null;
  const prepared = await policyRouteDeps(request, options);
  if (!prepared.ok) return prepared.result;
  if (request.method !== 'GET') return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
  const scoped = contextForPrincipal(prepared.deps.auth, prepared.deps.principal);
  if (!scoped.ok) return scoped.result;
  if ((await readCallingProvider(scoped.context)) !== 'twilio') {
    return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
  }
  const since = request.query.get('since');
  if (since !== null && !instant.safeParse(since).success) return { status: REFUSAL_STATUS.malformed_body, body: redactError('malformed_body') };
  return { status: 200, body: callTrialResponseSchema.parse(await readCallTrial(scoped.context, { since: since ?? undefined })) };
}
