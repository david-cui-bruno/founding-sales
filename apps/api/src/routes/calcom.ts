import { CALCOM_SIGNATURE_HEADER } from '@fss/contracts';
import { withTransaction } from '@fss/domain/db/queryable.ts';
import { receiveCalcomEvent, type CalcomReceipt } from '@fss/domain/meetings/calcom.ts';
import { lockCalendarRoutingForRead } from '@fss/domain/policy/calendarRouting.ts';
import { workspacesWithIntegration } from '@fss/domain/settings/integrations.ts';
import { REFUSAL_STATUS, redactError } from '../limits.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * The Cal.com webhook (call-to-booking slice W, migration 0028).
 *
 * `POST /integrations/calcom/webhook`, the subscriber URL configured in Cal.com.
 *
 *   1. no workspace has `calendar_integration = calcom` → 404, as with the defaults; more
 *      than one → 503, because the delivery names no workspace and this is a single-user
 *      product: two would be a configuration to fix, not a guess to make;
 *   2. the `calcom` secret is not configured → 503, logged;
 *   3. `X-Cal-Signature-256` is not the hex HMAC-SHA256 of the **raw** body under the
 *      webhook secret → 401, nothing read or written;
 *   4. the delivery is recorded by the sha256 of its raw body (an exact redelivery is one
 *      application) and applied (`meetings/calcom.ts`).
 *
 * Steps 1 to 4 run in one transaction under the calendar routing lock, SHARED, taken
 * before the workspace's send gate (`policy/calendarRouting.ts`).
 *
 * A verified delivery is always 200, whatever it did — stale, ignored, unmatched — so
 * Cal.com does not retry an event that was received.
 */

export const CALCOM_PATHS: readonly string[] = ['/integrations/calcom/webhook'];

export async function routeCalcom(request: ApiRequest, options: RoutingOptions): Promise<RouteResult | null> {
  if (!CALCOM_PATHS.includes(request.path)) return null;
  if (request.method !== 'POST') {
    return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
  }
  // The routing is decided and applied in one transaction, under the deployment's
  // calendar routing lock SHARED (`policy/calendarRouting.ts`, slice M1 review fold 3):
  // a switch committing meanwhile — this workspace off, another on — waits until the
  // delivery has been applied, or committed before the read below. SHARED, so two
  // deliveries never wait for each other here; the workspace's send gate, taken after
  // it by `receiveCalcomEvent`, is the order between them.
  const outcome = await withTransaction(
    options.session,
    async (): Promise<{ readonly refused: RouteResult } | { readonly receipt: CalcomReceipt }> => {
      await lockCalendarRoutingForRead(options.session);
      const enabled = await workspacesWithIntegration(options.session, { key: 'calendar_integration', value: 'calcom' });
      if (enabled.length === 0) return { refused: { status: REFUSAL_STATUS.not_found, body: redactError('not_found') } };
      const workspaceId = enabled[0];
      if (enabled.length > 1 || workspaceId === undefined) {
        options.log?.log('error', 'integration_unconfigured', { integration: 'calcom', reason: 'more_than_one_workspace' });
        return { refused: { status: 503, body: { error: 'integration_unconfigured', message: 'The calendar is not configured.' } } };
      }
      const calcom = options.integrations?.calcom ?? null;
      const integration = request.integration;
      if (calcom === null || integration === undefined) {
        options.log?.log('error', 'integration_unconfigured', { integration: 'calcom', secret_configured: calcom !== null });
        return { refused: { status: 503, body: { error: 'integration_unconfigured', message: 'The calendar is not configured.' } } };
      }
      if (!calcom.verifySignature(integration.rawBody, request.headers[CALCOM_SIGNATURE_HEADER])) {
        options.log?.log('info', 'refusal', { reason: 'calcom_signature_invalid', path: request.path });
        return { refused: { status: REFUSAL_STATUS.unauthenticated, body: { error: 'signature_invalid', message: 'The request was refused.' } } };
      }
      return { receipt: await receiveCalcomEvent(options.session, { workspaceId, rawBody: integration.rawBody, body: request.body }) };
    },
  );
  if ('refused' in outcome) return outcome.refused;
  const receipt = outcome.receipt;
  return {
    status: 200,
    body: { status: 'accepted', duplicate: receipt.duplicate, outcome: receipt.outcome, meetingState: receipt.meetingState },
  };
}
