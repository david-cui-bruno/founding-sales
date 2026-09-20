import type { z } from 'zod';
import type { CrmResult } from '@fss/domain/crm';
import type { RepositoryContext } from '@fss/domain/db';
import { authenticate, runCommand } from '../auth/index.ts';
import type { AuthDeps, AuthenticatedPrincipal } from '../auth/index.ts';
import { contextFor, scopeForPrincipal } from '../scope.ts';
import { REFUSAL_STATUS, redactError } from '../limits.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * What the four CRM route modules share.
 *
 * Every CRM mutation is a `runCommand` (5.3): the receipt, the payload hash, the
 * device and the mutation commit in one transaction, and a replay returns the
 * original result. No route here writes a receipt itself, and no route decides
 * whether a caller is the assignee — the domain command does, under the firm's row
 * lock, which is the only place that decision is safe (Appendix G 7).
 *
 * So a route is three lines of work: parse the body against its schema, call the
 * command inside `runCommand`, and turn the `CrmResult` into a reply.
 */

export interface CrmRouteDeps {
  readonly auth: AuthDeps;
  readonly request: ApiRequest;
  readonly principal: AuthenticatedPrincipal;
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
 * One shape for every CRM command answer.
 *
 * A refusal is 409 rather than 400: the request was well formed and the server
 * understood it; the state of the world is what refused. `client_upgrade_required` is
 * 426, which is the one refusal that tells a person to go and do something about the
 * client rather than about the data.
 */
export function crmReply(outcome: {
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
 * Parse, run and reply.
 *
 * `kind` is the command kind recorded on the receipt, and `payloadOf` is what the
 * payload hash is taken over — the parsed body minus the envelope, so two commands
 * that differ only in their client version are the same payload and a replay of one
 * is a replay of the other.
 */
export async function runCrmCommand<Schema extends z.ZodType<{ commandId: string; clientVersion: string }>, T>(
  deps: CrmRouteDeps,
  schema: Schema,
  kind: string,
  work: (context: RepositoryContext, body: z.infer<Schema>) => Promise<CrmResult<T>>,
): Promise<RouteResult> {
  const parsed = schema.safeParse(deps.request.body);
  if (!parsed.success) return { status: REFUSAL_STATUS.malformed_body, body: redactError('malformed_body') };
  const body = parsed.data;

  const { commandId, clientVersion, ...payload } = body as { commandId: string; clientVersion: string };
  const outcome = await runCommand(deps.auth, deps.principal, { commandId, kind, payload, clientVersion }, async context => {
    const result = await work(context, body);
    if (result.ok) return { status: 'accepted', result: result.value };
    return { status: 'refused', reason: result.reason };
  });
  return crmReply(outcome);
}

export { REFUSAL_STATUS, redactError };
export type { RouteResult, RoutingOptions, ApiRequest };
