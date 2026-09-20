import { openPauseCommandSchema, releasePauseCommandSchema } from '@fss/contracts';
import { listPauses, openPause, releasePause } from '@fss/domain/policy';
import { REFUSAL_STATUS, contextForPrincipal, policyRouteDeps, redactError, runPolicyCommand } from './dialSupport.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * Administrative pauses (specification 10.1, 4.3).
 *
 * A pause is a reversible scoped hold with history, never a suppression and never a
 * terminal stop. Opening one is admin-only and so is releasing it; the refusal comes
 * from the domain command rather than from a check here, because that is the one
 * place it is made in the same transaction as the write.
 *
 * The list is readable by any authenticated member: a salesperson whose work is
 * refused with `scoped_pause` should be able to see the pause that did it.
 */
export async function routePauses(request: ApiRequest, options: RoutingOptions): Promise<RouteResult | null> {
  if (!request.path.startsWith('/pauses')) return null;
  const prepared = await policyRouteDeps(request, options);
  if (!prepared.ok) return prepared.result;
  const deps = prepared.deps;

  if (request.method === 'GET' && request.path === '/pauses') {
    const scoped = contextForPrincipal(deps.auth, deps.principal);
    if (!scoped.ok) return scoped.result;
    return {
      status: 200,
      body: { pauses: await listPauses(scoped.context, { openOnly: request.query.get('open') === 'true' }) },
    };
  }

  if (request.method !== 'POST') {
    return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
  }

  switch (request.path) {
    case '/pauses/open':
      return await runPolicyCommand(deps, openPauseCommandSchema, 'open_pause', async (repository, body) =>
        await openPause(repository, {
          scopeKind: body.scopeKind,
          ...(body.scopeKey === undefined ? {} : { scopeKey: body.scopeKey }),
          ...(body.channel === undefined ? {} : { channel: body.channel }),
          ...(body.reasonNote === undefined ? {} : { reasonNote: body.reasonNote }),
          commandId: body.commandId,
        }),
      );
    case '/pauses/release':
      return await runPolicyCommand(deps, releasePauseCommandSchema, 'release_pause', async (repository, body) =>
        await releasePause(repository, { pauseId: body.pauseId }),
      );
    default:
      return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
  }
}
