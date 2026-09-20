import {
  changeStageCommandSchema,
  openOpportunityCommandSchema,
  reopenOpportunityCommandSchema,
  setManualCommandSchema,
} from '@fss/contracts';
import { changeStage, openOpportunity, reopenOpportunity, setManualControlMode } from '@fss/domain/crm';
import { REFUSAL_STATUS, contextForPrincipal, redactError, requirePrincipal, runCrmCommand } from './crmSupport.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * Opportunity commands (specification 7.3, 8.1, Appendix A "Stage change").
 *
 * Four commands and no reads: an opportunity is never read on its own, because
 * Appendix F's visibility is the firm's and the firm read already carries the stage,
 * the status and the control mode. An endpoint that answered "here is opportunity X"
 * would be a second place to get the read matrix wrong.
 *
 * `/opportunities/reopen` is separate from `/opportunities/open` on purpose. Section
 * 8.1 calls reopening "an explicit command", and giving it its own path is what makes
 * it explicit in the client too — there is no way to reopen by accident by posting an
 * open with the wrong firm id.
 */
export async function routeOpportunities(request: ApiRequest, options: RoutingOptions): Promise<RouteResult | null> {
  if (!request.path.startsWith('/opportunities')) return null;
  const auth = options.auth;
  if (auth === undefined) return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };

  const authenticated = await requirePrincipal(auth, request);
  if (!authenticated.ok) return authenticated.result;
  const principal = authenticated.principal;
  const scoped = contextForPrincipal(auth, principal);
  if (!scoped.ok) return scoped.result;
  const deps = { auth, request, principal };

  if (request.method !== 'POST') {
    return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
  }

  switch (request.path) {
    case '/opportunities/open':
      return await runCrmCommand(deps, openOpportunityCommandSchema, 'opportunity.opened', async (repository, body) =>
        await openOpportunity(repository, { firmId: body.firmId, stageKey: body.stageKey }),
      );
    case '/opportunities/stage':
      return await runCrmCommand(deps, changeStageCommandSchema, 'opportunity.stage_changed', async (repository, body) =>
        await changeStage(repository, {
          opportunityId: body.opportunityId,
          toStageKey: body.toStageKey,
          reason: body.reason,
          commandId: body.commandId,
        }),
      );
    case '/opportunities/reopen':
      return await runCrmCommand(deps, reopenOpportunityCommandSchema, 'opportunity.reopened', async (repository, body) =>
        await reopenOpportunity(repository, {
          firmId: body.firmId,
          reason: body.reason,
          commandId: body.commandId,
        }),
      );
    case '/opportunities/manual':
      return await runCrmCommand(deps, setManualCommandSchema, 'opportunity.manual', async (repository, body) =>
        await setManualControlMode(repository, {
          opportunityId: body.opportunityId,
          reason: body.reason,
          commandId: body.commandId,
        }),
      );
    default:
      return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
  }
}
