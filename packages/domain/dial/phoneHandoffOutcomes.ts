import type { RepositoryContext } from '../db/workspaceScope.ts';
import type { LogCallOutcomeInput } from './calls.ts';
import { parkIfCadenceSpent } from '../calls/sessions.ts';
import { UNANSWERED_OUTCOMES } from '../calls/cadence.ts';
import { acceptPolicy, refusePolicy, type PolicyResult } from '../policy/types.ts';

/** Gate already held. Freeze the exact admitted context, never guess from the latest form. */
export async function bindPhoneHandoffOutcome(context: RepositoryContext, input: LogCallOutcomeInput): Promise<PolicyResult<LogCallOutcomeInput>> {
  if (!input.phoneHandoffAttemptId) return acceptPolicy(input);
  if (input.callSessionId || input.ticketId || input.callingIdentityId || input.direction === 'inbound') return refusePolicy('invalid_input');
  const actor = context.scope.actor;
  const row = (await context.db.query<{ firm_id: string; actor_user_id: string; phone_route_id: string | null; contact_id: string | null;
    opportunity_id: string | null; item_id: string | null; e164: string | null; call_log_id: string | null; erased_at: Date | null }>(
    'SELECT firm_id,actor_user_id,phone_route_id,contact_id,opportunity_id,item_id,e164,call_log_id,erased_at FROM phone_handoff_attempts WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
    [context.scope.workspaceId, input.phoneHandoffAttemptId])).rows[0];
  if (!row || actor.kind !== 'user' || row.actor_user_id !== actor.userId || row.firm_id !== input.firmId || row.erased_at !== null || row.phone_route_id === null) return refusePolicy('ticket_mismatch');
  if (row.call_log_id !== null) return refusePolicy('call_already_logged');
  if ((input.routeId !== undefined && input.routeId !== row.phone_route_id) ||
      (input.contactId !== undefined && input.contactId !== row.contact_id) ||
      (input.opportunityId !== undefined && input.opportunityId !== row.opportunity_id) ||
      (input.itemId !== undefined && row.item_id !== null && input.itemId !== row.item_id)) return refusePolicy('ticket_mismatch');
  const outcomeRouteId = await resolveHistoricalOutcomeRoute(context, row.firm_id, row.phone_route_id, row.contact_id, row.e164);
  if (outcomeRouteId === null) return refusePolicy('route_unknown');
  return acceptPolicy({ ...input, routeId: outcomeRouteId, opportunityId: row.opportunity_id,
    ...(row.contact_id === null ? {} : { contactId: row.contact_id }), ...(row.item_id === null ? {} : { itemId: row.item_id }) });
}

/** Historical reconciliation only. The admitted route and endpoint remain frozen on the attempt. */
async function resolveHistoricalOutcomeRoute(context: RepositoryContext, firmId: string, routeId: string, contactId: string | null, e164: string | null): Promise<string | null> {
  const w = context.scope.workspaceId;
  const route = (await context.db.query<{ firm_id: string; contact_id: string | null; e164: string }>(
    'SELECT firm_id,contact_id,e164 FROM phone_routes WHERE workspace_id=$1 AND id=$2', [w, routeId])).rows[0];
  if (!route || route.e164 !== e164 || route.contact_id !== contactId) return null;
  if (route.firm_id === firmId) return routeId;
  const visited = new Set<string>();
  let source = route.firm_id;
  while (source !== firmId) {
    if (visited.has(source)) return null;
    visited.add(source);
    const next = (await context.db.query<{ status: string; merged_into_firm_id: string | null }>(
      'SELECT status,merged_into_firm_id FROM firms WHERE workspace_id=$1 AND id=$2', [w, source])).rows[0];
    if (!next || next.status !== 'merged' || next.merged_into_firm_id === null) return null;
    source = next.merged_into_firm_id;
  }
  const equivalents = (await context.db.query<{ id: string }>(`SELECT id FROM phone_routes
    WHERE workspace_id=$1 AND firm_id=$2 AND e164=$3 AND contact_id IS NOT DISTINCT FROM $4::uuid`, [w, firmId, e164, contactId])).rows;
  return equivalents.length === 1 ? equivalents[0]?.id ?? null : null;
}

export async function phoneAttemptIdForLog(context: RepositoryContext, callLogId: string): Promise<string | null> {
  return (await context.db.query<{ id: string }>('SELECT id FROM phone_handoff_attempts WHERE workspace_id=$1 AND call_log_id=$2 AND erased_at IS NULL',
    [context.scope.workspaceId, callLogId])).rows[0]?.id ?? null;
}

export async function linkPhoneHandoffOutcome(context: RepositoryContext, input: LogCallOutcomeInput, callLogId: string): Promise<void> {
  if (!input.phoneHandoffAttemptId) return;
  const result = await context.db.query(`UPDATE phone_handoff_attempts SET call_log_id=$3 WHERE workspace_id=$1 AND id=$2
    AND erased_at IS NULL AND call_log_id IS NULL RETURNING id`, [context.scope.workspaceId, input.phoneHandoffAttemptId, callLogId]);
  if (result.rows.length !== 1) throw new Error('phone handoff outcome binding changed');
  if (UNANSWERED_OUTCOMES.has(input.outcome)) await parkIfCadenceSpent(context, { firmId: input.firmId, sessionId: input.phoneHandoffAttemptId });
}
