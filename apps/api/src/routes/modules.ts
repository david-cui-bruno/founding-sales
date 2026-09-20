import { buildHealthReport } from '../health.ts';
import { REFUSAL_STATUS, redactError } from '../limits.ts';
import type { BootstrapRequest, BootstrapResponse, RouteModule } from '../bootstrap/routeRegistry.ts';
import { routeAuth } from './auth.ts';
import { routeAdminDevices } from './admin/devices.ts';
import { routeAdminMemberships } from './admin/memberships.ts';
import { routeContacts } from './contacts.ts';
import { EXPORT_PATHS, routeExport } from './export.ts';
import { FIRM_PAGE_PATHS, routeFirmPage } from './firmPage.ts';
import { routeFirms } from './firms.ts';
import { IMPORT_PATHS, routeImport } from './import.ts';
import { routeMerges } from './merges.ts';
import { routeOpportunities } from './opportunities.ts';
import { routePipeline } from './pipeline.ts';
import { RESEARCH_PATHS, routeResearch } from './research.ts';
// Lane G7's Gmail surface.
import { GMAIL_PATHS, routeGmail } from './gmail.ts';
import { PUBSUB_PATHS, routePubSub } from './pubsub.ts';
import { MESSAGE_PATHS, routeMessages } from './messages.ts';
// Lane G7b's reply cards and the classifier's configuration.
import { REPLY_PATHS, routeReplies } from './replies.ts';
import { SEARCH_PATHS, routeSearch } from './search.ts';
// Lane G4's policy, suppression and dialing surface.
import { CALLBACK_PATHS, routeCallbacks } from './callbacks.ts';
import { CALL_PATHS, routeCalls } from './calls.ts';
import { DIAL_PATHS, routeDial } from './dial.ts';
import { PAUSE_PATHS, routePauses } from './pauses.ts';
import { POSTURE_PATHS, routePostures } from './postures.ts';
import { SUPPRESSION_PATHS, routeSuppressions } from './suppressions.ts';
// Lane G6's Today list.
import { SNOOZE_PATHS, routeSnooze } from './snooze.ts';
import { TODAY_PATHS, routeToday } from './today.ts';
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
    // Lane G3b's CRM surface. Exact paths, which is what every new endpoint should
    // be: the prefixes above are a record of the routers that already existed in
    // that shape, not an invitation.
    moduleOf('firm-page', { paths: FIRM_PAGE_PATHS }, routeFirmPage, routing),
    moduleOf('search', { paths: SEARCH_PATHS }, routeSearch, routing),
    moduleOf('import', { paths: IMPORT_PATHS }, routeImport, routing),
    moduleOf('export', { paths: EXPORT_PATHS }, routeExport, routing),
    // Lane G4's policy, suppression and dialing surface. Exact paths throughout, for
    // the reason above. `/dial/authorize` and `/dial/consume` are declared separately
    // rather than as a `/dial` prefix because a mistyped dialing path must be
    // `not_found` and not an unauthorized call: the registry is the only thing that
    // can promise that, and only about the paths it was told.
    moduleOf('postures', { paths: POSTURE_PATHS }, routePostures, routing),
    moduleOf('suppressions', { paths: SUPPRESSION_PATHS }, routeSuppressions, routing),
    moduleOf('dial', { paths: DIAL_PATHS }, routeDial, routing),
    moduleOf('calls', { paths: CALL_PATHS }, routeCalls, routing),
    moduleOf('callbacks', { paths: CALLBACK_PATHS }, routeCallbacks, routing),
    moduleOf('pauses', { paths: PAUSE_PATHS }, routePauses, routing),
    // Lane G10's research surface: the admin configuration, the versioned route
    // thresholds with their history, the suggestion review queue and the two enqueue
    // commands. Exact paths, and deliberately not a `/research` prefix: an unknown
    // path under that root is a typo in a command an admin is about to spend money
    // with, and `not_found` from the registry says so before any module sees it.
    moduleOf('research', { paths: RESEARCH_PATHS }, routeResearch, routing),
    // Lane G7's Gmail surface. Exact paths again, and two of them are not this
    // lane's to choose: `/oauth/gmail/callback` is the redirect URI registered in
    // Google's console, and `/integrations/gmail/push` is both the Pub/Sub push
    // endpoint and the OIDC audience the subscription mints its token for
    // (`infra/modules/stack`, `gmail_push_path`). Renaming either without the other
    // is a consent screen that errors or a webhook that refuses everything.
    moduleOf('gmail', { paths: GMAIL_PATHS }, routeGmail, routing),
    moduleOf('gmail-push', { paths: PUBSUB_PATHS }, routePubSub, routing),
    moduleOf('messages', { paths: MESSAGE_PATHS }, routeMessages, routing),
    // Lane G7b's reply cards (8.3). Exact paths, and `/replies/settings` is
    // separate from `/replies/settings/update` for the reason the two snooze paths
    // are separate from `/today`: a read and a command under one prefix would let
    // one claim answer for both, and the registry can only promise about the paths
    // it was told.
    moduleOf('replies', { paths: REPLY_PATHS }, routeReplies, routing),
    // Lane G6's Today list. Exact paths, and two modules rather than one: the list
    // and the expansion are reads, the two snooze paths are commands with receipts,
    // and a `/today` prefix would have let one claim answer for both. The registry
    // refuses a prefix that swallows another module's exact path, so declaring
    // `/today` and `/today/snooze` separately is what keeps them separable at all.
    moduleOf('today', { paths: TODAY_PATHS }, routeToday, routing),
    moduleOf('snooze', { paths: SNOOZE_PATHS }, routeSnooze, routing),
  ];
}
