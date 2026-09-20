import { searchRequestSchema, type SearchFiltersInput } from '@fss/contracts';
import { searchFirms, type SearchFilters } from '@fss/domain/crm';
import { REFUSAL_STATUS, contextForPrincipal, redactError, requirePrincipal } from './crmSupport.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * CRM search (specification 7.2, 14.1, Appendix F).
 *
 * `POST /search/firms`, and the POST is the point: a search term is a prospect's
 * name, address or telephone number, and a query string is written to the load
 * balancer's access log on the way in, where no amount of response redaction can
 * reach it. Every other named field this API takes travels in a JSON body and so
 * does this one.
 *
 * The route is four lines of work — authenticate, parse, call, reply — because the
 * two decisions worth making are both in `@fss/domain/crm/search.ts`: which fields a
 * term may be matched against for this caller, and which DTO each hit becomes. A
 * route that decided either would be a second copy of Appendix F.
 *
 * Not a command: nothing is written, so there is no receipt, no command id and no
 * client-version gate. An outdated client may read (5.3); it may not mutate.
 */

export const SEARCH_PATHS = ['/search/firms'] as const;

/** The wire filter shape, as the domain wants it. Instants parse here, once. */
export function domainFilters(filters: SearchFiltersInput | undefined): SearchFilters | undefined {
  if (filters === undefined) return undefined;
  return {
    ...(filters.owner === undefined
      ? {}
      : {
          owner: {
            ...(filters.owner.userId === undefined ? {} : { userId: filters.owner.userId }),
            ...(filters.owner.unassigned === undefined ? {} : { unassigned: filters.owner.unassigned }),
          },
        }),
    ...(filters.stageKey === undefined ? {} : { stageKey: filters.stageKey }),
    ...(filters.sequenceStatus === undefined ? {} : { sequenceStatus: filters.sequenceStatus }),
    ...(filters.holdReasonCode === undefined ? {} : { holdReasonCode: filters.holdReasonCode }),
    ...(filters.routeEligibility === undefined ? {} : { routeEligibility: filters.routeEligibility }),
    ...(filters.activeSince === undefined ? {} : { activeSince: new Date(filters.activeSince) }),
    ...(filters.activeUntil === undefined ? {} : { activeUntil: new Date(filters.activeUntil) }),
  };
}

export async function routeSearch(request: ApiRequest, options: RoutingOptions): Promise<RouteResult | null> {
  if (!(SEARCH_PATHS as readonly string[]).includes(request.path)) return null;
  const auth = options.auth;
  if (auth === undefined) return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
  if (request.method !== 'POST') {
    return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
  }

  const authenticated = await requirePrincipal(auth, request);
  if (!authenticated.ok) return authenticated.result;
  const scoped = contextForPrincipal(auth, authenticated.principal);
  if (!scoped.ok) return scoped.result;

  const parsed = searchRequestSchema.safeParse(request.body);
  if (!parsed.success) return { status: REFUSAL_STATUS.malformed_body, body: redactError('malformed_body') };

  const filters = domainFilters(parsed.data.filters);
  const found = await searchFirms(scoped.context, {
    ...(parsed.data.term === undefined ? {} : { term: parsed.data.term }),
    ...(filters === undefined ? {} : { filters }),
    ...(parsed.data.limit === undefined ? {} : { limit: parsed.data.limit }),
  });
  // 409 for a refusal, as everywhere else in the CRM: the request was well formed
  // and the state of the world — an unknown stage, an impossible owner filter — is
  // what refused it.
  if (!found.ok) return { status: 409, body: { status: 'refused', reason: found.reason } };
  return { status: 200, body: found.value };
}
