import { completeCallbackCommandSchema, scheduleCallbackCommandSchema } from '@fss/contracts';
import { completeCallback, listCallbacks, scheduleCallbackForCall } from '@fss/domain/dial/callbacks.ts';
import { REFUSAL_STATUS, redactError } from '../limits.ts';
import { policyRouteDeps, runPolicyCommand } from './dialSupport.ts';
import { contextForPrincipal } from './routeSupport.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * The exact paths this module owns, for G5b's route registry.
 *
 * Exact rather than a `/callbacks` prefix: the registry refuses two claims on one
 * path, and that guarantee is only as sharp as the claim. The `startsWith` guard
 * in the router below is redundant for a mounted request and kept because the
 * router is also called directly, by tests and by `route`.
 */
export const CALLBACK_PATHS: readonly string[] = [
  '/callbacks',
  '/callbacks/complete',
  '/callbacks/schedule',
];

/**
 * Callbacks (specification 9.1, 8.2).
 *
 * There is deliberately no `create` endpoint. A callback is created by the call
 * outcome that asked for one, with the instant the salesperson confirmed, inside
 * that command's transaction. A separate endpoint would be a second way to make one
 * without the call it belongs to, which is how a callback ends up with no record of
 * why it exists.
 *
 * `/callbacks/schedule` is not that second way. It gives a callback that a
 * recorded call already asked for — "call me back", with no time confirmed yet — the
 * instant the salesperson now confirms, beside that call. Without a recorded
 * `callback_requested` call to name it refuses, so every callback still has the call
 * it came from.
 *
 * So the surface is the list the Today lane reads, the completion and the scheduling. A salesperson
 * always gets their own: the query parameter is ignored for them rather than
 * refused, because a card asking for somebody else's callbacks is a bug in the
 * client and not an attack worth a 403.
 */
export async function routeCallbacks(request: ApiRequest, options: RoutingOptions): Promise<RouteResult | null> {
  if (!request.path.startsWith('/callbacks')) return null;
  const prepared = await policyRouteDeps(request, options);
  if (!prepared.ok) return prepared.result;
  const deps = prepared.deps;

  if (request.method === 'GET' && request.path === '/callbacks') {
    const scoped = contextForPrincipal(deps.auth, deps.principal);
    if (!scoped.ok) return scoped.result;
    const requested = request.query.get('assignedUserId');
    const assignedUserId = deps.principal.role === 'admin' ? (requested ?? undefined) : deps.principal.userId;
    return {
      status: 200,
      body: {
        callbacks: await listCallbacks(scoped.context, {
          ...(assignedUserId === undefined ? {} : { assignedUserId }),
          openOnly: request.query.get('open') === 'true',
        }),
      },
    };
  }

  if (request.method !== 'POST') {
    return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
  }
  if (request.path === '/callbacks/schedule') {
    return await runPolicyCommand(deps, scheduleCallbackCommandSchema, 'schedule_callback', async (repository, body) =>
      await scheduleCallbackForCall(repository, {
        callLogId: body.callLogId,
        localDate: body.localDate,
        ...(body.localTime === undefined ? {} : { localTime: body.localTime }),
        sourceTimeZone: body.sourceTimeZone,
        ...(body.dueAt === undefined ? {} : { dueAt: body.dueAt }),
      }),
    );
  }
  if (request.path !== '/callbacks/complete') {
    return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
  }

  return await runPolicyCommand(deps, completeCallbackCommandSchema, 'complete_callback', async (repository, body) =>
    await completeCallback(repository, { callbackId: body.callbackId }),
  );
}
