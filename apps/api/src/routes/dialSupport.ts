import type { z } from 'zod';
import type { RepositoryContext } from '@fss/domain/db/workspaceScope.ts';
import type { SuppressionJournal } from '@fss/domain/suppression/journal.ts';
import { SuppressionJournalError } from '@fss/domain/suppression/journal.ts';
import { REFUSAL_STATUS, redactError } from '../limits.ts';
import { contextForPrincipal, requirePrincipal, runRouteCommand, type CommandResult, type RouteDeps } from './routeSupport.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * What the policy, suppression, dialing, sequence and settings route modules share: the
 * route deps with the suppression journal, and the one branch `runRouteCommand` does not
 * take.
 */

export interface PolicyRouteDeps extends RouteDeps {
  /** The journal every suppression write goes through before its row (10.2). */
  readonly journal: SuppressionJournal;
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
 * `runRouteCommand`, plus the journal branch.
 *
 * A lost journal write is an infrastructure fault, not a business refusal: recording it
 * as a refused receipt would burn the command id, and the client's retry after the
 * bucket came back would be answered from the cached refusal forever. So it propagates
 * out of `runCommand`, which rolls the receipt back with the mutation, and the caller
 * gets a 503 and a free command id. Specification 10.2: "A lost journal write fails the
 * command."
 */
export async function runPolicyCommand<Schema extends z.ZodType<{ commandId: string; clientVersion: string }>, T>(
  deps: PolicyRouteDeps,
  schema: Schema,
  kind: string,
  work: (context: RepositoryContext, body: z.infer<Schema>) => Promise<CommandResult<T>>,
): Promise<RouteResult> {
  try {
    return await runRouteCommand(deps, schema, kind, work);
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
