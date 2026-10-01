import { firmBasicsCommandSchema, firmBasicsIssueSchema } from '@fss/contracts';
import { updateFirmBasics } from '@fss/domain/crm/firmBasics.ts';
import { runCommand } from '../auth/commands.ts';
import { REFUSAL_STATUS, redactError } from '../limits.ts';
import { requirePrincipal } from './routeSupport.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * `POST /crm/firms/basics`: a firm's number, state, locality and time zone (slice S2).
 *
 * Today's card explains what keeps a firm from being called — "No phone number", "No
 * location or time zone" — and offers the fix in place; the firm page offers the same.
 * This is that fix. One command under one receipt (`runCommand`), so the locality, the
 * state, the zone, the new number and the retired one land together or not at all, and a
 * replay answers the same. `updateFirmBasics` decides everything, through the existing
 * firm, zone and route commands and their assignment rule.
 *
 * Like Add firm, a refusal names its fields: `issues` is every field at fault, kept on
 * the receipt as the refusal's details.
 */

export const FIRM_BASICS_PATHS = ['/crm/firms/basics'] as const;

export async function routeFirmBasics(request: ApiRequest, options: RoutingOptions): Promise<RouteResult | null> {
  if (!(FIRM_BASICS_PATHS as readonly string[]).includes(request.path)) return null;
  const auth = options.auth;
  if (auth === undefined) return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
  if (request.method !== 'POST') {
    return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
  }

  const authenticated = await requirePrincipal(auth, request);
  if (!authenticated.ok) return authenticated.result;

  const parsed = firmBasicsCommandSchema.safeParse(request.body);
  if (!parsed.success) return { status: REFUSAL_STATUS.malformed_body, body: redactError('malformed_body') };
  const { commandId, clientVersion, ...payload } = parsed.data;

  const outcome = await runCommand(
    auth,
    authenticated.principal,
    { commandId, kind: 'crm.firm_basics', payload, clientVersion },
    async context => {
      const updated = await updateFirmBasics(context, {
        firmId: payload.firmId,
        ...(payload.phone === undefined
          ? {}
          : {
              phone: {
                number: payload.phone.number,
                ...(payload.phone.replacesRouteId === undefined ? {} : { replacesRouteId: payload.phone.replacesRouteId }),
              },
            }),
        ...(payload.locality === undefined ? {} : { locality: payload.locality }),
        ...(payload.regionCode === undefined ? {} : { regionCode: payload.regionCode }),
        ...(payload.timeZone === undefined ? {} : { timeZone: payload.timeZone }),
      });
      if (updated.ok) return { status: 'accepted', result: updated.value };
      return {
        status: 'refused',
        reason: updated.reason,
        ...(updated.issues === undefined ? {} : { details: { issues: updated.issues } }),
      };
    },
  );

  if (outcome.status === 'accepted') {
    return { status: 200, body: { status: 'accepted', replayed: outcome.replayed, result: outcome.result } };
  }
  const issues = firmBasicsIssueSchema.array().safeParse(outcome.details?.['issues']);
  return {
    status: outcome.reason === 'client_upgrade_required' ? 426 : 409,
    body: {
      status: 'refused',
      replayed: outcome.replayed,
      reason: outcome.reason,
      ...(issues.success && issues.data.length > 0 ? { issues: issues.data } : {}),
    },
  };
}
