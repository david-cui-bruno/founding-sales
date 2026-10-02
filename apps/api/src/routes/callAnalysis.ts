import { callAnalysisResponseSchema, editCallAnalysisCommandSchema, retryCallAnalysisCommandSchema, uuid } from '@fss/contracts';
import { editCallAnalysis, readCallAnalysis } from '@fss/domain/calls/analysis.ts';
import { requestCallAnalysis } from '@fss/domain/calls/analysisPaid.ts';
import { readCallingProvider } from '@fss/domain/settings/integrations.ts';
import { REFUSAL_STATUS, redactError } from '../limits.ts';
import { policyRouteDeps, runPolicyCommand } from './dialSupport.ts';
import { contextForPrincipal } from './routeSupport.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * A call's post-call analysis (slice 3a).
 *
 *   * `GET /calls/analysis?callSessionId=` — every version of the call's analysis, its
 *     current notes (David's latest edit, otherwise the latest completed model reading) and
 *     its authoritative model version, `{ analysisId, transcriptSha256, proposalHash,
 *     proposals }` among it, which an Apply echoes (`calls/analysis.ts`).
 *   * `POST /calls/analysis/edit` — David's notes as a new user version, a command with a
 *     receipt; answers the read above.
 *   * `POST /calls/analysis/retry` — queue one `call.analyze` for the call (A2), reason
 *     `retry` or `reanalysis`; a historical call is analysed only for `reanalysis`.
 *
 * Both are 404 unless the workspace's `calling_provider` is `twilio`, like the transcript
 * read they sit beside, and 404 for a call of a firm that is not the caller's, exactly like
 * an unknown one.
 */

export const CALL_ANALYSIS_PATHS: readonly string[] = ['/calls/analysis', '/calls/analysis/edit', '/calls/analysis/retry'];

export async function routeCallAnalysis(request: ApiRequest, options: RoutingOptions): Promise<RouteResult | null> {
  if (!CALL_ANALYSIS_PATHS.includes(request.path)) return null;
  const prepared = await policyRouteDeps(request, options);
  if (!prepared.ok) return prepared.result;
  const deps = prepared.deps;
  if (request.method !== (request.path === '/calls/analysis' ? 'GET' : 'POST')) {
    return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
  }
  const scoped = contextForPrincipal(deps.auth, deps.principal);
  if (!scoped.ok) return scoped.result;
  const notFound: RouteResult = { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
  if ((await readCallingProvider(scoped.context)) !== 'twilio') return notFound;

  if (request.path === '/calls/analysis') {
    const parsed = uuid.safeParse(request.query.get('callSessionId') ?? '');
    if (!parsed.success) return { status: REFUSAL_STATUS.malformed_body, body: redactError('malformed_body') };
    const analysis = await readCallAnalysis(scoped.context, parsed.data);
    if (analysis === null) return notFound;
    return { status: 200, body: callAnalysisResponseSchema.parse(analysis) };
  }

  if (request.path === '/calls/analysis/retry') {
    return await runPolicyCommand(deps, retryCallAnalysisCommandSchema, 'call_analysis_retry', async (context, body) =>
      await requestCallAnalysis(context, { sessionId: body.callSessionId, reason: body.reason, commandId: body.commandId }),
    );
  }

  return await runPolicyCommand(deps, editCallAnalysisCommandSchema, 'call_analysis_edit', async (context, body) =>
    await editCallAnalysis(context, { sessionId: body.callSessionId, notes: body.notes }),
  );
}
