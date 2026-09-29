import {
  changeStageCommandSchema,
  classifyControlModeOriginCommandSchema,
  keepFollowingUpCommandSchema,
  openOpportunityCommandSchema,
  takeOverOpportunityCommandSchema,
} from '@fss/contracts';
import {
  changeStage,
  classifyControlModeOrigin,
  keepFollowingUpAfterDirectSend,
  openOpportunity,
  takeOverOpportunity,
} from '@fss/domain/crm/pipeline.ts';
import { REFUSAL_STATUS, redactError } from '../limits.ts';
import { contextForPrincipal, requirePrincipal, runRouteCommand } from './routeSupport.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * Opportunity commands (specification 7.3, 8.1, Appendix A "Stage change").
 *
 * Two commands and no reads: an opportunity is never read on its own, because
 * Appendix F's visibility is the firm's and the firm read already carries the stage,
 * the status and the control mode. An endpoint that answered "here is opportunity X"
 * would be a second place to get the read matrix wrong. (`/opportunities/reopen` and
 * `/opportunities/manual` had no caller and went in wave 2, S6.)
 *
 * `/opportunities/manual` came back with migration 0025, and for a reason wave 2 did not
 * have: the eligibility gate now distinguishes a prospect's signal from a person's
 * decision, so the explicit takeover has to be writable by a person (P1-1 of the GPT-6
 * review of PR 332). Two neighbours come with it — the choice to keep the follow-up
 * automation running after a direct Gmail send, and an administrator's classification of
 * one pre-0025 manual mode whose origin is NULL. All three authorize in the domain,
 * under the firm row lock, inside the command transaction.
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
      return await runRouteCommand(deps, openOpportunityCommandSchema, 'opportunity.opened', async (repository, body) =>
        await openOpportunity(repository, { firmId: body.firmId, stageKey: body.stageKey }),
      );
    case '/opportunities/stage':
      return await runRouteCommand(deps, changeStageCommandSchema, 'opportunity.stage_changed', async (repository, body) =>
        await changeStage(repository, {
          opportunityId: body.opportunityId,
          toStageKey: body.toStageKey,
          reason: body.reason,
          commandId: body.commandId,
        }),
      );
    case '/opportunities/manual':
      return await runRouteCommand(deps, takeOverOpportunityCommandSchema, 'opportunity.manual', async (repository, body) =>
        await takeOverOpportunity(repository, {
          opportunityId: body.opportunityId,
          reason: body.reason,
          commandId: body.commandId,
        }),
      );
    case '/opportunities/keep-following-up':
      return await runRouteCommand(deps, keepFollowingUpCommandSchema, 'opportunity.manual', async (repository, body) =>
        await keepFollowingUpAfterDirectSend(repository, {
          opportunityId: body.opportunityId,
          reason: body.reason,
          commandId: body.commandId,
        }),
      );
    case '/opportunities/control-mode-origin':
      return await runRouteCommand(deps, classifyControlModeOriginCommandSchema, 'opportunity.manual', async (repository, body) =>
        await classifyControlModeOrigin(repository, {
          opportunityId: body.opportunityId,
          origin: body.origin,
          reason: body.reason,
          commandId: body.commandId,
        }),
      );
    default:
      return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
  }
}
