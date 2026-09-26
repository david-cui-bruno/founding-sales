import { z } from 'zod';
import { MAIL_COMMAND_ENVELOPE } from '@fss/contracts';
import type { RepositoryContext } from '@fss/domain/db';
import { repositoryContext, workspaceScope } from '@fss/domain/db';

import type { AuthDeps } from '../auth/index.ts';
import { REFUSAL_STATUS, redactError } from '../limits.ts';
import { contextForPrincipal, requirePrincipal, type RouteDeps } from './routeSupport.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * What the three mail route modules share: the route deps, the two command schemas the
 * Mac does not send, and the OAuth callback's membership scope. The connect and
 * disconnect schemas are `@fss/contracts`' (`mail.ts`), because the Mac sends the first.
 */

export const resolveAmbiguityCommandSchema = z
  .object({
    ...MAIL_COMMAND_ENVELOPE,
    messageId: z.string().uuid(),
    selectedOpportunityId: z.string().uuid(),
    /** True only when a person looked at the message and said it was human (12.4). */
    human: z.boolean(),
  })
  .strict();

export const listMessagesRequestSchema = z
  .object({
    opportunityId: z.string().uuid(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();

/** Authenticate and scope, or the refusal to return. */
export async function mailRouteDeps(
  request: ApiRequest,
  options: RoutingOptions,
): Promise<{ readonly ok: true; readonly deps: RouteDeps } | { readonly ok: false; readonly result: RouteResult }> {
  const auth = options.auth;
  if (auth === undefined) {
    return { ok: false, result: { status: REFUSAL_STATUS.not_found, body: redactError('not_found') } };
  }
  const authenticated = await requirePrincipal(auth, request);
  if (!authenticated.ok) return { ok: false, result: authenticated.result };
  const scoped = contextForPrincipal(auth, authenticated.principal);
  if (!scoped.ok) return { ok: false, result: scoped.result };
  return { ok: true, deps: { auth, request, principal: authenticated.principal } };
}

export interface MembershipScope {
  readonly context: RepositoryContext;
  readonly role: 'admin' | 'salesperson';
}

/**
 * The scope for a user the OAuth callback has proved through its signed state.
 *
 * The callback carries no session — Google's browser redirect has none — so the
 * signed state is what says which user consented, and this is the check 5.1 requires
 * anyway: "An active `workspace_memberships` row is required and checked, together
 * with device revocation, on every command." There is no device here, so the
 * membership is the whole of it, and an inactive one is refused.
 */
export async function membershipScope(
  auth: AuthDeps,
  claims: { readonly workspaceId: string; readonly userId: string },
): Promise<MembershipScope | null> {
  const { rows } = await auth.db.query<{ role: 'admin' | 'salesperson'; status: string }>(
    'SELECT role, status FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2',
    [claims.workspaceId, claims.userId],
  );
  const row = rows[0];
  if (row === undefined || row.status !== 'active') return null;
  return {
    role: row.role,
    context: repositoryContext(
      workspaceScope(claims.workspaceId, { kind: 'user', userId: claims.userId, role: row.role }),
      auth.db,
    ),
  };
}
