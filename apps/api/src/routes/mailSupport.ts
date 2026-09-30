import { z } from 'zod';
import { GRANT_REFUSAL_CODES, MAIL_COMMAND_ENVELOPE, type GmailStatus, type GrantRefusalCode } from '@fss/contracts';
import { readRecovery } from '@fss/domain/mail/recover.ts';
import type { MailboxRow } from '@fss/domain/mail/types.ts';
import type { RepositoryContext } from '@fss/domain/db/workspaceScope.ts';
import { repositoryContext, workspaceScope } from '@fss/domain/db/workspaceScope.ts';

import type { AuthDeps } from '../auth/config.ts';
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

type BaselineProgress = NonNullable<NonNullable<GmailStatus['mailbox']>['baseline']>;

/**
 * `/gmail/status`'s `mailbox.baseline` (call-to-booking A2): the current generation's
 * `mailbox_recoveries` row, so the Mac can say "reading the last 30 days: N messages so
 * far". Null when this generation has none.
 */
export async function readBaselineProgress(
  context: RepositoryContext,
  mailbox: Pick<MailboxRow, 'id' | 'generation'>,
): Promise<BaselineProgress | null> {
  const recovery = await readRecovery(context, { mailboxId: mailbox.id, generation: mailbox.generation });
  if (recovery === null) return null;
  return {
    pagesCompleted: recovery.pagesCompleted,
    messagesSeen: recovery.messagesSeen,
    completedAt: recovery.completedAt,
  };
}

/**
 * `/gmail/status`'s `lastGrantRefusal` (A2): the latest `mailbox.grant_refused` audit row
 * for this user after their latest `mailbox.connected` or `mailbox.switched`, or null.
 * The callback is a browser page that says nothing, so this is how the Mac learns that
 * the attempt it started (`attemptId`) was refused, and why.
 */
export async function readLastGrantRefusal(
  context: RepositoryContext,
  userId: string,
): Promise<GmailStatus['lastGrantRefusal']> {
  const { rows } = await context.db.query<{ reason: string; occurred_at: Date; attempt_id: string | null }>(
    `SELECT r.detail->>'reason' AS reason, r.occurred_at, r.detail->>'attemptId' AS attempt_id
       FROM audit_events r
      WHERE r.workspace_id = $1
        AND r.action = 'mailbox.grant_refused'
        AND r.actor_user_id = $2
        AND r.detail->>'reason' = ANY ($3::text[])
        AND r.occurred_at > coalesce(
              (SELECT max(c.occurred_at) FROM audit_events c
                WHERE c.workspace_id = $1 AND c.actor_user_id = $2
                  AND c.action IN ('mailbox.connected', 'mailbox.switched')),
              '-infinity'::timestamptz)
      ORDER BY r.occurred_at DESC, r.id DESC
      LIMIT 1`,
    [context.scope.workspaceId, userId, [...GRANT_REFUSAL_CODES]],
  );
  const row = rows[0];
  if (row === undefined) return null;
  const attemptId = row.attempt_id !== null && z.uuid().safeParse(row.attempt_id).success ? row.attempt_id : null;
  return { reason: row.reason as GrantRefusalCode, at: row.occurred_at.toISOString(), attemptId };
}
