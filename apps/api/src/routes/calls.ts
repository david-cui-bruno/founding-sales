import { callFollowUpCommandSchema, followUpPreviewRequestSchema, logCallOutcomeCommandSchema } from '@fss/contracts';
import { decideFirmRead } from '@fss/domain/crm/authorization.ts';
import { readFirm } from '@fss/domain/crm/firms.ts';
import { listCallLogs, logCallOutcome, recordCallFollowUp } from '@fss/domain/dial/calls.ts';
import { previewFollowUp } from '@fss/domain/dial/followUpPreview.ts';
import { REFUSAL_STATUS, redactError } from '../limits.ts';
import { policyRouteDeps, runPolicyCommand } from './dialSupport.ts';
import { contextForPrincipal } from './routeSupport.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * The exact paths this module owns, for G5b's route registry.
 *
 * Exact rather than a `/calls` prefix: the registry refuses two claims on one
 * path, and that guarantee is only as sharp as the claim. The `startsWith` guard
 * in the router below is redundant for a mounted request and kept because the
 * router is also called directly, by tests and by `route`.
 */
export const CALL_PATHS: readonly string[] = [
  '/calls',
  '/calls/log',
  '/calls/follow-up-preview',
  '/calls/follow-up',
];

/**
 * Call logging (specification 9.1, Appendix A "Log call outcome", Appendix F).
 *
 * "Call logging always records what occurred, even if no valid ticket exists; it
 * never refuses history." The ticket, the route and the calling identity are all
 * optional in the schema for exactly that reason. What is not optional is who may
 * write onto whose firm: that is the CRM's usual assignment rule, decided by the
 * domain command under the firm's row lock.
 *
 * The body may name the Today task the call was placed from (`itemId`),
 * and the domain applies the outcome to the step or callback behind it; `occurredAt`
 * may be omitted for "just now", which is then the database's clock. The accepted
 * result carries `followUps` — what the call still needs from a person, such as a
 * callback time — rather than a refusal of the history.
 *
 * The read redacts. Appendix F's first row makes "call outcomes without notes"
 * visible to any active member and the note visible only to the assigned
 * salesperson and admins, so the note is dropped for everyone else — decided by the
 * same `decideFirmRead` the CRM's firm read uses, through the firm the log belongs
 * to, so the two cannot disagree.
 */
export async function routeCalls(request: ApiRequest, options: RoutingOptions): Promise<RouteResult | null> {
  if (!request.path.startsWith('/calls')) return null;
  const prepared = await policyRouteDeps(request, options);
  if (!prepared.ok) return prepared.result;
  const deps = prepared.deps;

  if (request.method === 'GET' && request.path === '/calls') {
    const firmId = request.query.get('firmId');
    if (firmId === null) return { status: REFUSAL_STATUS.malformed_body, body: redactError('malformed_body') };
    const scoped = contextForPrincipal(deps.auth, deps.principal);
    if (!scoped.ok) return scoped.result;
    const firm = await readFirm(scoped.context, firmId);
    if (firm === null) return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
    const visibility = decideFirmRead(scoped.context, firm);
    const logs = await listCallLogs(scoped.context, { firmId });
    return {
      status: 200,
      body: { calls: logs.map(log => (visibility === 'assigned_or_admin' ? log : { ...log, note: null })) },
    };
  }

  if (request.method !== 'POST') {
    return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
  }
  // Send-path v2 (slice S3): what an agreed sequence would send, and when, before the
  // outcome is recorded. A read, so no receipt; a POST for the reason every read with a
  // body is (`docs/decisions/g3b-reads-are-posts.md`). A firm this caller cannot see is
  // `not_found`, the redacted sentence every unmounted path gets; every other refusal is
  // a 409 carrying the code, which the card turns into a sentence.
  if (request.path === '/calls/follow-up-preview') {
    const parsed = followUpPreviewRequestSchema.safeParse(request.body);
    if (!parsed.success) return { status: REFUSAL_STATUS.malformed_body, body: redactError('malformed_body') };
    const scoped = contextForPrincipal(deps.auth, deps.principal);
    if (!scoped.ok) return scoped.result;
    const preview = await previewFollowUp(scoped.context, {
      firmId: parsed.data.firmId,
      contactId: parsed.data.contactId,
      sequenceVersionId: parsed.data.sequenceVersionId,
      ...(parsed.data.previewAt === undefined ? {} : { previewAt: parsed.data.previewAt }),
    });
    if (!preview.ok) {
      return preview.reason === 'firm_unknown'
        ? { status: REFUSAL_STATUS.not_found, body: redactError('not_found') }
        : { status: 409, body: { status: 'refused', reason: preview.reason } };
    }
    return { status: 200, body: preview.value };
  }
  // Review of S3, round 2 (P1-B): record the agreed follow-up of a call already recorded
  // — the card's "Record the agreed dates" after a stale preview. An exact path with the
  // call log in the body rather than `/calls/<id>/follow-up`: every new endpoint in this
  // registry is an exact path (`bootstrap/routeRegistry.ts`).
  if (request.path === '/calls/follow-up') {
    return await runPolicyCommand(deps, callFollowUpCommandSchema, 'record_call_follow_up', async (repository, body) =>
      await recordCallFollowUp(repository, {
        callLogId: body.callLogId,
        followUpPermission: body.followUpPermission,
        commandId: body.commandId,
      }),
    );
  }
  if (request.path !== '/calls/log') {
    return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
  }

  // `retryBehaviour` is parsed so an old body is still understood, and deliberately
  // not passed on: what a no-answer does is the frozen step's decision (9.1).
  return await runPolicyCommand(deps, logCallOutcomeCommandSchema, 'log_call_outcome', async (repository, body) =>
    await logCallOutcome(repository, {
      firmId: body.firmId,
      ...(body.contactId === undefined ? {} : { contactId: body.contactId }),
      ...(body.routeId === undefined ? {} : { routeId: body.routeId }),
      ...(body.ticketId === undefined ? {} : { ticketId: body.ticketId }),
      ...(body.callSessionId === undefined ? {} : { callSessionId: body.callSessionId }),
      ...(body.callingIdentityId === undefined ? {} : { callingIdentityId: body.callingIdentityId }),
      ...(body.itemId === undefined ? {} : { itemId: body.itemId }),
      outcome: body.outcome,
      ...(body.occurredAt === undefined ? {} : { occurredAt: body.occurredAt }),
      ...(body.note === undefined ? {} : { note: body.note }),
      ...(body.direction === undefined ? {} : { direction: body.direction }),
      ...(body.durationSeconds === undefined ? {} : { durationSeconds: body.durationSeconds }),
      ...(body.callback === undefined ? {} : { callback: body.callback }),
      // What a `do_not_call` stops (migration 0037, P1); the 1.0.29 checkbox below it.
      ...(body.doNotCall === undefined ? {} : { doNotCall: body.doNotCall }),
      ...(body.doNotCallCoversAllContact === undefined
        ? {}
        : { doNotCallCoversAllContact: body.doNotCallCoversAllContact }),
      // The follow-up agreed on the call (migration 0025). The route parsed it and then
      // dropped it, so nothing a person agreed to on a call ever reached the call log —
      // the second review of PR 332 found the whole grant path disconnected here.
      ...(body.followUpPermission === undefined ? {} : { followUpPermission: body.followUpPermission }),
      commandId: body.commandId,
      journal: deps.journal,
    }),
  );
}
