import { randomUUID } from 'node:crypto';
import type { SessionQueryable } from '../../../db/queryable.ts';

type Fixture = { session: SessionQueryable; seeded: { alpha: { workspaceId: string } } };
type Row = Record<string, unknown>;
type Case = { constraint: string; run: (f: Fixture) => Promise<unknown> };
type Make = (f: Fixture) => Promise<Row>;
const absent = '00000000-0000-4000-8000-000000000121';
const allowances = 'sourcing_apollo_allowances';
const attempts = 'sourcing_apollo_attempts';
const origins = 'sourcing_apollo_candidate_origins';

async function insert(f: Fixture, table: string, row: Row) {
  const keys = Object.keys(row);
  return f.session.query(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`, Object.values(row));
}
async function allowance(f: Fixture): Promise<Row> {
  return { id: randomUUID(), workspace_id: f.seeded.alpha.workspaceId, account_ref: 'fixture-account', key_ref: 'fixture-key-reference',
    cycle_start: '2026-10-01T00:00:00Z', cycle_end: '2026-11-01T00:00:00Z', verified_at: '2026-10-02T00:00:00Z',
    exclusive_attested_at: '2026-10-02T00:00:00Z', starting_used: 0, reserved: 0 };
}
async function attempt(f: Fixture): Promise<Row> {
  const row = await allowance(f);
  await insert(f, allowances, row);
  return { id: randomUUID(), workspace_id: f.seeded.alpha.workspaceId, allowance_id: row['id'], region: 'TX', page: 1 };
}
async function origin(f: Fixture): Promise<Row> {
  const row = await attempt(f), candidateId = randomUUID();
  await insert(f, attempts, row);
  await insert(f, 'sourcing_candidates', { workspace_id: f.seeded.alpha.workspaceId, id: candidateId,
    identity_key: 'a'.repeat(64), payload: '{}', status: 'needs_review', revision: 1 });
  return { workspace_id: f.seeded.alpha.workspaceId, candidate_id: candidateId, candidate_revision: 1,
    attempt_id: row['id'], organization_name: 'Fixture organization', domain: 'example.test' };
}
const bad = (table: string, constraint: string, make: Make, changes: Row): Case => ({ constraint,
  run: async f => insert(f, table, { ...await make(f), ...changes }) });
const duplicate = (table: string, constraint: string, make: Make, changes: Row, dropPrimary = false): Case => ({ constraint,
  run: async f => {
    // The composite workspace/id unique key overlaps the id primary key. Isolate
    // it within this test's rolled-back transaction so the intended key rejects.
    if (dropPrimary) await f.session.query(`ALTER TABLE ${table} DROP CONSTRAINT ${table}_pkey`);
    const row = await make(f);
    await insert(f, table, row);
    return insert(f, table, { ...row, ...changes });
  } });

export const APOLLO_DISCOVERY_CONSTRAINT_CASES: readonly Case[] = [
  bad(allowances, 'sourcing_apollo_allowances_account_ref_check', allowance, { account_ref: '' }),
  bad(allowances, 'sourcing_apollo_allowances_key_ref_check', allowance, { key_ref: '' }),
  bad(allowances, 'sourcing_apollo_allowances_workspace_id_fkey', allowance, { workspace_id: absent }),
  bad(allowances, 'sourcing_apollo_allowances_starting_used_check', allowance, { starting_used: -1 }),
  bad(allowances, 'sourcing_apollo_allowances_reserved_check', allowance, { reserved: -1 }),
  bad(allowances, 'sourcing_apollo_allowances_check', allowance, { cycle_end: '2026-10-01T00:00:00Z',
    verified_at: '2026-09-30T00:00:00Z', exclusive_attested_at: '2026-09-30T00:00:00Z' }),
  bad(allowances, 'sourcing_apollo_allowances_check1', allowance, { verified_at: '2026-11-01T00:00:00Z' }),
  bad(allowances, 'sourcing_apollo_allowances_check2', allowance, { exclusive_attested_at: '2026-11-01T00:00:00Z' }),
  bad(allowances, 'sourcing_apollo_allowances_check3', allowance, { starting_used: 75, reserved: 1 }),
  duplicate(allowances, 'sourcing_apollo_allowances_pkey', allowance, { account_ref: 'other-account' }),
  duplicate(allowances, 'sourcing_apollo_allowances_account_ref_cycle_start_key', allowance, { id: absent }),
  duplicate(allowances, 'sourcing_apollo_allowances_workspace_id_id_key', allowance, { account_ref: 'other-account' }, true),
  bad(attempts, 'sourcing_apollo_attempts_workspace_id_fkey', attempt, { workspace_id: absent }),
  bad(attempts, 'sourcing_apollo_attempts_region_check', attempt, { region: 'CA' }),
  bad(attempts, 'sourcing_apollo_attempts_page_check', attempt, { page: 0 }),
  bad(attempts, 'sourcing_apollo_attempts_state_check', attempt, { state: 'bad' }),
  bad(attempts, 'sourcing_apollo_attempts_request_id_check', attempt, { request_id: 'x'.repeat(201) }),
  bad(attempts, 'sourcing_apollo_attempts_failure_code_check', attempt, { failure_code: 'x'.repeat(81) }),
  bad(attempts, 'sourcing_apollo_attempts_returned_count_check', attempt, { returned_count: -1 }),
  bad(attempts, 'sourcing_apollo_attempts_created_count_check', attempt, { created_count: -1 }),
  bad(attempts, 'sourcing_apollo_attempts_workspace_id_allowance_id_fkey', attempt, { allowance_id: absent }),
  duplicate(attempts, 'sourcing_apollo_attempts_pkey', attempt, { page: 2 }),
  duplicate(attempts, 'sourcing_apollo_attempts_allowance_id_region_page_key', attempt, { id: absent }),
  duplicate(attempts, 'sourcing_apollo_attempts_workspace_id_id_key', attempt, { page: 2 }, true),
  bad(origins, 'sourcing_apollo_candidate_origins_candidate_revision_check', origin, { candidate_revision: 0 }),
  bad(origins, 'sourcing_apollo_candidate_origins_organization_name_check', origin, { organization_name: '' }),
  bad(origins, 'sourcing_apollo_candidate_origins_domain_check', origin, { domain: '' }),
  bad(origins, 'sourcing_apollo_candidate_origins_hq_city_check', origin, { hq_city: 'x'.repeat(151) }),
  bad(origins, 'sourcing_apollo_candidate_origins_hq_state_check', origin, { hq_state: 'CA' }),
  bad(origins, 'sourcing_apollo_candidate_origins_employee_count_check', origin, { employee_count: 0 }),
  bad(origins, 'sourcing_apollo_candidate_origins_workspace_id_candidate_id_fkey', origin, { candidate_id: absent }),
  bad(origins, 'sourcing_apollo_candidate_origins_workspace_id_attempt_id_fkey', origin, { attempt_id: absent }),
  duplicate(origins, 'sourcing_apollo_candidate_origins_pkey', origin, {}),
];
