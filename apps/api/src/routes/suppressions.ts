import {
  correctSuppressionCommandSchema,
  recordSuppressionCommandSchema,
  supersedeSuppressionCommandSchema,
} from '@fss/contracts';
import { listEffectiveSuppressions } from '@fss/domain/suppression/effective.ts';
import { recordAdminSupersession, recordCorrection, recordSuppression } from '@fss/domain/suppression/events.ts';
import { REFUSAL_STATUS, redactError } from '../limits.ts';
import { policyRouteDeps, runPolicyCommand } from './dialSupport.ts';
import { contextForPrincipal } from './routeSupport.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * The exact paths this module owns, for G5b's route registry.
 *
 * Exact rather than a `/suppressions` prefix: the registry refuses two claims on one
 * path, and that guarantee is only as sharp as the claim. The `startsWith` guard
 * in the router below is redundant for a mounted request and kept because the
 * router is also called directly, by tests and by `route`.
 */
export const SUPPRESSION_PATHS: readonly string[] = [
  '/suppressions',
  '/suppressions/record',
  '/suppressions/correct',
  '/suppressions/supersede',
];

/**
 * The suppression surface (specification 10.2, 14.1, Appendix A).
 *
 * The one durable way to record a manual stop request that did not arrive by Gmail, a
 * confirmed reply or a logged call, and to correct or supersede one. Wave 2 (S6)
 * deleted it for having no caller; the batch review restored it before release. The
 * Mac gets controls for it later.
 *
 * Three writes and one read. The writes are `record`, `correct` and `supersede`,
 * which are the only three things 10.2 permits: there is no delete, no update and
 * no "undo", because `suppression_events` has UPDATE and DELETE revoked from the
 * application role and an endpoint that pretended otherwise would be a lie with a
 * 500 behind it.
 *
 * Every write carries the journal through `runPolicyCommand`, and the journal write
 * happens inside the command transaction and before the row. A lost journal write
 * leaves the command id free and answers 503, rather than recording a refusal the
 * client would replay forever.
 *
 * The read returns the effective set for the workspace and is not narrowed to the
 * caller's assigned firms: a handle suppression is workspace-wide (10.2), and a
 * salesperson who could not see one would re-add the number they were told to stop
 * calling.
 */
export async function routeSuppressions(request: ApiRequest, options: RoutingOptions): Promise<RouteResult | null> {
  if (!request.path.startsWith('/suppressions')) return null;
  const prepared = await policyRouteDeps(request, options);
  if (!prepared.ok) return prepared.result;
  const deps = prepared.deps;

  if (request.method === 'GET' && request.path === '/suppressions') {
    const scoped = contextForPrincipal(deps.auth, deps.principal);
    if (!scoped.ok) return scoped.result;
    return { status: 200, body: { suppressions: await listEffectiveSuppressions(scoped.context, { limit: 200 }) } };
  }

  if (request.method !== 'POST') {
    return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
  }

  switch (request.path) {
    case '/suppressions/record':
      return await runPolicyCommand(
        deps,
        recordSuppressionCommandSchema,
        'record_suppression',
        async (repository, body) =>
          await recordSuppression(repository, {
            scope: body.scope,
            ...(body.firmId === undefined ? {} : { firmId: body.firmId }),
            ...(body.value === undefined ? {} : { value: body.value }),
            source: body.source,
            commandId: body.commandId,
            journal: deps.journal,
          }),
      );
    case '/suppressions/correct':
      return await runPolicyCommand(
        deps,
        correctSuppressionCommandSchema,
        'correct_suppression',
        async (repository, body) =>
          await recordCorrection(repository, {
            eventId: body.eventId,
            commandId: body.commandId,
            journal: deps.journal,
          }),
      );
    case '/suppressions/supersede':
      return await runPolicyCommand(
        deps,
        supersedeSuppressionCommandSchema,
        'supersede_suppression',
        async (repository, body) =>
          await recordAdminSupersession(repository, {
            eventId: body.eventId,
            reason: body.reason,
            commandId: body.commandId,
            journal: deps.journal,
          }),
      );
    default:
      return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
  }
}
