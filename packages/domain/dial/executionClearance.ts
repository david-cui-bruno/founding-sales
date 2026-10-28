import type { DialRefusalCode } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { readPhoneRegistryDecision } from './registryCoverage.ts';
import {lockPreparedCallingCapability} from '../calling/preparationLifecycle.ts';
import {readPreparationExecution} from '../calling/preparationExecution.ts';

export type BrowserExecutionClearance =
  | { readonly ok: true; readonly at: string }
  | { readonly ok: false; readonly reason: DialRefusalCode };

/** Browser execution never uses the retired iPhone lane's owner-risk exception or policy test clock.
 * Caller holds the workspace admission gate. Restrictive evidence follows the exact
 * endpoint across firms and alternate routes, including retired associations.
 */
async function knownCallingRestriction(context: RepositoryContext, e164: string): Promise<{ok:true}|{ok:false;reason:DialRefusalCode}> {
  const routes = await context.db.query<{ known_personal_cell_at: Date | null }>(
    `SELECT known_personal_cell_at FROM phone_routes WHERE workspace_id=$1 AND e164=$2 ORDER BY id FOR SHARE`,
    [context.scope.workspaceId, e164],
  );
  if (routes.rows.some(route => route.known_personal_cell_at !== null)) return { ok: false, reason: 'route_invalid' };
  const match = await context.db.query(`SELECT 1 FROM national_registry_endpoint_scrubs
    WHERE workspace_id=$1 AND e164=$2 AND result='match' LIMIT 1`, [context.scope.workspaceId, e164]);
  if (match.rows.length) return { ok: false, reason: 'dnc_registry_match' };
  return {ok:true};
}

/** Browser permission does not depend on acquiring a registry snapshot. Retained
 * known matches and personal-cell restrictions remain stops across all routes. */
export async function readBrowserExecutionClearance(context:RepositoryContext,e164:string):Promise<BrowserExecutionClearance>{
 const restriction=await knownCallingRestriction(context,e164);if(!restriction.ok)return restriction;
 const clock=(await context.db.query<{at:Date}>('SELECT clock_timestamp() AS at')).rows[0]?.at;
 return clock?{ok:true,at:clock.toISOString()}:{ok:false,reason:'ticket_expired'};
}
/** The closed legacy phone lane retains its complete registry/freshness rules. */
export async function readPhoneHandoffRegistryClearance(context:RepositoryContext,e164:string){
 const restriction=await knownCallingRestriction(context,e164);return restriction.ok?readPhoneRegistryDecision(context,e164):restriction;
}

/** Reread the existing capability; never extend its original deadline. */
export async function readTicketExecutionClearance(context: RepositoryContext, ticketId: string, sessionDeadline?: Date): Promise<BrowserExecutionClearance> {
  await lockPreparedCallingCapability(context.db,context.scope.workspaceId,'ticket',ticketId);
  const ticket = (await context.db.query<{ e164: string|null; firm_id:string; calling_preparation_erased_at:Date|null;phone_route_id: string; route_version: number; expires_at: Date }>(
    `SELECT e164,firm_id,calling_preparation_erased_at,phone_route_id,route_version,expires_at FROM dial_tickets
      WHERE workspace_id=$1 AND id=$2 FOR SHARE`, [context.scope.workspaceId, ticketId],
  )).rows[0];
  if (!ticket) return { ok: false, reason: 'ticket_unknown' };
  if(!ticket.e164||ticket.calling_preparation_erased_at)return {ok:false,reason:'route_invalid'};
  const preparation=await readPreparationExecution(context,ticket.firm_id);
  if(!preparation.ok)return preparation;
  const route = (await context.db.query<{ e164: string|null; version: number;eligibility:string;calling_preparation_erased_at:Date|null }>(
    'SELECT e164,version,eligibility,calling_preparation_erased_at FROM phone_routes WHERE workspace_id=$1 AND id=$2 FOR SHARE',
    [context.scope.workspaceId, ticket.phone_route_id],
  )).rows[0];
  if (!route || !route.e164||route.calling_preparation_erased_at||route.eligibility==='retired'||route.e164 !== ticket.e164 || route.version !== ticket.route_version) return { ok: false, reason: 'route_version_stale' };
  const clearance = await readBrowserExecutionClearance(context, ticket.e164);
  if (!clearance.ok) return clearance;
  const finalPreparation=await readPreparationExecution(context,ticket.firm_id);
  if(!finalPreparation.ok)return finalPreparation;
  const clock = (await context.db.query<{ at: Date }>('SELECT clock_timestamp() AS at')).rows[0];
  if (!clock || clock.at.getTime() >= Math.min(ticket.expires_at.getTime(), sessionDeadline?.getTime() ?? Infinity,finalPreparation.expiresAt?Date.parse(finalPreparation.expiresAt):Infinity)) {
    return { ok: false, reason: 'ticket_expired' };
  }
  return { ...clearance, at: clock.at.toISOString() };
}

/** A late refusal must roll back command effects and its just-inserted receipt. */
export class DialExecutionRefused extends Error {
  constructor(readonly reason: DialRefusalCode) { super('Dial execution refused'); }
}
