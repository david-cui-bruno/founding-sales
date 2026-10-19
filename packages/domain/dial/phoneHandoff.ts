import { PHONE_HANDOFF_MAX_LIFETIME_MS, phoneHandoffResultSchema, type PhoneHandoffResult, type ReservePhoneHandoffCommand } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { loadFirmForUpdate } from '../crm/firms.ts';
import { readCallingProvider } from '../settings/integrations.ts';
import { lockSendGateForStopFact } from '../policy/sendGate.ts';
import { currentCallingWindow } from '../policy/callingWindows.ts';
import { localInstant, localParts } from '../src/rules/localClock.ts';
import { readCallCadence } from '../calls/cadence.ts';
import { adviseDial } from './advise.ts';
import { readPhoneRegistryDecision } from './registryCoverage.ts';

type Reservation = { readonly ok: true; readonly value: { readonly attemptId: string } } | { readonly ok: false; readonly reason: string };
const refused = (reason: string): Reservation => ({ ok: false, reason });

/** One command transaction reserves before dispatch. Receipt MUST contain only attemptId. */
export async function reservePhoneHandoff(context: RepositoryContext, input: ReservePhoneHandoffCommand & { readonly deviceId: string; readonly at?: string }): Promise<Reservation> {
  const w = context.scope.workspaceId;
  const actor = context.scope.actor;
  if (actor.kind !== 'user') return refused('not_assigned');
  // Exclusive also matches logging/parking and avoids a shared-to-exclusive upgrade.
  await lockSendGateForStopFact(context);
  const route = (await context.db.query<{ firm_id: string; contact_id: string | null; e164: string; version: number }>(
    'SELECT firm_id,contact_id,e164,version FROM phone_routes WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [w, input.routeId])).rows[0];
  const firm = await loadFirmForUpdate(context, input.firmId);
  if (!firm || firm.status !== 'active' || firm.assigned_user_id !== actor.userId) return refused('not_assigned');
  if (!route || route.firm_id !== firm.id) return refused('route_missing');
  if (route.version !== input.routeVersion) return refused('route_version_stale');
  const device = await context.db.query(`SELECT 1 FROM devices d JOIN workspace_memberships m ON m.workspace_id=d.workspace_id AND m.user_id=d.user_id
    WHERE d.workspace_id=$1 AND d.id=$2 AND d.user_id=$3 AND d.status='active' AND m.status='active'`, [w, input.deviceId, actor.userId]);
  if (!device.rows.length || await readCallingProvider(context) !== 'tel') return refused('phone_handoff_unavailable');
  const registry = await readPhoneRegistryDecision(context, route.e164, input.at);
  if (!registry.ok) return registry;
  const at = registry.at;
  const advice = await adviseDial(context, { firmId: firm.id, routeId: input.routeId, at });
  if (!advice?.callable) return refused(advice?.reasons[0] ?? 'firm_unknown');
  const cadence = await readCallCadence(context, firm.id, at, at);
  if (cadence.refusal !== null) return refused(cadence.refusal);
  const opportunity = await resolveHandoffOpportunity(context, input);
  if (!opportunity.ok) return opportunity;
  const window = await currentCallingWindow(context);
  const parts = localParts(at, firm.time_zone ?? '');
  const close = localInstant(parts.date, { hour: Math.floor(window.window.endMinute / 60), minute: window.window.endMinute % 60 }, firm.time_zone ?? '');
  // Millisecond truncation is conservative. Near a boundary, refuse rather than grant grace.
  const expires = Math.min(Date.parse(at) + PHONE_HANDOFF_MAX_LIFETIME_MS, Date.parse(close), Date.parse(registry.freshUntil));
  if (expires <= Date.parse(at)) return refused('outside_calling_window');
  const row = (await context.db.query<{ id: string }>(`INSERT INTO phone_handoff_attempts
    (workspace_id,firm_id,actor_user_id,device_id,command_id,contact_id,opportunity_id,phone_route_id,route_version,e164,item_id,
     registry_snapshot_id,registry_scrubbed_at,reserved_at,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
    [w, firm.id, actor.userId, input.deviceId, input.commandId, route.contact_id, opportunity.value, input.routeId, route.version, route.e164,
      input.itemId ?? null, registry.snapshotId, registry.scrubbedAt, at, new Date(expires).toISOString()])).rows[0];
  if (!row) throw new Error('phone handoff reservation missing');
  return { ok: true, value: { attemptId: row.id } };
}

async function resolveHandoffOpportunity(context: RepositoryContext, input: ReservePhoneHandoffCommand): Promise<{ ok: true; value: string | null } | { ok: false; reason: string }> {
  const w = context.scope.workspaceId;
  let selected = input.opportunityId;
  if (input.itemId) {
    const item = (await context.db.query<{ opportunity_id: string | null }>(`SELECT COALESCE(c.opportunity_id,e.opportunity_id) AS opportunity_id
      FROM today_items t LEFT JOIN callbacks c ON c.workspace_id=t.workspace_id AND t.source_kind='callback' AND c.id=t.source_id
      LEFT JOIN step_executions s ON s.workspace_id=t.workspace_id AND t.source_kind='step_execution' AND s.id=t.source_id
      LEFT JOIN sequence_enrollments e ON e.workspace_id=s.workspace_id AND e.id=s.enrollment_id
      WHERE t.workspace_id=$1 AND t.id=$2 AND t.firm_id=$3`, [w, input.itemId, input.firmId])).rows[0];
    if (!item || (selected !== undefined && selected !== item.opportunity_id)) return { ok: false, reason: 'invalid_input' };
    selected = item.opportunity_id;
  }
  const opportunities = (await context.db.query<{ id: string }>(`SELECT id FROM opportunities WHERE workspace_id=$1 AND firm_id=$2
    AND (($3::uuid IS NULL AND status='open') OR id=$3) ORDER BY id`, [w, input.firmId, selected ?? null])).rows;
  if (selected === null) return { ok: true, value: null };
  if (selected !== undefined && opportunities[0]?.id !== selected) return { ok: false, reason: 'invalid_input' };
  if (opportunities.length > 1) return { ok: false, reason: 'invalid_input' };
  return { ok: true, value: opportunities[0]?.id ?? null };
}

/** Called only after receipt commit. Replay and tombstones are permanently nonactionable. */
export async function readPhoneHandoffResult(context: RepositoryContext, attemptId: string, replayed: boolean): Promise<PhoneHandoffResult | null> {
  const actor = context.scope.actor;
  if (actor.kind !== 'user') return null;
  const row = (await context.db.query<{ id: string; firm_id: string; phone_route_id: string | null; e164: string | null; reserved_at: Date; expires_at: Date; erased_at: Date | null }>(
    'SELECT id,firm_id,phone_route_id,e164,reserved_at,expires_at,erased_at FROM phone_handoff_attempts WHERE workspace_id=$1 AND id=$2 AND actor_user_id=$3',
    [context.scope.workspaceId, attemptId, actor.userId])).rows[0];
  if (!row) return null;
  const identity = { attemptId: row.id, firmId: row.firm_id, routeId: row.phone_route_id, reservedAt: row.reserved_at.toISOString(), expiresAt: row.expires_at.toISOString() };
  const lifetime = row.expires_at.getTime() - row.reserved_at.getTime();
  const value = !replayed && row.erased_at === null && row.e164 !== null && row.phone_route_id !== null
    ? { ...identity, actionable: true, e164: row.e164, telUri: `tel:${row.e164}`, validForMilliseconds: Math.floor(lifetime) }
    : { ...identity, actionable: false, e164: null, telUri: null, validForMilliseconds: 0, reason: 'handoff_reconciliation_required' };
  return phoneHandoffResultSchema.parse(value);
}
