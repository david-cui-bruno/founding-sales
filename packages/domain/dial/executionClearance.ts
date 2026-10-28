import type { DialRefusalCode } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { readPhoneRegistryDecision } from './registryCoverage.ts';

export type ExecutionClearance =
  | { readonly ok: true; readonly freshUntil: string; readonly at: string }
  | { readonly ok: false; readonly reason: DialRefusalCode };

/** Execution never uses the retired iPhone lane's owner-risk exception or policy test clock.
 * Caller holds the workspace admission gate. Restrictive evidence follows the exact
 * endpoint across firms and alternate routes, including retired associations.
 */
export async function readExecutionClearance(context: RepositoryContext, e164: string): Promise<ExecutionClearance> {
  const routes = await context.db.query<{ known_personal_cell_at: Date | null }>(
    `SELECT known_personal_cell_at FROM phone_routes WHERE workspace_id=$1 AND e164=$2 ORDER BY id FOR SHARE`,
    [context.scope.workspaceId, e164],
  );
  if (routes.rows.some(route => route.known_personal_cell_at !== null)) return { ok: false, reason: 'route_invalid' };
  const match = await context.db.query(`SELECT 1 FROM national_registry_endpoint_scrubs
    WHERE workspace_id=$1 AND e164=$2 AND result='match' LIMIT 1`, [context.scope.workspaceId, e164]);
  if (match.rows.length) return { ok: false, reason: 'dnc_registry_match' };
  return await readPhoneRegistryDecision(context, e164);
}

/** Reread the existing capability; never extend its original deadline. */
export async function readTicketExecutionClearance(context: RepositoryContext, ticketId: string, sessionDeadline?: Date): Promise<ExecutionClearance> {
  const ticket = (await context.db.query<{ e164: string; phone_route_id: string; route_version: number; expires_at: Date }>(
    `SELECT e164,phone_route_id,route_version,expires_at FROM dial_tickets
      WHERE workspace_id=$1 AND id=$2 FOR SHARE`, [context.scope.workspaceId, ticketId],
  )).rows[0];
  if (!ticket) return { ok: false, reason: 'ticket_unknown' };
  const route = (await context.db.query<{ e164: string; version: number }>(
    'SELECT e164,version FROM phone_routes WHERE workspace_id=$1 AND id=$2 FOR SHARE',
    [context.scope.workspaceId, ticket.phone_route_id],
  )).rows[0];
  if (!route || route.e164 !== ticket.e164 || route.version !== ticket.route_version) return { ok: false, reason: 'route_version_stale' };
  const clearance = await readExecutionClearance(context, ticket.e164);
  if (!clearance.ok) return clearance;
  const clock = (await context.db.query<{ at: Date }>('SELECT clock_timestamp() AS at')).rows[0];
  if (!clock || clock.at.getTime() >= Math.min(ticket.expires_at.getTime(), Date.parse(clearance.freshUntil), sessionDeadline?.getTime() ?? Infinity)) {
    return { ok: false, reason: 'ticket_expired' };
  }
  return { ...clearance, at: clock.at.toISOString() };
}

/** A late refusal must roll back command effects and its just-inserted receipt. */
export class DialExecutionRefused extends Error {
  constructor(readonly reason: DialRefusalCode) { super('Dial execution refused'); }
}
