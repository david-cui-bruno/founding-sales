import {
  createPipelineStageCommandSchema,
  renamePipelineStageCommandSchema,
  reorderPipelineStagesCommandSchema,
  retirePipelineStageCommandSchema,
} from '@fss/contracts';
import { readPipelineBoardForActor } from '@fss/domain/crm/board.ts';
import { listPipelineStages } from '@fss/domain/crm/pipeline.ts';
import {
  createPipelineStage,
  renamePipelineStage,
  reorderPipelineStages,
  retirePipelineStage,
} from '@fss/domain/crm/stageAdmin.ts';
import { REFUSAL_STATUS, redactError } from '../limits.ts';
import { policyRouteDeps, runPolicyCommand } from './dialSupport.ts';
import { contextForPrincipal, requirePrincipal } from './routeSupport.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * The pipeline: its shape, its board, and its administration
 * (specification 7.2, 8.1, Appendix F).
 *
 * `GET /pipeline/stages` is a read for every active member: a stage list is not
 * business data about a prospect, and every card in the client needs it to show a
 * stage name. Retired stages are included and say so, because a historical
 * opportunity may still sit in one and a client that dropped it would render a blank.
 *
 * `POST /pipeline/board` answers the gap recorded in
 * `docs/decisions/g6-pipeline-board-opportunity-ids.md`: one scoped read that carries
 * the open opportunity id for the firms the caller could actually change, so the
 * board can offer a stage control where one would work and G3b's
 * `stage-change-unavailable` everywhere else. One read rather than one per column,
 * because N firm-page reads would also be N access audit events for an admin (5.2).
 *
 * The four commands are 8.1's four verbs. Admin-only, refused by the domain command
 * under the stage's row lock rather than by a check here, and every one of them
 * refuses a terminal stage.
 */
export const PIPELINE_PATHS: readonly string[] = [
  '/pipeline/stages',
  '/pipeline/stages/create',
  '/pipeline/stages/rename',
  '/pipeline/stages/reorder',
  '/pipeline/stages/retire',
  '/pipeline/board',
];

export async function routePipeline(request: ApiRequest, options: RoutingOptions): Promise<RouteResult | null> {
  if (!PIPELINE_PATHS.includes(request.path)) return null;
  const auth = options.auth;
  if (auth === undefined) return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };

  if (request.path === '/pipeline/stages') {
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

  if (request.method !== 'POST') {
    return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
  }

  const prepared = await policyRouteDeps(request, options);
  if (!prepared.ok) return prepared.result;
  const deps = prepared.deps;

  if (request.path === '/pipeline/board') {
    const scoped = contextForPrincipal(deps.auth, deps.principal);
    if (!scoped.ok) return scoped.result;
    return { status: 200, body: await readPipelineBoardForActor(scoped.context) };
  }

  switch (request.path) {
    case '/pipeline/stages/create':
      return await runPolicyCommand(
        deps,
        createPipelineStageCommandSchema,
        'create_pipeline_stage',
        async (repository, body) =>
          await createPipelineStage(repository, {
            key: body.key,
            displayName: body.displayName,
            ...(body.position === undefined ? {} : { position: body.position }),
            commandId: body.commandId,
          }),
      );
    case '/pipeline/stages/rename':
      return await runPolicyCommand(
        deps,
        renamePipelineStageCommandSchema,
        'rename_pipeline_stage',
        async (repository, body) =>
          await renamePipelineStage(repository, {
            stageKey: body.stageKey,
            displayName: body.displayName,
            commandId: body.commandId,
          }),
      );
    case '/pipeline/stages/reorder':
      return await runPolicyCommand(
        deps,
        reorderPipelineStagesCommandSchema,
        'reorder_pipeline_stages',
        async (repository, body) =>
          await reorderPipelineStages(repository, { stageKeys: body.stageKeys, commandId: body.commandId }),
      );
    case '/pipeline/stages/retire':
      return await runPolicyCommand(
        deps,
        retirePipelineStageCommandSchema,
        'retire_pipeline_stage',
        async (repository, body) =>
          await retirePipelineStage(repository, { stageKey: body.stageKey, commandId: body.commandId }),
      );
    default:
      return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
  }
}
