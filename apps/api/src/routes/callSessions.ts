import { createCallSessionCommandSchema, voiceAccessTokenResponseSchema } from '@fss/contracts';
import { createCallSession } from '@fss/domain/calls/sessions.ts';
import { readCallingProvider } from '@fss/domain/settings/integrations.ts';
import { REFUSAL_STATUS, redactError } from '../limits.ts';
import { policyRouteDeps, runPolicyCommand } from './dialSupport.ts';
import { contextForPrincipal } from './routeSupport.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * The Mac's two call-session routes (call-to-booking slice W).
 *
 *   * `POST /calls/session` — a command with a receipt. Firm, route at its displayed
 *     version, calling identity; the server resolves the number, runs the whole
 *     authorization and the budget, and answers `{ sessionId, expiresAt }` — never the
 *     number (`calls/sessions.ts`).
 *   * `POST /calls/access-token` — the Twilio Voice access token for this user: identity
 *     = the user id, outgoing application only, no incoming grant, one hour.
 *
 * Both are 404 unless the caller's workspace has `calling_provider = twilio`, so with the
 * defaults the Mac keeps its `tel:` handoff and nothing here is reachable; 503 when the
 * switch is on and the Twilio configuration is not.
 */

export const CALL_SESSION_PATHS: readonly string[] = ['/calls/session', '/calls/access-token'];

export async function routeCallSessions(request: ApiRequest, options: RoutingOptions): Promise<RouteResult | null> {
  if (!CALL_SESSION_PATHS.includes(request.path)) return null;
  const prepared = await policyRouteDeps(request, options);
  if (!prepared.ok) return prepared.result;
  const deps = prepared.deps;
  if (request.method !== 'POST') {
    return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
  }
  const scoped = contextForPrincipal(deps.auth, deps.principal);
  if (!scoped.ok) return scoped.result;
  if ((await readCallingProvider(scoped.context)) !== 'twilio') {
    return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
  }
  const twilio = options.integrations?.twilio ?? null;
  if (twilio === null) {
    options.log?.log('error', 'integration_unconfigured', { integration: 'twilio', secret_configured: false });
    return { status: 503, body: { error: 'integration_unconfigured', message: 'Calling is not configured.' } };
  }

  if (request.path === '/calls/access-token') {
    const minted = twilio.mintAccessToken(deps.principal.userId, Math.floor(Date.now() / 1000));
    return {
      status: 200,
      body: voiceAccessTokenResponseSchema.parse({
        token: minted.token,
        identity: deps.principal.userId,
        expiresAt: new Date(minted.expiresAtSeconds * 1000).toISOString(),
      }),
    };
  }

  const at = options.integrations?.decisionAt?.();
  return await runPolicyCommand(deps, createCallSessionCommandSchema, 'create_call_session', async (context, body) =>
    await createCallSession(context, {
      firmId: body.firmId,
      ...(body.contactId === undefined ? {} : { contactId: body.contactId }),
      routeId: body.routeId,
      routeVersion: body.routeVersion,
      callingIdentityId: body.callingIdentityId,
      deviceId: deps.principal.deviceId,
      commandId: body.commandId,
      configuredCallerIdE164: twilio.callerIdE164,
      ...(at === undefined ? {} : { at }),
    }),
  );
}
