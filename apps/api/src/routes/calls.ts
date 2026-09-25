import { logCallOutcomeCommandSchema } from '@fss/contracts';
import { decideFirmRead, readFirm } from '@fss/domain/crm';
import { listCallLogs, logCallOutcome } from '@fss/domain/dial';
import { REFUSAL_STATUS, contextForPrincipal, policyRouteDeps, redactError, runPolicyCommand } from './dialSupport.ts';
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
 * Since lane g79 the body may name the Today task the call was placed from (`itemId`),
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
  if (request.path !== '/calls/log') {
    return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
  }

  // `retryBehaviour` is parsed so an old body is still understood, and deliberately
  // not passed on: what a no-answer does is the frozen step's decision (9.1, lane g79).
  return await runPolicyCommand(deps, logCallOutcomeCommandSchema, 'log_call_outcome', async (repository, body) =>
    await logCallOutcome(repository, {
      firmId: body.firmId,
      ...(body.contactId === undefined ? {} : { contactId: body.contactId }),
      ...(body.routeId === undefined ? {} : { routeId: body.routeId }),
      ...(body.ticketId === undefined ? {} : { ticketId: body.ticketId }),
      ...(body.callingIdentityId === undefined ? {} : { callingIdentityId: body.callingIdentityId }),
      ...(body.itemId === undefined ? {} : { itemId: body.itemId }),
      outcome: body.outcome,
      ...(body.occurredAt === undefined ? {} : { occurredAt: body.occurredAt }),
      ...(body.note === undefined ? {} : { note: body.note }),
      ...(body.callback === undefined ? {} : { callback: body.callback }),
      ...(body.doNotCallCoversAllContact === undefined
        ? {}
        : { doNotCallCoversAllContact: body.doNotCallCoversAllContact }),
      commandId: body.commandId,
      journal: deps.journal,
    }),
  );
}
