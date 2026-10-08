import { claimNotificationCommandSchema, observeNotificationCommandSchema, acknowledgeNotificationCommandSchema } from '@fss/contracts';
import { readActionableNotifications, claimNotification, observeNotification, acknowledgeNotification } from '@fss/domain/notifications/ledger.ts';
import { databaseNow } from '@fss/domain/policy/clock.ts';
import { REFUSAL_STATUS, redactError } from '../limits.ts';
import { contextForPrincipal, requirePrincipal, runRouteCommand } from './routeSupport.ts';
import type { ApiRequest, RoutingOptions, RouteResult } from './types.ts';

export const NOTIFICATION_PATHS: readonly string[] = ['/notifications/actions', '/notifications/claim', '/notifications/observe', '/notifications/acknowledge'];

export async function routeNotifications(request: ApiRequest, options: RoutingOptions): Promise<RouteResult | null> {
  if (!NOTIFICATION_PATHS.includes(request.path)) return null;
  const auth = options.auth;
  if (auth === undefined) return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
  const authenticated = await requirePrincipal(auth, request);
  if (!authenticated.ok) return authenticated.result;
  const principal = authenticated.principal;
  const scoped = contextForPrincipal(auth, principal);
  if (!scoped.ok) return scoped.result;
  const deps = { auth, principal, request }, deviceId = principal.deviceId;
  if (request.path === '/notifications/actions') {
    if (request.method !== 'GET') return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
    return { status: 200, body: await readActionableNotifications(scoped.context, { deviceId, now: await databaseNow(scoped.context) }) };
  }
  if (request.method !== 'POST') return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
  if (request.path === '/notifications/claim') return await runRouteCommand(deps, claimNotificationCommandSchema, 'notification_claim', async (context, body) => ({ ok: true, value: { version: 1, item: await claimNotification(context, { eventKey: body.eventKey, deviceId, now: await databaseNow(context) }) } }));
  if (request.path === '/notifications/observe') return await runRouteCommand(deps, observeNotificationCommandSchema, 'notification_observe', async (context, body) => ({ ok: true, value: { version: 1, recorded: await observeNotification(context, { attemptId: body.attemptId, deviceId, observation: body.observation, now: await databaseNow(context) }) } }));
  return await runRouteCommand(deps, acknowledgeNotificationCommandSchema, 'notification_acknowledge', async (context, body) => ({ ok: true, value: { version: 1, target: await acknowledgeNotification(context, { attemptId: body.attemptId, deviceId, now: await databaseNow(context) }) } }));
}
