import { addFirmCommandSchema, importIssueSchema, uuid } from '@fss/contracts';
import { addFirm } from '@fss/domain/crm';
import { runCommand } from '../auth/index.ts';
import { REFUSAL_STATUS, redactError, requirePrincipal } from './crmSupport.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * `POST /crm/firms/add`: the Add firm form (lane g84, audit item G02).
 *
 * An empty workspace could not be filled from the Mac: the CRM window opened and edited
 * firms that already existed, and nothing created one. This is the form's command. It is
 * one row of an import typed into a form — `addFirm` in `packages/domain/crm/import.ts`
 * validates, matches and commits it with the import's own functions — under one receipt,
 * so the firm, its first contact and that contact's address and number land together or
 * not at all.
 *
 * An exact path in its own module, which is what every new endpoint is (`modules.ts`):
 * `/firms` is a prefix G3a's router already answers for, and a command that is not one
 * of its five would have been a sixth arm of a router that is not this lane's.
 *
 * A refusal names its fields. `issues` is every field at fault, by the import column the
 * form's field stands for, and `firmId` is the firm a `duplicate_in_workspace` matched.
 * Both are kept on the receipt (lane g78's refusal details), so a replay answers the same.
 */

export const ADD_FIRM_PATHS = ['/crm/firms/add'] as const;

export async function routeAddFirm(request: ApiRequest, options: RoutingOptions): Promise<RouteResult | null> {
  if (!(ADD_FIRM_PATHS as readonly string[]).includes(request.path)) return null;
  const auth = options.auth;
  if (auth === undefined) return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
  if (request.method !== 'POST') {
    return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
  }

  const authenticated = await requirePrincipal(auth, request);
  if (!authenticated.ok) return authenticated.result;

  const parsed = addFirmCommandSchema.safeParse(request.body);
  if (!parsed.success) return { status: REFUSAL_STATUS.malformed_body, body: redactError('malformed_body') };
  const { commandId, clientVersion, ...payload } = parsed.data;

  const outcome = await runCommand(
    auth,
    authenticated.principal,
    { commandId, kind: 'crm.add_firm', payload, clientVersion },
    async context => {
      const added = await addFirm(context, {
        firm: payload.firm,
        ...(payload.contact === undefined ? {} : { contact: payload.contact }),
      });
      if (added.ok) {
        return {
          status: 'accepted',
          result: { firmId: added.value.firmId, contactId: added.value.contactId, routeIds: added.value.routeIds },
        };
      }
      return {
        status: 'refused',
        reason: added.reason,
        details: {
          ...(added.issues === undefined ? {} : { issues: added.issues }),
          ...(added.firmId === undefined ? {} : { firmId: added.firmId }),
        },
      };
    },
  );

  if (outcome.status === 'accepted') {
    return { status: 200, body: { status: 'accepted', replayed: outcome.replayed, result: outcome.result } };
  }
  const issues = importIssueSchema.array().safeParse(outcome.details?.['issues']);
  const firmId = uuid.safeParse(outcome.details?.['firmId']);
  return {
    status: outcome.reason === 'client_upgrade_required' ? 426 : 409,
    body: {
      status: 'refused',
      replayed: outcome.replayed,
      reason: outcome.reason,
      ...(issues.success && issues.data.length > 0 ? { issues: issues.data } : {}),
      ...(firmId.success ? { firmId: firmId.data } : {}),
    },
  };
}
