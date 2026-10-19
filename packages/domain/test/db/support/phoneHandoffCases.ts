import { randomUUID } from 'node:crypto';
import type { SessionQueryable } from '../../../db/queryable.ts';
import type { TwoWorkspaces } from './fixtures.ts';
import type { SeededCrm } from './crmFixtures.ts';
import { testRegistrySnapshotRow } from '../../support/nationalRegistry.ts';
import { PHONE_OWNER_RISK_CONSTRAINT_CASES } from './phoneOwnerRiskCases.ts';
type Fixture = { session: SessionQueryable; seeded: TwoWorkspaces; crm: SeededCrm };
type Row = Record<string, unknown>;
type Case = { constraint: string; run: (f: Fixture) => Promise<unknown> };
const absent = '00000000-0000-4000-8000-000000000120';
async function insert(f: Fixture, table: string, row: Row) {
  const keys = Object.keys(row);
  return await f.session.query(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${String(i + 1)}`).join(',')})`, Object.values(row));
}
async function snapshot(f: Fixture): Promise<Row> {
  // Only this privileged, rolled-back catalog harness isolates declarative errors.
  await f.session.query('DROP TRIGGER IF EXISTS national_registry_snapshots_publication_guard ON national_registry_snapshots');
  await f.session.query('DROP TRIGGER IF EXISTS phone_handoff_owner_risk_guard ON phone_handoff_attempts');
  return testRegistrySnapshotRow(f.seeded.alpha.workspaceId, { publishedAt: '2026-09-02T00:00:00Z' });
}
async function scrub(f: Fixture): Promise<Row> {
  const s = await snapshot(f); await insert(f, 'national_registry_snapshots', s);
  return { workspace_id: s['workspace_id'], snapshot_id: s['id'], e164: '+14015550187', scrubbed_at: '2026-09-02T00:00:00Z', result: 'clear' };
}
async function attempt(f: Fixture): Promise<Row> {
  const s = await snapshot(f); await insert(f, 'national_registry_snapshots', s);
  const route = (await f.session.query<{ id: string }>('SELECT id FROM phone_routes WHERE workspace_id=$1 AND firm_id=$2 ORDER BY id LIMIT 1',
    [f.seeded.alpha.workspaceId, f.crm.alpha.firmId])).rows[0];
  if (!route) throw new Error('missing fixture route');
  return { workspace_id: f.seeded.alpha.workspaceId, id: randomUUID(), firm_id: f.crm.alpha.firmId,
    actor_user_id: f.seeded.alpha.salesperson.userId, device_id: f.seeded.alpha.salesperson.deviceId, command_id: randomUUID(),
    contact_id: f.crm.alpha.contactId, opportunity_id: f.crm.alpha.opportunityId, phone_route_id: route.id, route_version: 1,
    e164: '+14015550187', registry_snapshot_id: s['id'], registry_scrubbed_at: '2026-09-02T00:00:00Z',
    reserved_at: '2026-09-02T14:00:00Z', expires_at: '2026-09-02T14:00:15Z' };
}
const bad = (table: string, constraint: string, make: (f: Fixture) => Promise<Row>, overrides: Row): Case => ({ constraint,
  run: async f => { const row = { ...await make(f), ...overrides };
    if (table === 'national_registry_snapshots' && constraint !== 'national_registry_snapshots_import_metadata') {
      row['acquisition_id'] = null; row['source_format'] = null; row['validated_at'] = null; row['validation_metadata'] = null;
    }
    await insert(f, table, row); return await f.session.query('SET CONSTRAINTS ALL IMMEDIATE'); } });
const duplicate = (table: string, constraint: string, make: (f: Fixture) => Promise<Row>, changes: (row: Row) => Row): Case => ({ constraint,
  run: async f => { const row = await make(f); await insert(f, table, row); return await insert(f, table, { ...row, ...changes(row) }); } });
