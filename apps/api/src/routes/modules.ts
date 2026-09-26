import { buildHealthReport } from '../health.ts';
import { REFUSAL_STATUS, redactError } from '../limits.ts';
import type { BootstrapRequest, BootstrapResponse, RouteModule } from '../bootstrap/routeRegistry.ts';
import { ADD_FIRM_PATHS, routeAddFirm } from './addFirm.ts';
import { routeAuth } from './auth.ts';
import { routeContacts } from './contacts.ts';
import { FIRM_PAGE_PATHS, routeFirmPage } from './firmPage.ts';
import { routeFirms } from './firms.ts';
import { IMPORT_PATHS, routeImport } from './import.ts';
import { routeMerges } from './merges.ts';
import { routeOpportunities } from './opportunities.ts';
import { PIPELINE_PATHS, routePipeline } from './pipeline.ts';
// The Gmail surface.
import { GMAIL_PATHS, routeGmail } from './gmail.ts';
import { PUBSUB_PATHS, routePubSub } from './pubsub.ts';
import { MESSAGE_PATHS, routeMessages } from './messages.ts';
import { OUTBOUND_PATHS, routeOutbound } from './outbound.ts';
// The reply cards and the classifier's configuration.
import { REPLY_PATHS, routeReplies } from './replies.ts';
// The policy, suppression and dialing surface.
import { CALLBACK_PATHS, routeCallbacks } from './callbacks.ts';
import { CALL_PATHS, routeCalls } from './calls.ts';
import { DIAL_PATHS, routeDial } from './dial.ts';
// The calling numbers: the identity a dial is placed from.
import { CALLING_IDENTITY_PATHS, routeCallingIdentities } from './callingIdentities.ts';
import { PAUSE_PATHS, routePauses } from './pauses.ts';
import { POSTURE_PATHS, routePostures } from './postures.ts';
import { SUPPRESSION_PATHS, routeSuppressions } from './suppressions.ts';
// Sequences, templates and enrollments.
import { ENROLLMENT_PATHS, routeEnrollments } from './enrollments.ts';
import { SEQUENCE_PATHS, routeSequences } from './sequences.ts';
import { TEMPLATE_PATHS, routeTemplates } from './templates.ts';
// Administration, the dashboard and Diagnostics.
import { DASHBOARD_PATHS, routeDashboard } from './dashboard.ts';
import { DIAGNOSTICS_PATHS, routeDiagnostics } from './diagnostics.ts';
import { SETTINGS_PATHS, routeSettings } from './settings.ts';
// The Today list.
import { SNOOZE_PATHS, routeSnooze } from './snooze.ts';
import { TODAY_PATHS, routeToday } from './today.ts';
// The deletion requests and the attachment link.
import { RETENTION_PATHS, routeRetention } from './retention.ts';
import { ATTACHMENT_PATHS, routeAttachments } from './retentionAttachments.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * Every route this API serves, as registry modules.
 *
 * One handler and no framework: "which endpoints does this process serve" is a list
 * that is read rather than inferred from a chain of imports
 * (`apps/api/src/bootstrap/routeRegistry.ts`), so no module can fall through and
 * answer for somebody else's path.
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
    moduleOf('firms', { prefixes: ['/firms'] }, routeFirms, routing),
    moduleOf('contacts', { prefixes: ['/contacts'] }, routeContacts, routing),
    moduleOf('opportunities', { prefixes: ['/opportunities'] }, routeOpportunities, routing),
    moduleOf('pipeline', { paths: PIPELINE_PATHS }, routePipeline, routing),
    moduleOf('merges', { prefixes: ['/merges'] }, routeMerges, routing),
    // The CRM surface. Exact paths, which is what every new endpoint should be: the
    // prefixes above are a record of the routers that already existed in that shape,
    // not an invitation.
    moduleOf('firm-page', { paths: FIRM_PAGE_PATHS }, routeFirmPage, routing),
    moduleOf('import', { paths: IMPORT_PATHS }, routeImport, routing),
    // The Add firm form: one row of an import, typed. Exact, like its neighbours.
    moduleOf('add-firm', { paths: ADD_FIRM_PATHS }, routeAddFirm, routing),
    // The policy, suppression and dialing surface. Exact paths throughout, for
    // the reason above. `/dial/authorize` and `/dial/consume` are declared separately
    // rather than as a `/dial` prefix because a mistyped dialing path must be
    // `not_found` and not an unauthorized call: the registry is the only thing that
    // can promise that, and only about the paths it was told.
    moduleOf('postures', { paths: POSTURE_PATHS }, routePostures, routing),
    moduleOf('suppressions', { paths: SUPPRESSION_PATHS }, routeSuppressions, routing),
    moduleOf('dial', { paths: DIAL_PATHS }, routeDial, routing),
    moduleOf('calling-identities', { paths: CALLING_IDENTITY_PATHS }, routeCallingIdentities, routing),
    moduleOf('calls', { paths: CALL_PATHS }, routeCalls, routing),
    moduleOf('callbacks', { paths: CALLBACK_PATHS }, routeCallbacks, routing),
    moduleOf('pauses', { paths: PAUSE_PATHS }, routePauses, routing),
    // The Gmail surface. Exact paths again, and two of them are not ours to choose: `/oauth/gmail/callback` is the redirect URI registered in
    // Google's console, and `/integrations/gmail/push` is both the Pub/Sub push
    // endpoint and the OIDC audience the subscription mints its token for
    // (`infra/modules/stack`, `gmail_push_path`). Renaming either without the other
    // is a consent screen that errors or a webhook that refuses everything.
    moduleOf('gmail', { paths: GMAIL_PATHS }, routeGmail, routing),
    moduleOf('gmail-push', { paths: PUBSUB_PATHS }, routePubSub, routing),
    moduleOf('messages', { paths: MESSAGE_PATHS }, routeMessages, routing),
    // The reply cards (8.3). Exact paths, and `/replies/settings` is
    // separate from `/replies/settings/update` for the reason the two snooze paths
    // are separate from `/today`: a read and a command under one prefix would let
    // one claim answer for both, and the registry can only promise about the paths
    // it was told.
    moduleOf('replies', { paths: REPLY_PATHS }, routeReplies, routing),
    // The four outbound admin surfaces. Exact paths, and not an `/outbound` prefix:
    // an unknown path under that root is a typo in a command that marks a send
    // delivered or opens the sending gate, and `not_found` from the registry says so
    // before any module sees it.
    moduleOf('outbound', { paths: OUTBOUND_PATHS }, routeOutbound, routing),
    // The Today list. Exact paths, and two modules rather than one: the list
    // and the expansion are reads, the two snooze paths are commands with receipts,
    // and a `/today` prefix would have let one claim answer for both. The registry
    // refuses a prefix that swallows another module's exact path, so declaring
    // `/today` and `/today/snooze` separately is what keeps them separable at all.
    moduleOf('today', { paths: TODAY_PATHS }, routeToday, routing),
    moduleOf('snooze', { paths: SNOOZE_PATHS }, routeSnooze, routing),
    // Sequences, templates and enrollments. Exact paths again, and three
    // modules rather than one: `/sequences` publishes the plan, `/templates`
    // approves the bytes that may be sent, and `/enrollments` is the only family a
    // salesperson rather than an admin calls. A single `/sequences` prefix would
    // have let the plan editor answer for an enrollment path, and the registry is the
    // only thing that can promise it does not.
    moduleOf('sequences', { paths: SEQUENCE_PATHS }, routeSequences, routing),
    moduleOf('templates', { paths: TEMPLATE_PATHS }, routeTemplates, routing),
    moduleOf('enrollments', { paths: ENROLLMENT_PATHS }, routeEnrollments, routing),
    // The administration surface. Exact paths, and three modules rather than one:
    // settings is a read and a command family, the dashboard is one aggregate read and
    // Diagnostics is an operational read with its own visibility rule. A single
    // `/admin` prefix would have swallowed the job and alert paths, which the registry
    // refuses outright.
    moduleOf('settings', { paths: SETTINGS_PATHS }, routeSettings, routing),
    moduleOf('dashboard', { paths: DASHBOARD_PATHS }, routeDashboard, routing),
    moduleOf('diagnostics', { paths: DIAGNOSTICS_PATHS }, routeDiagnostics, routing),
    // Exact paths: the deletion pair, and the attachment link, the one read
    // in the system that hands out a Gmail URL. An unknown path near a command that
    // deletes prospect data must be `not_found` before any module sees it.
    moduleOf('retention', { paths: RETENTION_PATHS }, routeRetention, routing),
    moduleOf('attachments', { paths: ATTACHMENT_PATHS }, routeAttachments, routing),
  ];
}
