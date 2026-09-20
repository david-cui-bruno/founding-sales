import { buildHealthReport } from '../health.ts';
import { REFUSAL_STATUS, redactError } from '../limits.ts';
import type { BootstrapRequest, BootstrapResponse, RouteModule } from '../bootstrap/routeRegistry.ts';
import { routeAuth } from './auth.ts';
import { routeAdminDevices } from './admin/devices.ts';
import { routeAdminMemberships } from './admin/memberships.ts';
import { routeContacts } from './contacts.ts';
import { routeFirms } from './firms.ts';
import { routeMerges } from './merges.ts';
import { routeOpportunities } from './opportunities.ts';
import { routePipeline } from './pipeline.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * Every route this API serves, as registry modules.
 *
 * G0 chose one handler and no framework, and G5b turned "which endpoints does this
 * process serve" into a list that is read rather than inferred from a chain of
 * imports (`apps/api/src/bootstrap/routeRegistry.ts`). Until this lane, G2's and
 * G3a's routers were a `for` loop in `server.ts` that asked each module in turn
 * whether the path was its own — which is exactly the fall-through the registry
 * exists to prevent: a module that forgets its guard answers for somebody else's
 * path, and the one with the authorization in it may be the one that never runs.
 *
 * So each router is declared here with the paths it owns. Two are exact. The rest
 * are prefixes, for the routers that already answer `not_found` for the unknown
 * paths under their own root — and `routeFirms` additionally reads
 * `GET /firms/<uuid>`, whose last segment is an identifier and cannot be
 * enumerated. The registry refuses a prefix that overlaps another module's claim,
 * so the guarantee is the one an exact path gives.
 *
 * The adapter is the only thing in this file with any behaviour: a `RouteResult`
 * may name a content type — the Google OAuth callback serves an HTML page a person
 * reads in their browser — and a `BootstrapResponse` carries it through.
 */

type Router = (request: ApiRequest, options: RoutingOptions) => Promise<RouteResult | null>;

function asApiRequest(request: BootstrapRequest): ApiRequest {
  return {
    method: request.method,
    path: request.path,
    query: request.query ?? new URLSearchParams(),
    headers: request.headers,
    body: request.body,
  };
}

function asBootstrapResponse(result: RouteResult): BootstrapResponse {
  return {
    status: result.status,
    body: result.body,
    ...(result.contentType === undefined ? {} : { contentType: result.contentType }),
  };
}

function moduleOf(
  name: string,
  claim: { readonly paths?: readonly string[]; readonly prefixes?: readonly string[] },
  router: Router,
  routing: RoutingOptions,
): RouteModule {
  return {
    name,
    paths: claim.paths ?? [],
    ...(claim.prefixes === undefined ? {} : { prefixes: claim.prefixes }),
    handle: async (request): Promise<BootstrapResponse | null> => {
      const result = await router(asApiRequest(request), routing);
      return result === null ? null : asBootstrapResponse(result);
    },
  };
}

/**
 * `/health` is the operator's fuller report and answers 200 even when degraded
 * (`docs/decisions/g5b-process-shape.md`). It is deliberately not `/readyz`, which
 * the load balancer asks and which fails closed.
 */
function healthModule(routing: RoutingOptions): RouteModule {
  return {
    name: 'health',
    paths: ['/health'],
    handle: async (request): Promise<BootstrapResponse | null> => {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
      }
      return { status: 200, body: await buildHealthReport(routing) };
    },
  };
}

/** Everything `server.ts` mounts beside the bootstrap's own readiness and job routes. */
export function apiRouteModules(routing: RoutingOptions): readonly RouteModule[] {
  return [
    healthModule(routing),
    moduleOf('auth', { prefixes: ['/auth'] }, routeAuth, routing),
    moduleOf('admin-memberships', { prefixes: ['/admin/memberships'] }, routeAdminMemberships, routing),
    moduleOf('admin-devices', { prefixes: ['/admin/devices'] }, routeAdminDevices, routing),
    moduleOf('firms', { prefixes: ['/firms'] }, routeFirms, routing),
    moduleOf('contacts', { prefixes: ['/contacts'] }, routeContacts, routing),
    moduleOf('opportunities', { prefixes: ['/opportunities'] }, routeOpportunities, routing),
    moduleOf('pipeline', { paths: ['/pipeline/stages'] }, routePipeline, routing),
    moduleOf('merges', { prefixes: ['/merges'] }, routeMerges, routing),
  ];
}
