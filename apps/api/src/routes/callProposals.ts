import {
  applyCallProposalsCommandSchema,
  declineCallProposalsCommandSchema,
  dismissPendingCallCommandSchema,
  proposalAcceptanceResponseSchema,
  resolveStageReviewCommandSchema,
  reviewListResponseSchema,
} from '@fss/contracts';
import { dismissPendingHold } from '@fss/domain/calls/pendingHold.ts';
import { applyCallProposals } from '@fss/domain/calls/proposalApply.ts';
import { declineCallProposals, readProposalAcceptance } from '@fss/domain/calls/proposalMeasure.ts';
import { readNeedsReview, resolveStageReviewItem } from '@fss/domain/calls/needsReview.ts';
import { readCallingProvider } from '@fss/domain/settings/integrations.ts';
import { REFUSAL_STATUS, redactError } from '../limits.ts';
import { policyRouteDeps, runPolicyCommand } from './dialSupport.ts';
import { contextForPrincipal } from './routeSupport.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * Applying a post-call analysis (slice 3a, lane B).
 *
 *   * `POST /calls/proposals/apply` — David's first-time click: the selected keys of the
 *     analysis he saw, checked under the analysis lock for freshness and the first-time
 *     rules, then each through its existing command, in one transaction
 *     (`calls/proposalApply.ts`). A command with a receipt: a retry with the same id is
 *     answered from it.
 *   * `POST /calls/pending/dismiss` — release a call's pending-review hold without logging
 *     it (`calls/pendingHold.ts`).
 *   * `POST /calls/proposals/decline` — the measurement only: these suggestions were declined
 *     (`calls/proposalMeasure.ts`). A declined proposal stays applicable.
 *   * `GET /calls/proposals/acceptance` — the shadow measurement, per action type.
 *   * `GET /review` — Needs review: pending holds open three hours, undecided review
 *     suggestions, open stage review items (`calls/needsReview.ts`).
 *   * `POST /review/stage/resolve` — a stage review item, resolved by id, audited.
 *
 * The `/calls/...` paths are 404 unless the workspace's `calling_provider` is `twilio`, like
 * the analysis read beside them; Needs review is not, because stage items come from meetings
 * too. Every refusal is a 409 carrying its code.
 */

export const CALL_PROPOSAL_PATHS: readonly string[] = [
  '/calls/proposals/apply',
  '/calls/proposals/decline',
  '/calls/proposals/acceptance',
  '/calls/pending/dismiss',
  '/review',
  '/review/stage/resolve',
];

export async function routeCallProposals(request: ApiRequest, options: RoutingOptions): Promise<RouteResult | null> {
  if (!CALL_PROPOSAL_PATHS.includes(request.path)) return null;
  const prepared = await policyRouteDeps(request, options);
  if (!prepared.ok) return prepared.result;
  const deps = prepared.deps;
  const read = request.path === '/calls/proposals/acceptance' || request.path === '/review';
  if (request.method !== (read ? 'GET' : 'POST')) {
    return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
  }
  const scoped = contextForPrincipal(deps.auth, deps.principal);
  if (!scoped.ok) return scoped.result;
  if (request.path === '/review') return { status: 200, body: reviewListResponseSchema.parse(await readNeedsReview(scoped.context)) };
  if (request.path === '/review/stage/resolve') {
    return await runPolicyCommand(deps, resolveStageReviewCommandSchema, 'review_stage_resolve', async (context, body) =>
      await resolveStageReviewItem(context, { itemId: body.itemId }),
    );
  }
  if ((await readCallingProvider(scoped.context)) !== 'twilio') {
    return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
  }
  if (read) return { status: 200, body: proposalAcceptanceResponseSchema.parse(await readProposalAcceptance(scoped.context)) };

  if (request.path === '/calls/proposals/decline') {
    return await runPolicyCommand(deps, declineCallProposalsCommandSchema, 'call_proposals_decline', async (context, body) =>
      await declineCallProposals(context, { analysisId: body.analysisId, proposalHash: body.proposalHash, keys: body.keys }),
    );
  }

  if (request.path === '/calls/pending/dismiss') {
    return await runPolicyCommand(deps, dismissPendingCallCommandSchema, 'call_pending_dismiss', async (context, body) =>
      await dismissPendingHold(context, { callSessionId: body.callSessionId }),
    );
  }
  return await runPolicyCommand(deps, applyCallProposalsCommandSchema, 'call_proposals_apply', async (context, body) =>
    await applyCallProposals(context, {
      analysisId: body.analysisId,
      transcriptSha256: body.transcriptSha256,
      proposalHash: body.proposalHash,
      keys: body.keys,
      ...(body.edits === undefined ? {} : { edits: body.edits }),
      commandId: body.commandId,
      journal: deps.journal,
    }),
  );
}
