import { randomUUID } from 'node:crypto';
import type { SessionQueryable } from '../../../db/queryable.ts';
import type { TwoWorkspaces } from './fixtures.ts';
import type { SeededCrm } from './crmFixtures.ts';
import {currentUSSupplyCases} from './currentUSSupplyCases.ts';
type Fixture = { session: SessionQueryable; seeded: TwoWorkspaces; crm: SeededCrm };
type Row = Record<string, unknown>;
type Case = { constraint: string; run: (fixture: Fixture) => Promise<unknown> };
const missing = '00000000-0000-4000-8000-000000000131';
const table = 'sourcing_automatic_research_firms';
const insert = (f: Fixture, target: string, row: Row) => f.session.query(`INSERT INTO ${target}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map((_, i) => `$${String(i + 1)}`).join(',')})`, Object.values(row));
async function publication(f: Fixture,slot=0): Promise<Row> {
  const workspace = f.seeded.alpha.workspaceId, candidate = randomUUID(), run = randomUUID(), attempt = randomUUID();
  const source = `https://${randomUUID()}.example.test/`;
  await insert(f, 'sourcing_candidates', { workspace_id: workspace, id: candidate, identity_key: randomUUID().replaceAll('-', '').repeat(2), payload: '{}', status: 'needs_review', revision: 1 });
  await insert(f, 'sourcing_qualification_runs', { workspace_id: workspace, id: run, candidate_id: candidate, candidate_revision: 1, fingerprint: 'e'.repeat(64), prompt_version: 'fixture', policy_version: 'fixture', model_name: 'fixture' });
  await insert(f, 'sourcing_discovery_attempts', { workspace_id: workspace, id: attempt, query_id: 'controlled', query: 'controlled catalog', state: 'complete',slot });
  await insert(f, 'sourcing_discovery_hits', { workspace_id: workspace, source_url: source, attempt_id: attempt, candidate_id: candidate, native_result: JSON.stringify({ url: source }) });
  return { workspace_id: workspace, id: randomUUID(), candidate_id: candidate, run_id: run, candidate_revision: 1, revision: 1, firm_id: f.crm.alpha.firmId, owner_user_id: f.seeded.alpha.admin.userId, source_kind: 'search_hit', source_url: source, source_attempt_id: attempt, search_source_url: source, search_attempt_id: attempt, evidence_fingerprint: 'a'.repeat(64) };
}
const checks: [string, Row][] = [
  [`${table}_candidate_revision_check`, { candidate_revision: 0 }],
  [`${table}_revision_check`, { revision: 0 }],
  [`${table}_source_kind_check`, { source_kind: 'raw_discovery' }],
  [`${table}_evidence_fingerprint_check`, { evidence_fingerprint: 'invalid' }],
  [`${table}_check`, { search_source_url: null }],
];
const foreign: [string, Row][] = [
  ['sourcing_automatic_research_f_workspace_id_candidate_id_ru_fkey', { run_id: missing }],
  [`${table}_workspace_id_firm_id_fkey`, { firm_id: missing }],
  ['sourcing_automatic_research_fir_workspace_id_owner_user_id_fkey', { owner_user_id: missing }],
  ['sourcing_automatic_research_f_workspace_id_search_source_u_fkey', { search_source_url: 'https://absent.example.test/' }],
  [`${table}_search_attempt_id_fkey`, { search_attempt_id: missing }],
  ['sourcing_automatic_research_f_workspace_id_candidate_id_ap_fkey', { apollo_origin_revision: 1 }],
  ['sourcing_automatic_research_f_workspace_id_apollo_attempt__fkey', { apollo_attempt_id: missing }],
];
export const AUTOMATIC_SUPPLY_CONSTRAINT_CASES: readonly Case[] = [
  ...currentUSSupplyCases(publication,insert),
  ...checks.map(([constraint, change]) => ({ constraint, run: async (f: Fixture) => {
    const row = await publication(f);
    if (constraint === `${table}_source_kind_check`) await f.session.query(`ALTER TABLE ${table} DROP CONSTRAINT ${table}_check`);
    return insert(f, table, { ...row, ...change });
  } })),
  ...foreign.map(([constraint, change]) => ({ constraint, run: async (f: Fixture) => {
    const row = await publication(f);
    // Rolled-back privileged catalog case isolates each declarative FK.
    // Actual source/owner lineage and deletion are tested through real web acceptance.
    await f.session.query(`ALTER TABLE ${table} DROP CONSTRAINT ${table}_check`);
    return insert(f, table, { ...row, ...change });
  } })),
  ...[`${table}_pkey`, `${table}_workspace_id_candidate_id_key`].map(constraint => ({ constraint, run: async (f: Fixture) => {
    const row = await publication(f);
    await insert(f, table, row);
    if (constraint === `${table}_pkey`) await f.session.query(`ALTER TABLE ${table} DROP CONSTRAINT ${table}_workspace_id_candidate_id_key`);
    return insert(f, table, { ...row, ...(constraint.endsWith('_pkey') ? {} : { id: randomUUID() }) });
  } })),
];
export {publication as automaticSupplyPublicationRow};
