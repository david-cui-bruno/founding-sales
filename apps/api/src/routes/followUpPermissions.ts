import {
  createFollowUpPermissionCommandSchema,
  revokeFollowUpPermissionCommandSchema,
} from '@fss/contracts';
import { z } from 'zod';
import { uuid } from '@fss/contracts';
import { readFirm } from '@fss/domain/crm/firms.ts';
import { decideFirmMutation, decideFirmRead } from '@fss/domain/crm/authorization.ts';
import { databaseNow } from '@fss/domain/policy/clock.ts';
import {
  followUpPermissionDto,
  grantFollowUpPermission,
  listFollowUpPermissions,
  readFollowUpPermission,
  revokeFollowUpPermission,
} from '@fss/domain/sequences/followUpPermissions.ts';
import { REFUSAL_STATUS, redactError } from '../limits.ts';
import { policyRouteDeps, runPolicyCommand } from './dialSupport.ts';
import { contextForPrincipal } from './routeSupport.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * Follow-up permissions (migration 0025; David, 29 September 2026).
 *
 * Three paths, exact — the shape every new endpoint takes, for the reason
 * `routes/modules.ts` gives: an unknown path under a prefix that grants permission to
 * write to a prospect must be `not_found` before any module sees it.
 *
 * The read is a POST, like every other firm read in this API, because the firm id is a
 * body field rather than a path segment and a `GET /firms/:id/...` would need the
 * registry to claim a prefix of `/firms`. The brief spells the read as
 * `GET /firms/:id/follow-up-permissions`; the path is
 * `POST /follow-up-permissions/list` with `{ firmId }`, which is the same read in this
 * codebase's own idiom (deviation 3 in
 * `docs/greenfield/decisions/follow-up-eligibility-20260929.md`).
 *
 * Authorization is the other CRM writes': the route establishes identity
 * (`policyRouteDeps` → `requirePrincipal` → `contextForPrincipal`), every mutation is a
 * command with a receipt (`runPolicyCommand`), and *who may write about this firm* is
 * decided by the domain under the firm's row lock — here `decideFirmMutation`, exactly
 * as `confirmReplyDisposition` and `logCallOutcome` do.
 */
export const FOLLOW_UP_PERMISSION_PATHS: readonly string[] = [
  '/follow-up-permissions',
  '/follow-up-permissions/list',
  '/follow-up-permissions/revoke',
];

const listSchema = z.strictObject({ firmId: uuid.optional(), contactId: uuid.optional() });

export async function routeFollowUpPermissions(
  request: ApiRequest,
  options: RoutingOptions,
): Promise<RouteResult | null> {
  if (!FOLLOW_UP_PERMISSION_PATHS.includes(request.path)) return null;

  const prepared = await policyRouteDeps(request, options);
  if (!prepared.ok) return prepared.result;
  const deps = prepared.deps;

  if (request.method !== 'POST') {
    return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
  }

  if (request.path === '/follow-up-permissions/list') {
    const parsed = listSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return { status: REFUSAL_STATUS.malformed_body, body: redactError('malformed_body') };
    }
    const scoped = contextForPrincipal(deps.auth, deps.principal);
    if (!scoped.ok) return scoped.result;
    if (parsed.data.firmId !== undefined) {
      // A read about one firm answers the assignment question the same way the firm
      // page does: an unassigned salesperson is told nothing about it.
      const firm = await readFirm(scoped.context, parsed.data.firmId);
      if (firm === null) return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
      // A member who is not the assignee and not an admin learns nothing about the
      // firm's permissions — `not_found`, the same answer the firm page gives, because
      // "you are not the assignee of this firm" is itself a fact about the firm.
      if (decideFirmRead(scoped.context, firm) !== 'assigned_or_admin') {
        return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
      }
    }
    const permissions = await listFollowUpPermissions(scoped.context, {
      ...(parsed.data.firmId === undefined ? {} : { firmId: parsed.data.firmId }),
      ...(parsed.data.contactId === undefined ? {} : { contactId: parsed.data.contactId }),
    });
    return {
      status: 200,
      body: {
        asOf: await databaseNow(scoped.context),
        permissions: permissions.map(followUpPermissionDto),
      },
    };
  }

  if (request.path === '/follow-up-permissions') {
    return await runPolicyCommand(
      deps,
      createFollowUpPermissionCommandSchema,
      'grant_follow_up_permission',
      async (context, body) => {
        const firm = await readFirm(context, body.firmId);
        if (firm === null) return { ok: false, reason: 'firm_unknown' };
        const permitted = decideFirmMutation(context, firm);
        if (!permitted.permitted) return { ok: false, reason: permitted.reason };
        return await grantFollowUpPermission(context, {
          firmId: body.firmId,
          contactId: body.contactId,
          kind: body.kind,
          scope: body.scope,
          ...(body.callLogId === undefined ? {} : { callLogId: body.callLogId }),
          ...(body.mailMessageId === undefined ? {} : { mailMessageId: body.mailMessageId }),
          ...(body.bookingReference === undefined ? {} : { bookingReference: body.bookingReference }),
          ...(body.sequenceId === undefined ? {} : { sequenceId: body.sequenceId }),
          ...(body.note === undefined ? {} : { note: body.note }),
          grantedByUserId: context.scope.actor.kind === 'user' ? context.scope.actor.userId : undefined,
          ...(context.scope.actor.kind === 'user' ? {} : { grantedByRule: 'call_outcome' as const }),
        });
      },
    );
  }

  return await runPolicyCommand(
    deps,
    revokeFollowUpPermissionCommandSchema,
    'revoke_follow_up_permission',
    async (context, body) => {
      const existing = await readFollowUpPermission(context, body.permissionId);
      if (existing === null) return { ok: false, reason: 'invalid_input' };
      const firm = await readFirm(context, existing.firmId);
      if (firm === null) return { ok: false, reason: 'firm_unknown' };
      const permitted = decideFirmMutation(context, firm);
      if (!permitted.permitted) return { ok: false, reason: permitted.reason };
      return await revokeFollowUpPermission(context, body.permissionId);
    },
  );
}
