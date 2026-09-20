import { dashboardRequestSchema } from '@fss/contracts';
import { readDashboard } from '@fss/domain/dashboard';
import { REFUSAL_STATUS, contextForPrincipal, policyRouteDeps, redactError } from './dialSupport.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * The minimum performance dashboard (specification 13.4).
 *
 * A POST that is a read, in the family `docs/decisions/g3b-reads-are-posts.md`
 * describes. Here the reason is the body rather than the leak: the request is a
 * window with two instants in it, and a window a caller did not choose is a figure
 * two people compare and disagree about.
 *
 * The route chooses nothing. It does not take an audience from the request — which
 * firms the figures cover is decided in the domain from the scope, so a salesperson
 * cannot ask for the workspace and an admin cannot accidentally be narrowed. See
 * `docs/decisions/g9-dashboard-visibility.md`.
 *
 * `sources` is left at its default here, which reports the G7-2, G8 and G7b figures
 * as unavailable with the lane that owns each. When those lanes land, one line in
 * this file passes their implementation.
 */
export const DASHBOARD_PATHS: readonly string[] = ['/dashboard'];

export async function routeDashboard(request: ApiRequest, options: RoutingOptions): Promise<RouteResult | null> {
  if (!DASHBOARD_PATHS.includes(request.path)) return null;
  if (request.method !== 'POST') {
    const prepared = await policyRouteDeps(request, options);
    if (!prepared.ok) return prepared.result;
    return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
  }

  const prepared = await policyRouteDeps(request, options);
  if (!prepared.ok) return prepared.result;
  const parsed = dashboardRequestSchema.safeParse(request.body);
  if (!parsed.success) return { status: REFUSAL_STATUS.malformed_body, body: redactError('malformed_body') };

  const scoped = contextForPrincipal(prepared.deps.auth, prepared.deps.principal);
  if (!scoped.ok) return scoped.result;

  return { status: 200, body: await readDashboard(scoped.context, { window: parsed.data.window }) };
}
