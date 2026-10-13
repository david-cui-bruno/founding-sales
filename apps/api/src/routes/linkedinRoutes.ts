import { linkedinRouteAssessSchema } from '@fss/contracts';
import { assessLinkedinRoute } from '@fss/domain/crm/linkedinRoutes.ts';
import { withTransaction } from '@fss/domain/db/queryable.ts';
import { contextForPrincipal, requirePrincipal } from './routeSupport.ts';
import { redactError } from '../limits.ts';
import type { ApiRequest, RoutingOptions, RouteResult } from './types.ts';
export const LINKEDIN_ROUTE_PATHS = ['/crm/linkedin/routes/assess'] as const;
export async function routeLinkedinRoutes(request: ApiRequest, options: RoutingOptions): Promise<RouteResult | null> {
  if (!(LINKEDIN_ROUTE_PATHS as readonly string[]).includes(request.path)) return null;
  if (options.auth === undefined) return { status: 401, body: redactError('unauthenticated') };
  const verified = await requirePrincipal(options.auth, request);
  if (!verified.ok) return verified.result;
  const scoped = contextForPrincipal(options.auth, verified.principal);
  if (!scoped.ok) return scoped.result;
  if (request.method !== 'POST') return { status: 405, body: redactError('method_not_allowed') };
  const parsed = linkedinRouteAssessSchema.safeParse(request.body);
  if (!parsed.success) return { status: 400, body: redactError('malformed_body') };
  const answer = await withTransaction(options.auth.db, () => assessLinkedinRoute(scoped.context, parsed.data));
  return answer === null ? { status: 404, body: redactError('not_found') } : { status: 200, body: answer };
}
