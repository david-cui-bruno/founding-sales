import type { z } from 'zod';
import type { RepositoryContext } from '@fss/domain/db';
import type { SuppressionJournal } from '@fss/domain/suppression';
import { SuppressionJournalError } from '@fss/domain/suppression';
import { runCommand } from '../auth/index.ts';
import type { AuthDeps, AuthenticatedPrincipal } from '../auth/index.ts';
import { REFUSAL_STATUS, contextForPrincipal, crmReply, redactError, requirePrincipal } from './crmSupport.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * What the six policy, suppression and dialing route modules share.
 *
 * It is a near-twin of `crmSupport.ts`, and deliberately not an edit to it: the CRM
 * helper's `work` is typed to `CrmResult`, whose refusal codes are the CRM's closed
 * set, and this lane answers with three other closed sets. Widening the CRM helper
 * to `string` would have thrown away the thing that makes it useful.
 *
 * Everything else is the same discipline. Every mutation goes through `runCommand`,
 * so the receipt, the payload hash, the device and the mutation commit in one
 * transaction (5.3). No route decides whether a caller is the assignee — the domain
 * command does, under the firm's row lock.
 */

export interface PolicyRouteDeps {
  readonly auth: AuthDeps;
  readonly request: ApiRequest;
  readonly principal: AuthenticatedPrincipal;
  /** The journal every suppression write goes through before its row (10.2). */
  readonly journal: SuppressionJournal;
}

/** The outcome shape every domain command in this lane answers with. */
export interface LaneResult<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly reason?: string;
}

/**
 * Authenticate, scope, and give the caller everything a command needs, or the
 * refusal to return.
 */
export async function policyRouteDeps(
  request: ApiRequest,
  options: RoutingOptions,
): Promise<{ readonly ok: true; readonly deps: PolicyRouteDeps } | { readonly ok: false; readonly result: RouteResult }> {
  const auth = options.auth;
  if (auth === undefined) return { ok: false, result: { status: REFUSAL_STATUS.not_found, body: redactError('not_found') } };

  const authenticated = await requirePrincipal(auth, request);
  if (!authenticated.ok) return { ok: false, result: authenticated.result };
  const scoped = contextForPrincipal(auth, authenticated.principal);
  if (!scoped.ok) return { ok: false, result: scoped.result };

  return {
    ok: true,
    deps: { auth, request, principal: authenticated.principal, journal: options.suppressionJournal },
  };
}

/**
 * Parse, run and reply.
 *
 * The one thing it adds over the CRM's version is the journal branch. A lost journal
 * write is an infrastructure fault, not a business refusal: recording it as a refused
 * receipt would burn the command id, and the client's retry after the bucket came
 * back would be answered from the cached refusal forever. So it propagates out of
 * `runCommand`, which rolls the receipt back with the mutation, and the caller gets a
 * 503 and a free command id. Specification 10.2: "A lost journal write fails the
 * command."
 */
export async function runPolicyCommand<Schema extends z.ZodType<{ commandId: string; clientVersion: string }>, T>(
  deps: PolicyRouteDeps,
  schema: Schema,
  kind: string,
  work: (context: RepositoryContext, body: z.infer<Schema>) => Promise<LaneResult<T>>,
): Promise<RouteResult> {
  const parsed = schema.safeParse(deps.request.body);
  if (!parsed.success) return { status: REFUSAL_STATUS.malformed_body, body: redactError('malformed_body') };
  const body = parsed.data;

  const { commandId, clientVersion, ...payload } = body as { commandId: string; clientVersion: string };
  try {
    const outcome = await runCommand(deps.auth, deps.principal, { commandId, kind, payload, clientVersion }, async context => {
      const result = await work(context, body);
      if (result.ok) return { status: 'accepted', result: result.value ?? null };
      return { status: 'refused', reason: result.reason ?? 'refused' };
    });
    return crmReply(outcome);
  } catch (error) {
    if (error instanceof SuppressionJournalError) {
      // Written out rather than added to `REFUSAL_CODES`: that set is the shared
      // envelope vocabulary every route uses, and this is one endpoint family's
      // dependency being down. The shape matches `redactError`'s so a client parses
      // one thing.
      return {
        status: 503,
        body: { error: 'journal_unavailable', message: 'The suppression record could not be made durable.' },
      };
    }
    throw error;
  }
}

export { REFUSAL_STATUS, contextForPrincipal, crmReply, redactError, requirePrincipal };
export type { ApiRequest, RouteResult, RoutingOptions };