export const PHONE_HANDOFF_CONSTRAINT_CASES: readonly Case[] = [
  ...PHONE_OWNER_RISK_CONSTRAINT_CASES,
  bad('national_registry_snapshots', 'national_registry_snapshots_import_metadata', snapshot, { source_format: 'mixed' }),
  duplicate('national_registry_snapshots', 'national_registry_snapshots_acquisition', snapshot, () => ({ id: randomUUID() })),
  bad('national_registry_snapshots', 'national_registry_snapshots_receipt_reference_check', snapshot, { receipt_reference: ' ' }),
  bad('national_registry_snapshots', 'national_registry_snapshots_check', snapshot, { published_at: '2026-08-01T00:00:00Z' }),
  bad('national_registry_snapshots', 'national_registry_snapshots_check1', snapshot, { revoked_at: '2026-08-01T00:00:00Z' }),
  bad('national_registry_snapshots', 'national_registry_snapshots_covered_area_codes_check', snapshot, { covered_area_codes: [] }),
  bad('national_registry_snapshots', 'national_registry_snapshots_covered_area_codes_check1', snapshot, { covered_area_codes: ['000'] }),
  bad('national_registry_snapshots', 'national_registry_snapshots_covered_area_codes_check2', snapshot, { covered_area_codes: ['401', null] }),
  bad('national_registry_snapshots', 'national_registry_snapshots_workspace_id_fkey', snapshot, { workspace_id: absent }),
  duplicate('national_registry_snapshots', 'national_registry_snapshots_pkey', snapshot, () => ({})),
  bad('national_registry_endpoint_scrubs', 'national_registry_endpoint_scrubs_e164_check', scrub, { e164: '4015550187' }),
  bad('national_registry_endpoint_scrubs', 'national_registry_endpoint_scrubs_result_check', scrub, { result: 'unknown' }),
  bad('national_registry_endpoint_scrubs', 'national_registry_endpoint_scrubs_workspace_id_snapshot_id_fkey', scrub, { snapshot_id: absent }),
  duplicate('national_registry_endpoint_scrubs', 'national_registry_endpoint_scrubs_pkey', scrub, () => ({})),
  bad('phone_handoff_attempts', 'phone_handoff_attempts_check', attempt, { expires_at: '2026-09-02T14:00:16Z' }),
  bad('phone_handoff_attempts', 'phone_handoff_attempts_check1', attempt, { erased_at: '2026-09-01T00:00:00Z', e164: null,
    phone_route_id: null, route_version: null, registry_snapshot_id: null, registry_scrubbed_at: null, contact_id: null, opportunity_id: null }),
  bad('phone_handoff_attempts', 'phone_handoff_evidence_union', attempt, { e164: null }),
  bad('phone_handoff_attempts', 'phone_handoff_attempts_command_id_check', attempt, { command_id: ' ' }),
  bad('phone_handoff_attempts', 'phone_handoff_attempts_e164_check', attempt, { e164: '4015550187' }),
  bad('phone_handoff_attempts', 'phone_handoff_attempts_route_version_check', attempt, { route_version: 0 }),
  bad('phone_handoff_attempts', 'phone_handoff_attempts_workspace_id_fkey', attempt, { workspace_id: absent, contact_id: null, opportunity_id: null }),
  bad('phone_handoff_attempts', 'phone_handoff_attempts_workspace_id_firm_id_fkey', attempt, { firm_id: absent, contact_id: null, opportunity_id: null }),
  bad('phone_handoff_attempts', 'phone_handoff_attempts_workspace_id_actor_user_id_fkey', attempt, { actor_user_id: absent }),
  bad('phone_handoff_attempts', 'phone_handoff_attempts_workspace_id_device_id_fkey', attempt, { device_id: absent }),
  bad('phone_handoff_attempts', 'phone_handoff_attempts_workspace_id_contact_id_firm_id_fkey', attempt, { contact_id: absent }),
  bad('phone_handoff_attempts', 'phone_handoff_attempts_opportunity_fkey', attempt, { opportunity_id: absent }),
  bad('phone_handoff_attempts', 'phone_handoff_attempts_workspace_id_phone_route_id_fkey', attempt, { phone_route_id: absent }),
  bad('phone_handoff_attempts', 'phone_handoff_attempts_workspace_id_registry_snapshot_id_fkey', attempt, { registry_snapshot_id: absent }),
  bad('phone_handoff_attempts', 'phone_handoff_attempts_workspace_id_call_log_id_fkey', attempt, { call_log_id: absent }),
  duplicate('phone_handoff_attempts', 'phone_handoff_attempts_pkey', attempt, () => ({ command_id: randomUUID() })),
  duplicate('phone_handoff_attempts', 'phone_handoff_attempts_workspace_id_command_id_key', attempt, () => ({ id: randomUUID() })),
  { constraint: 'phone_handoff_attempts_workspace_id_call_log_id_key', run: async f => {
    const row = await attempt(f), logId = randomUUID();
    await f.session.query(`INSERT INTO call_logs(workspace_id,id,firm_id,outcome,step_effect,actor_user_id,occurred_at)
      VALUES($1,$2,$3,'no_answer','none',$4,now())`, [row['workspace_id'], logId, row['firm_id'], row['actor_user_id']]);
    await insert(f, 'phone_handoff_attempts', { ...row, call_log_id: logId });
    return await insert(f, 'phone_handoff_attempts', { ...row, id: randomUUID(), command_id: randomUUID(), call_log_id: logId });
  } },
];
