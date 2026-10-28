import { routePhoneHandoff } from './phoneHandoff.ts';
import { dialCheckRequestSchema } from '@fss/contracts';
import {readCallingProvider} from '@fss/domain/settings/integrations.ts';
import { adviseDial,adviseBrowserDial } from '@fss/domain/dial/advise.ts';
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
export const DIAL_PATHS: readonly string[] = ['/dial/check', '/dial/handoff'];

/** Current provider selects browser advice or retained legacy phone advice.
 * Advice never authorizes execution; each execution owner repeats current gates.
 * The retired ticket HTTP pair stays absent, preserving receipt replay denial.
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
    case '/dial/handoff': return await routePhoneHandoff(deps);
    case '/dial/check': {
      const parsed = dialCheckRequestSchema.safeParse(request.body);
      if (!parsed.success) return { status: REFUSAL_STATUS.malformed_body, body: redactError('malformed_body') };
      const scoped = contextForPrincipal(deps.auth, deps.principal);
      if (!scoped.ok) return scoped.result;
      const advise=await readCallingProvider(scoped.context)==='twilio'?adviseBrowserDial:adviseDial;
      const advice = await advise(scoped.context, {
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
