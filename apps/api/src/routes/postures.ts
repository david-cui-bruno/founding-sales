import {
  recordStatePostureCommandSchema,
  revokeStatePostureCommandSchema,
  setCallingWindowCommandSchema,
} from '@fss/contracts';
import {
  currentCallingWindow,
  listStatePostures,
  recordStatePosture,
  revokeStatePosture,
  setCallingWindow,
} from '@fss/domain/policy';
import { REFUSAL_STATUS, contextForPrincipal, policyRouteDeps, redactError, runPolicyCommand } from './dialSupport.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * The exact paths this module owns, for G5b's route registry.
 *
 * Exact rather than a `/postures` prefix: the registry refuses two claims on one
 * path, and that guarantee is only as sharp as the claim. The `startsWith` guard
 * in the router below is redundant for a mounted request and kept because the
 * router is also called directly, by tests and by `route`.
 */
export const POSTURE_PATHS: readonly string[] = [
  '/postures',
  '/postures/calling-window',
  '/postures/record',
  '/postures/revoke',
];

/**
 * State postures and the configured calling window (specification 9.2, 10.1).
 *
 * Invariant 7: "Software records and enforces legal posture; it does not invent
 * it." The API's whole job here is to record what a person confirmed and to refuse
 * everything else — the reference texts come from `@fss/domain`, not from the
 * request body, so a caller cannot cite material the release does not carry.
 *
 * The calling window shares this module because it is the same kind of thing:
 * versioned configuration an admin maintains, which narrows a floor fixed in code
 * and can never widen it.
 *
 * The reads are open to any authenticated member. A salesperson who sees the
 * refusal `posture_overdue` on a card should be able to see which posture it was.
 */
export async function routePostures(request: ApiRequest, options: RoutingOptions): Promise<RouteResult | null> {
  if (!request.path.startsWith('/postures')) return null;
  const prepared = await policyRouteDeps(request, options);
  if (!prepared.ok) return prepared.result;
  const deps = prepared.deps;

  if (request.method === 'GET') {
    const scoped = contextForPrincipal(deps.auth, deps.principal);
    if (!scoped.ok) return scoped.result;
    if (request.path === '/postures') {
      const state = request.query.get('state');
      return { status: 200, body: { postures: await listStatePostures(scoped.context, state === null ? {} : { state }) } };
    }
    if (request.path === '/postures/calling-window') {
      return { status: 200, body: { callingWindow: await currentCallingWindow(scoped.context) } };
    }
    return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
  }

  if (request.method !== 'POST') {
    return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
  }

  switch (request.path) {
    case '/postures/record':
      return await runPolicyCommand(
        deps,
        recordStatePostureCommandSchema,
        'record_state_posture',
        async (repository, body) =>
          await recordStatePosture(repository, {
            state: body.state,
            effectiveFrom: body.effectiveFrom,
            ...(body.effectiveTo === undefined ? {} : { effectiveTo: body.effectiveTo }),
            ...(body.reviewAt === undefined ? {} : { reviewAt: body.reviewAt }),
            confirmedStatements: body.confirmedStatements,
            ...(body.note === undefined ? {} : { note: body.note }),
          }),
      );
    case '/postures/revoke':
      return await runPolicyCommand(
        deps,
        revokeStatePostureCommandSchema,
        'revoke_state_posture',
        async (repository, body) => await revokeStatePosture(repository, { postureId: body.postureId }),
      );
    case '/postures/calling-window':
      return await runPolicyCommand(deps, setCallingWindowCommandSchema, 'set_calling_window', async (repository, body) =>
        await setCallingWindow(repository, {
          startMinute: body.startMinute,
          endMinute: body.endMinute,
          ...(body.weekdays === undefined ? {} : { weekdays: body.weekdays }),
        }),
      );
    default:
      return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
  }
}
