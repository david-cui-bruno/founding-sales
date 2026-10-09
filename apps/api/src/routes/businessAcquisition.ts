import { businessPolicyReadSchema, businessPolicySaveSchema, businessReviewReadSchema, businessReviewDecideSchema } from '@fss/contracts';
import { readBusinessPolicy, saveBusinessPolicy, readBusinessReview, decideBusinessReview } from '@fss/domain/business/acquisition.ts';
import { withTransaction } from '@fss/domain/db/queryable.ts';
import { contextForPrincipal, requirePrincipal, runRouteCommand } from './routeSupport.ts';
import { redactError } from '../limits.ts';
import type { ApiRequest, RoutingOptions, RouteResult } from './types.ts';
export const BUSINESS_PATHS = ['/crm/business/policy/read', '/crm/business/policy/save', '/crm/business/review/read', '/crm/business/review/decide'] as const;
export async function routeBusinessAcquisition(request: ApiRequest, options: RoutingOptions): Promise<RouteResult | null> {
  if (!(BUSINESS_PATHS as readonly string[]).includes(request.path))
    return null;
  if (options.auth === undefined)
    return { status: 401, body: redactError('unauthenticated') };
  const verified = await requirePrincipal(options.auth, request);
  if (!verified.ok)
    return verified.result;
  const scoped = contextForPrincipal(options.auth, verified.principal);
  if (!scoped.ok)
    return scoped.result;
  if (request.method !== 'POST')
    return { status: 405, body: redactError('method_not_allowed') };
  if (request.path === '/crm/business/review/decide')
    return runRouteCommand({ auth: options.auth, request, principal: verified.principal }, businessReviewDecideSchema, 'crm.business_review_decided', (context, body) => decideBusinessReview(context, body));
  if (request.path === '/crm/business/policy/save')
    return runRouteCommand({ auth: options.auth, request, principal: verified.principal }, businessPolicySaveSchema, 'crm.business_policy_saved', (context, body) => saveBusinessPolicy(context, body));
  if (request.path === '/crm/business/review/read') {
    const parsed = businessReviewReadSchema.safeParse(request.body);
    if (!parsed.success)
      return { status: 400, body: redactError('malformed_body') };
    const review = await withTransaction(options.auth.db, () => readBusinessReview(scoped.context, parsed.data));
    return review === null ? { status: 404, body: redactError('not_found') } : { status: 200, body: review };
  }
  const parsed = businessPolicyReadSchema.safeParse(request.body);
  if (!parsed.success)
    return { status: 400, body: redactError('malformed_body') };
  const policy = await withTransaction(options.auth.db, () => readBusinessPolicy(scoped.context, parsed.data.mailboxId));
  return policy === null ? { status: 404, body: redactError('not_found') } : { status: 200, body: policy };
}
