import type { z } from 'zod';
import type { RepositoryContext } from '@fss/domain/db';
import { authenticate, runCommand } from '../auth/index.ts';
import type { AuthDeps, AuthenticatedPrincipal } from '../auth/index.ts';
import { contextFor, scopeForPrincipal } from '../scope.ts';
import { REFUSAL_STATUS, redactError } from '../limits.ts';
import type { ApiRequest, RouteResult } from './types.ts';

/**
 * What every route module shares: authentication, the repository context, and the
 * one way a mutating route runs its command.
 *
 * Every mutation is a `runCommand` (5.3): the receipt, the payload hash, the device and
 * the mutation commit in one transaction, and a replay returns the original result. No
 * route writes a receipt itself, and no route decides whether a caller is the assignee
 * — the domain command does, under the row lock, which is the only place that decision
 * is safe (Appendix G 7).
 *
 * So a route is three lines of work: parse the body against its schema, call the
 * command inside `runRouteCommand`, and turn the result into a reply.
 */

export interface RouteDeps {
  readonly auth: AuthDeps;
  readonly request: ApiRequest;
  readonly principal: AuthenticatedPrincipal;
}

/**
 * What a command's work answers: a value, or the reason it refused.
 *
 * The reason is a bare `string` rather than one area's refusal union: every area's
 * codes go into the same receipt column, so the shared runner takes the looser type and
 * each domain command keeps its own narrow one at its own boundary.
 */
export interface CommandResult<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly reason?: string;
}

/** Authenticate, or the refusal to return. Reads and writes both need a principal. */
export async function requirePrincipal(
  auth: AuthDeps,
  request: ApiRequest,
): Promise<{ readonly ok: true; readonly principal: AuthenticatedPrincipal } | { readonly ok: false; readonly result: RouteResult }> {
  const outcome = await authenticate(auth, request.headers['authorization']);
  if (!outcome.authenticated) {
    return {
      ok: false,
      result: { status: REFUSAL_STATUS.unauthenticated, body: { error: outcome.refusal, message: 'The request was refused.' } },
    };
  }
  return { ok: true, principal: outcome.principal };
}

/** The repository context for an authenticated principal, or the refusal. */
export function contextForPrincipal(
  auth: AuthDeps,
  principal: AuthenticatedPrincipal,
): { readonly ok: true; readonly context: RepositoryContext } | { readonly ok: false; readonly result: RouteResult } {
  const scoped = scopeForPrincipal(principal);
  if (!scoped.authorized) {
    return {
      ok: false,
      result: { status: REFUSAL_STATUS.unauthenticated, body: { status: 'refused', reason: scoped.refusal } },
    };
  }
  return { ok: true, context: contextFor(scoped.scope, auth.db) };
}

/**
 * One shape for every command answer.
 *
 * A refusal is 409 rather than 400: the request was well formed and the server
 * understood it; the state of the world is what refused. `client_upgrade_required` is
 * 426, which is the one refusal that tells a person to go and do something about the
 * client rather than about the data.
 */
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

/**
 * Parse, run inside a command receipt, and reply.
 *
 * `kind` is the command kind recorded on the receipt, and the payload hash is taken over
 * the parsed body minus the envelope, so two commands that differ only in their client
 * version are the same payload and a replay of one is a replay of the other.
 */
export async function runRouteCommand<Schema extends z.ZodType<{ commandId: string; clientVersion: string }>, T>(
  deps: RouteDeps,
  schema: Schema,
  kind: string,
  work: (context: RepositoryContext, body: z.infer<Schema>) => Promise<CommandResult<T>>,
): Promise<RouteResult> {
  const parsed = schema.safeParse(deps.request.body);
  if (!parsed.success) return { status: REFUSAL_STATUS.malformed_body, body: redactError('malformed_body') };
  const body = parsed.data;

  const { commandId, clientVersion, ...payload } = body as { commandId: string; clientVersion: string };
  const outcome = await runCommand(deps.auth, deps.principal, { commandId, kind, payload, clientVersion }, async context => {
    const result = await work(context, body);
    if (result.ok) return { status: 'accepted', result: result.value ?? null };
    return { status: 'refused', reason: result.reason ?? 'refused' };
  });
  return commandReply(outcome);
}
