import { listPipelineStages } from '@fss/domain/crm';
import { REFUSAL_STATUS, contextForPrincipal, redactError, requirePrincipal } from './crmSupport.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * The pipeline's shape (specification 7.2, 8.1).
 *
 * "ordered configurable rows; default New, Contacting, Engaged, Qualified, Proposal,
 * Won, and Lost. Retired stages remain readable."
 *
 * A read, for every active member: a stage list is not business data about a
 * prospect, and every card in the client needs it to show a stage name. Retired
 * stages are included and say so, because a historical opportunity may still sit in
 * one and a client that dropped it would render a blank.
 *
 * Renaming, reordering, adding and retiring stages is an admin command, and it is
 * lane G3b's: it belongs with the configuration surface rather than with the schema.
 * What this lane fixes is the table, the seeded default, the terminal-kind
 * constraints and this read.
 */
export async function routePipeline(request: ApiRequest, options: RoutingOptions): Promise<RouteResult | null> {
  if (request.path !== '/pipeline/stages') return null;
  const auth = options.auth;
  if (auth === undefined) return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
  }

  const authenticated = await requirePrincipal(auth, request);
  if (!authenticated.ok) return authenticated.result;
  const scoped = contextForPrincipal(auth, authenticated.principal);
  if (!scoped.ok) return scoped.result;

  const stages = await listPipelineStages(scoped.context);
  return {
    status: 200,
    body: {
      stages: stages.map(stage => ({
        id: stage.id,
        key: stage.key,
        displayName: stage.display_name,
        position: stage.position,
        terminalKind: stage.terminal_kind,
        retired: stage.retired,
      })),
    },
  };
}
