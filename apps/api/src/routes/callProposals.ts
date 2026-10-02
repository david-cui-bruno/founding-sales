import { applyCallProposalsCommandSchema, dismissPendingCallCommandSchema } from '@fss/contracts';
import { dismissPendingHold } from '@fss/domain/calls/pendingHold.ts';
import { applyCallProposals } from '@fss/domain/calls/proposalApply.ts';
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
 *
 * Both are 404 unless the workspace's `calling_provider` is `twilio`, like the analysis
 * read beside them. Every refusal is a 409 carrying its code.
 */

export const CALL_PROPOSAL_PATHS: readonly string[] = ['/calls/proposals/apply', '/calls/pending/dismiss'];

export async function routeCallProposals(request: ApiRequest, options: RoutingOptions): Promise<RouteResult | null> {
  if (!CALL_PROPOSAL_PATHS.includes(request.path)) return null;
  const prepared = await policyRouteDeps(request, options);
  if (!prepared.ok) return prepared.result;
  const deps = prepared.deps;
  if (request.method !== 'POST') return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
  const scoped = contextForPrincipal(deps.auth, deps.principal);
  if (!scoped.ok) return scoped.result;
  if ((await readCallingProvider(scoped.context)) !== 'twilio') {
    return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
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
