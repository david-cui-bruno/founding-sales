import { compareVersions, NATIONAL_DNC_RISK_MIN_CLIENT_VERSION, PHONE_HANDOFF_MAX_LIFETIME_MS, type PhoneHandoffResult, type ReservePhoneHandoffCommand } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { loadFirmForUpdate } from '../crm/firms.ts';
import { readCallingProvider } from '../settings/integrations.ts';
import { lockSendGateForStopFact } from '../policy/sendGate.ts';
import { currentCallingWindow } from '../policy/callingWindows.ts';
import { localInstant, localParts } from '../src/rules/localClock.ts';
import { readCallCadence } from '../calls/cadence.ts';
import { adviseDial } from './advise.ts';
import { readPhoneNationalDecision } from './phoneNationalPolicy.ts';
import { readPublishedPhoneHandoff } from './phoneHandoffPublication.ts';

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
  const registry = await readPhoneNationalDecision(context, { firmId: firm.id, routeId: input.routeId, routeVersion: route.version, e164: route.e164, ...(input.at === undefined ? {} : { at: input.at }) });
  if (!registry.ok) return registry;
  if (registry.basis !== 'registry' && (compareVersions(input.clientVersion, NATIONAL_DNC_RISK_MIN_CLIENT_VERSION) < 0 ||
      input.expectedNationalDncReceiptId !== registry.receipt.id)) return refused('dnc_coverage_unknown');
  const at = registry.at;
  const advice = await adviseDial(context, { firmId: firm.id, routeId: input.routeId, at, omitNationalDnc: true });
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
  if (!await lockHandoffAuthority(context, input.deviceId, actor.userId, registry.basis !== 'registry')) return refused('phone_handoff_unavailable');
  // Authority locks can themselves wait. Never refresh the original evidence/window
  // bound to make a delayed reservation actionable. `at` remains the policy test clock.
  const clock = (await context.db.query<{ at: Date }>('SELECT clock_timestamp() AS at')).rows[0]?.at;
  if (!clock || expires <= (registry.basis !== 'registry' || input.at === undefined ? clock.getTime() : Date.parse(input.at))) return refused('phone_handoff_unavailable');
  const row = (await context.db.query<{ id: string }>(`INSERT INTO phone_handoff_attempts
    (workspace_id,firm_id,actor_user_id,device_id,command_id,contact_id,opportunity_id,phone_route_id,route_version,e164,item_id,
     registry_snapshot_id,registry_scrubbed_at,reserved_at,expires_at,national_dnc_basis,owner_risk_receipt_id,owner_risk_firm_id,
     office_proof_kind,office_proof_id,office_proof_expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING id`,
    [w, firm.id, actor.userId, input.deviceId, input.commandId, route.contact_id, opportunity.value, input.routeId, route.version, route.e164,
      input.itemId ?? null, registry.basis === 'registry' ? registry.snapshotId : null, registry.basis === 'registry' ? registry.scrubbedAt : null,
      at, new Date(expires).toISOString(), registry.basis, registry.basis === 'registry' ? null : registry.receipt.id,
      registry.basis === 'registry' ? null : firm.id, registry.basis === 'registry' ? null : registry.proof?.kind ?? null,
      registry.basis === 'registry' ? null : registry.proof?.id ?? null, registry.basis === 'registry' ? null : registry.proof?.expiresAt ?? null])).rows[0];
  if (!row) throw new Error('phone handoff reservation missing');
  return { ok: true, value: { attemptId: row.id } };
}

export async function lockHandoffAuthority(context: RepositoryContext, deviceId: string, userId: string, ownerRisk = false): Promise<boolean> {
  // Gate/route/firm/evidence first, then exact device followed by membership (the
  // auth open-session device-first order). SHARE conflicts with non-key status
  // updates, unlike KEY SHARE. Read current locked rows and hold through commit.
  const parameters = [context.scope.workspaceId, deviceId, userId];
  const device = (await context.db.query<{ status: string }>(
    'SELECT status FROM devices WHERE workspace_id=$1 AND id=$2 AND user_id=$3 FOR SHARE', parameters)).rows[0];
  if (device?.status !== 'active') return false;
  const membership = (await context.db.query<{ status: string; role: string }>(
    'SELECT status,role FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 FOR SHARE',
    [context.scope.workspaceId, userId])).rows[0];
  return membership?.status === 'active' && (!ownerRisk || membership.role === 'admin');
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
  return readPublishedPhoneHandoff(context, attemptId, replayed, lockHandoffAuthority);
}
