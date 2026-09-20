import { z } from 'zod';
import { commandIdSchema, membershipRoleSchema, membershipViewSchema, semanticVersionSchema, uuid } from '@fss/contracts';
import type { QueryResultRowLike } from '@fss/domain/db';
import { actorOf, authenticate, recordAuditEvent, runCommand } from '../../auth/index.ts';
import type { AuthDeps, AuthenticatedPrincipal } from '../../auth/index.ts';
import { REFUSAL_STATUS, redactError } from '../../limits.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from '../types.ts';

/**
 * Membership administration (specification 5.2).
 *
 * "Admin: manages memberships, assignments... The last active admin cannot deactivate
 * themselves or be removed."
 *
 * The last-admin rule is enforced twice on purpose. Migration 0001 has a constraint
 * trigger that raises `restrict_violation`, which is the guarantee; but a trigger
 * firing inside a command's transaction aborts it, and an aborted transaction cannot
 * then write its receipt. So the command also checks first, under `FOR UPDATE`, and
 * refuses with a named reason. The trigger is what catches anything that ever gets
 * past this file.
 */

const roleChangeSchema = z.strictObject({
  commandId: commandIdSchema,
  clientVersion: semanticVersionSchema,
  userId: uuid,
  role: membershipRoleSchema,
});

const deactivateSchema = z.strictObject({
  commandId: commandIdSchema,
  clientVersion: semanticVersionSchema,
  userId: uuid,
});

interface MembershipRow extends QueryResultRowLike {
  readonly user_id: string;
  readonly email: string;
  readonly display_name: string;
  readonly role: 'admin' | 'salesperson';
  readonly status: 'active' | 'inactive';
  readonly created_at: Date;
  readonly deactivated_at: Date | null;
}

async function listMemberships(auth: AuthDeps, workspaceId: string): Promise<unknown[]> {
  const { rows } = await auth.db.query<MembershipRow>(
    `SELECT m.user_id, u.email, u.display_name, m.role, m.status, m.created_at, m.deactivated_at
       FROM workspace_memberships m
       JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = $1
      ORDER BY u.email`,
    [workspaceId],
  );
  return rows.map(row =>
    membershipViewSchema.parse({
      userId: row.user_id,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
      status: row.status,
      createdAt: row.created_at.toISOString(),
      deactivatedAt: row.deactivated_at === null ? null : row.deactivated_at.toISOString(),
    }),
  );
}

/**
 * Would changing this membership leave the workspace with no active admin?
 *
 * `FOR UPDATE` on the admin rows is what makes two concurrent "demote the other
 * admin" commands serialize: one wins and the other sees the count it left behind.
 */
async function wouldStrandTheWorkspace(
  auth: AuthDeps,
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  const { rows } = await auth.db.query<{ user_id: string }>(
    `SELECT user_id FROM workspace_memberships
      WHERE workspace_id = $1 AND role = 'admin' AND status = 'active'
      FOR UPDATE`,
    [workspaceId],
  );
  return rows.length <= 1 && rows.some(row => row.user_id === userId);
}

async function requireAdmin(
  auth: AuthDeps,
  request: ApiRequest,
): Promise<{ readonly ok: true; readonly principal: AuthenticatedPrincipal } | { readonly ok: false; readonly result: RouteResult }> {
  const outcome = await authenticate(auth, request.headers['authorization']);
  if (!outcome.authenticated) {
    return { ok: false, result: { status: 401, body: { error: outcome.refusal, message: 'The request was refused.' } } };
  }
  if (outcome.principal.role !== 'admin') {
    return { ok: false, result: { status: 403, body: { error: 'admin_only', message: 'The request was refused.' } } };
  }
  return { ok: true, principal: outcome.principal };
}

