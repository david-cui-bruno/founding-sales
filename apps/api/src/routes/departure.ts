import { z } from 'zod';
import { commandIdSchema, semanticVersionSchema, uuid } from '@fss/contracts';
import { commitDeparture, previewDeparture } from '@fss/domain/retention';
import { REFUSAL_STATUS, contextForPrincipal, redactError, requirePrincipal } from './crmSupport.ts';
import { runPolicyCommand } from './dialSupport.ts';
import { laneResultOf } from './retentionSupport.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * Departure (specification 10.3, 5.2).
 *
 * Two exact paths under `/admin`, beside the two prefixes `admin-memberships` and
 * `admin-devices` already claim. Exact, because the registry refuses a prefix that
 * swallows another module's claim and because "the path that revokes everything a
 * colleague had" is not a path a typo should reach.
 *
 * The preview is a POST that writes nothing. It is a POST for G3b's reason
 * (`docs/decisions/g3b-reads-are-posts.md`): the thing being asked about is a
 * person's identifier, and a query string is the part of a request that ends up in a
 * load-balancer log.
 *
 * `POST /admin/memberships/deactivate` still exists and still does its four
 * revocations. This is the complete version — it also ends the Gmail grant, deletes
 * the refresh-token material and holds the departed member's firms — and the two are
 * not merged because deactivating a membership and a person leaving Callie are
 * different events, and only one of them is irreversible.
 */

export const DEPARTURE_PATHS: readonly string[] = ['/admin/departure/preview', '/admin/departure/commit'];

const previewSchema = z.strictObject({ userId: uuid });

const commitSchema = z.strictObject({
  commandId: commandIdSchema,
  clientVersion: semanticVersionSchema,
  userId: uuid,
});

export async function routeDeparture(request: ApiRequest, options: RoutingOptions): Promise<RouteResult | null> {
  if (!DEPARTURE_PATHS.includes(request.path)) return null;
  const auth = options.auth;
  if (auth === undefined) return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
  if (request.method !== 'POST') {
    return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
  }

  const authenticated = await requirePrincipal(auth, request);
  if (!authenticated.ok) return authenticated.result;
  const principal = authenticated.principal;
  if (principal.role !== 'admin') {
    return { status: 403, body: { error: 'admin_only', message: 'The request was refused.' } };
  }

  if (request.path === '/admin/departure/preview') {
    const parsed = previewSchema.safeParse(request.body);
    if (!parsed.success) return { status: REFUSAL_STATUS.malformed_body, body: redactError('malformed_body') };
    const scoped = contextForPrincipal(auth, principal);
    if (!scoped.ok) return scoped.result;
    const outcome = await previewDeparture(scoped.context, { userId: parsed.data.userId });
    if (!outcome.ok) return { status: 409, body: { status: 'refused', reason: outcome.reason } };
    return { status: 200, body: { preview: outcome.value } };
  }

  return await runPolicyCommand(
    { auth, request, principal, journal: options.suppressionJournal },
    commitSchema,
    'departure.commit',
    async (context, body) =>
      laneResultOf(await commitDeparture(context, { userId: body.userId, commandId: body.commandId })),
  );
}
