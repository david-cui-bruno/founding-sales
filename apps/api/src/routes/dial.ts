import { dialCheckRequestSchema } from '@fss/contracts';
import { adviseDial } from '@fss/domain/dial/advise.ts';
import { REFUSAL_STATUS, redactError } from '../limits.ts';
import { policyRouteDeps } from './dialSupport.ts';
import { contextForPrincipal } from './routeSupport.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * The exact paths this module owns, for G5b's route registry.
 *
 * Exact rather than a `/dial` prefix: the registry refuses two claims on one
 * path, and that guarantee is only as sharp as the claim. The `startsWith` guard
 * in the router below is redundant for a mounted request and kept because the
 * router is also called directly, by tests and by `route`.
 */
export const DIAL_PATHS: readonly string[] = ['/dial/check'];

/**
 * Dial advice (specification 9.2, 5.3).
 *
 * `POST /dial/check` is the advisory read, and since the 0021 release it is the only
 * path in this family: callable yes or no, with every reason, for a firm and optionally
 * the number the card would dial (`adviseDial`). It writes nothing; the Mac opens
 * `tel:` itself and logs the call afterwards with `POST /calls/log`. It answers only
 * about firms the caller may see — a colleague's is `not_found` — so it cannot be used
 * to learn which firms are suppressed.
 *
 * The ticket pair `/dial/authorize` and `/dial/consume` went with the 1.0.14 minimum
 * (lane W3-C2): nothing has asked for a ticket since 1.0.12, and an unreachable
 * command is a thing to explain rather than a thing to have. The replay rule they
 * enforced lives on in `command_receipts_dial_result_not_actionable` and
 * `dial_tickets_one_per_command`, both untouched by migration 0021.
 */
export async function routeDial(request: ApiRequest, options: RoutingOptions): Promise<RouteResult | null> {
  if (!request.path.startsWith('/dial')) return null;
  const prepared = await policyRouteDeps(request, options);
  if (!prepared.ok) return prepared.result;
  const deps = prepared.deps;

  if (request.method !== 'POST') {
    return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
  }

  switch (request.path) {
    case '/dial/check': {
      const parsed = dialCheckRequestSchema.safeParse(request.body);
      if (!parsed.success) return { status: REFUSAL_STATUS.malformed_body, body: redactError('malformed_body') };
      const scoped = contextForPrincipal(deps.auth, deps.principal);
      if (!scoped.ok) return scoped.result;
      const advice = await adviseDial(scoped.context, {
        firmId: parsed.data.firmId,
        ...(parsed.data.routeId === undefined ? {} : { routeId: parsed.data.routeId }),
      });
      if (advice === null) return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
      return { status: 200, body: { advice } };
    }
    default:
      return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
  }
}