export async function routeAdminMemberships(
  request: ApiRequest,
  options: RoutingOptions,
): Promise<RouteResult | null> {
  if (!request.path.startsWith('/admin/memberships')) return null;
  const auth = options.auth;
  if (auth === undefined) return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };

  const admin = await requireAdmin(auth, request);
  if (!admin.ok) return admin.result;
  const principal = admin.principal;

  if (request.path === '/admin/memberships' && (request.method === 'GET' || request.method === 'HEAD')) {
    return { status: 200, body: { memberships: await listMemberships(auth, principal.workspaceId) } };
  }

  if (request.method !== 'POST') {
    return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
  }

  if (request.path === '/admin/memberships/role') {
    const parsed = roleChangeSchema.safeParse(request.body);
    if (!parsed.success) return { status: 400, body: redactError('malformed_body') };
    const { userId, role } = parsed.data;

    const outcome = await runCommand(
      auth,
      principal,
      { commandId: parsed.data.commandId, kind: 'membership.role_changed', payload: { userId, role }, clientVersion: parsed.data.clientVersion },
      async () => {
        if (role !== 'admin' && (await wouldStrandTheWorkspace(auth, principal.workspaceId, userId))) {
          return { status: 'refused', reason: 'last_active_admin' };
        }
        const { rowCount } = await auth.db.query(
          `UPDATE workspace_memberships SET role = $3, updated_at = now()
            WHERE workspace_id = $1 AND user_id = $2`,
          [principal.workspaceId, userId, role],
        );
        if ((rowCount ?? 0) === 0) return { status: 'refused', reason: 'membership_unknown' };
        await recordAuditEvent(auth.db, {
          workspaceId: principal.workspaceId,
          actor: actorOf(principal),
          action: 'membership.role_changed',
          subjectKind: 'user',
          subjectId: userId,
          detail: { role },
        });
        return { status: 'accepted', result: { userId, role } };
      },
    );
    return commandReply(outcome);
  }

  if (request.path === '/admin/memberships/deactivate') {
    const parsed = deactivateSchema.safeParse(request.body);
    if (!parsed.success) return { status: 400, body: redactError('malformed_body') };
    const { userId } = parsed.data;

    const outcome = await runCommand(
      auth,
      principal,
      { commandId: parsed.data.commandId, kind: 'membership.deactivated', payload: { userId }, clientVersion: parsed.data.clientVersion },
      async () => {
        if (await wouldStrandTheWorkspace(auth, principal.workspaceId, userId)) {
          return { status: 'refused', reason: 'last_active_admin' };
        }
        const { rowCount } = await auth.db.query(
          `UPDATE workspace_memberships
              SET status = 'inactive', deactivated_at = $3, updated_at = $3
            WHERE workspace_id = $1 AND user_id = $2 AND status = 'active'`,
          [principal.workspaceId, userId, auth.now().toISOString()],
        );
        if ((rowCount ?? 0) === 0) return { status: 'refused', reason: 'membership_unknown' };

        // Departure revokes devices and sessions in the same transaction (10.3).
        await auth.db.query(
          `UPDATE devices SET status = 'revoked', revoked_at = COALESCE(revoked_at, $3)
            WHERE workspace_id = $1 AND user_id = $2 AND status = 'active'`,
          [principal.workspaceId, userId, auth.now().toISOString()],
        );
        await auth.db.query(
          `UPDATE sessions SET status = 'ended', ended_at = $3, end_reason = 'membership_revoked'
            WHERE workspace_id = $1 AND user_id = $2 AND status = 'active'`,
          [principal.workspaceId, userId, auth.now().toISOString()],
        );
        await auth.db.query(
          `UPDATE device_refresh_credentials c SET state = 'revoked'
             FROM devices d
            WHERE d.workspace_id = c.workspace_id AND d.id = c.device_id
              AND c.workspace_id = $1 AND d.user_id = $2 AND c.state = 'active'`,
          [principal.workspaceId, userId],
        );
        await recordAuditEvent(auth.db, {
          workspaceId: principal.workspaceId,
          actor: actorOf(principal),
          action: 'membership.deactivated',
          subjectKind: 'user',
          subjectId: userId,
        });
        return { status: 'accepted', result: { userId, status: 'inactive' } };
      },
    );
    return commandReply(outcome);
  }

  return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
}

/** One shape for every command answer, so a route never invents its own. */
export function commandReply(outcome: {
  readonly status: 'accepted' | 'refused';
  readonly replayed: boolean;
  readonly result?: unknown;
  readonly reason?: string;
}): RouteResult {
  if (outcome.status === 'accepted') {
    return { status: 200, body: { status: 'accepted', replayed: outcome.replayed, result: outcome.result ?? null } };
  }
  return {
    status: outcome.reason === 'client_upgrade_required' ? 426 : 409,
    body: { status: 'refused', replayed: outcome.replayed, reason: outcome.reason ?? 'refused' },
  };
}

export { requireAdmin };
