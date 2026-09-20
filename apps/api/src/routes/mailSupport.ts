import { z } from 'zod';
import type { RepositoryContext } from '@fss/domain/db';
import { repositoryContext, workspaceScope } from '@fss/domain/db';

import { runCommand } from '../auth/index.ts';
import type { AuthDeps, AuthenticatedPrincipal } from '../auth/index.ts';
import { REFUSAL_STATUS, contextForPrincipal, crmReply, redactError, requirePrincipal } from './crmSupport.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * What the three mail route modules share.
 *
 * The same discipline as `crmSupport.ts` and `dialSupport.ts`: every mutation is a
 * `runCommand`, so the receipt, the payload hash, the device and the mutation commit
 * in one transaction (5.3), and no route decides for itself whether a caller owns a
 * mailbox — `disconnectMailbox` does, from the row.
 *
 * The command schemas are here rather than in `@fss/contracts` because the Mac does
 * not send any of them yet: the desktop mailbox screen is a later lane, and a shared
 * contract nobody on the other side reads is a contract that drifts. They move to
 * `@fss/contracts` in the pull request that adds the screen.
 */

const commandEnvelope = {
  commandId: z.string().uuid(),
  clientVersion: z.string().min(1).max(32),
};

export const connectMailboxCommandSchema = z.object(commandEnvelope).strict();

export const disconnectMailboxCommandSchema = z
  .object({
    ...commandEnvelope,
    mailboxId: z.string().uuid(),
    reason: z.string().trim().min(1).max(200),
  })
  .strict();

export const resolveAmbiguityCommandSchema = z
  .object({
    ...commandEnvelope,
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

export interface MailRouteDeps {
  readonly auth: AuthDeps;
  readonly request: ApiRequest;
  readonly principal: AuthenticatedPrincipal;
}

/** Authenticate and scope, or the refusal to return. */
export async function mailRouteDeps(
  request: ApiRequest,
  options: RoutingOptions,
): Promise<{ readonly ok: true; readonly deps: MailRouteDeps } | { readonly ok: false; readonly result: RouteResult }> {
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

/**
 * What a command's work may answer: a value, or a reason it refused.
 *
 * Deliberately a bare `string` for the reason rather than one lane's refusal union.
 * The mail lane and the outbound lane have different vocabularies — `MailRefusalCode`
 * and `SendRefusalCode` — and both go into the same receipt column, so the shared
 * helper takes the looser type and each caller keeps its own narrow one at its own
 * boundary.
 */
export type CommandResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

/** Parse, run inside a command receipt, and reply. */
export async function runMailCommand<Schema extends z.ZodType<{ commandId: string; clientVersion: string }>, T>(
  deps: MailRouteDeps,
  schema: Schema,
  kind: string,
  work: (context: RepositoryContext, body: z.infer<Schema>) => Promise<CommandResult<T>>,
): Promise<RouteResult> {
  const parsed = schema.safeParse(deps.request.body);
  if (!parsed.success) return { status: REFUSAL_STATUS.malformed_body, body: redactError('malformed_body') };
  const body = parsed.data;

  const { commandId, clientVersion, ...payload } = body as { commandId: string; clientVersion: string };
  const outcome = await runCommand(
    deps.auth,
    deps.principal,
    { commandId, kind, payload, clientVersion },
    async context => {
      const result = await work(context, body);
      if (result.ok) return { status: 'accepted', result: result.value };
      return { status: 'refused', reason: result.reason };
    },
  );
  return crmReply(outcome);
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

export { REFUSAL_STATUS, contextForPrincipal, redactError };
export type { ApiRequest, RouteResult, RoutingOptions };
