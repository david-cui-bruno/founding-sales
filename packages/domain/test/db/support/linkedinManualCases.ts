import { randomUUID } from 'node:crypto';
import type { SessionQueryable, SqlParameter } from '../../../db/queryable.ts';
import { repositoryContext, workspaceScope } from '../../../db/workspaceScope.ts';
import type { TwoWorkspaces } from './fixtures.ts';
import type { SeededCrm } from './crmFixtures.ts';
import { seedManualLinkedin } from './linkedinManualFixture.ts';

interface Fixture { session: SessionQueryable; seeded: TwoWorkspaces; crm: SeededCrm; holdId: string }
interface Case { constraint: string; run(f: Fixture): Promise<unknown> }
type Row = Record<string, SqlParameter>;
const ledgers = 'linkedin_manual_ledgers';
const entries = 'linkedin_manual_entries';
const stops = 'linkedin_manual_stops';
const missing = '00000000-0000-4000-8000-000000000999';

async function insert(f: Fixture, table: string, row: Row) {
  const keys = Object.keys(row);
  return f.session.query(`INSERT INTO ${table}(${keys.join(',')}) ${'sequence' in row ? 'OVERRIDING SYSTEM VALUE ' : ''}VALUES(${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, Object.values(row));
}

/** Valid existing CRM identity and ledger rows, inside the runner's rollback-only transaction. */
async function seed(f: Fixture, table: string): Promise<Row> {
  const workspace = f.seeded.alpha;
  const context = repositoryContext(workspaceScope(workspace.workspaceId, {
    kind: 'user', userId: workspace.salesperson.userId, role: 'salesperson',
  }), f.session);
  const binding = await seedManualLinkedin(context, f.crm.alpha.firmId);
  const ledger: Row = {
    workspace_id: workspace.workspaceId, id: binding.ledgerId, owner_user_id: workspace.salesperson.userId,
    account_id: binding.accountId, person_id: binding.personId, firm_id: binding.firmId,
    claim_id: binding.claimId, claim_revision: binding.claimRevision,
    relationship_id: binding.relationshipId, relationship_revision: binding.relationshipRevision,
  };
  if (table === ledgers) return ledger;
  await insert(f, ledgers, ledger);
  const entry: Row = {
    workspace_id: workspace.workspaceId, ledger_id: binding.ledgerId, entry_id: randomUUID(), revision: 1,
    kind: 'refusal', connection_state: null, occurred_at: '2026-10-01T13:00:00Z',
    voided: false, correction: null, actor_user_id: workspace.salesperson.userId,
  };
  if (table === entries) return entry;
  await insert(f, entries, entry);
  return { workspace_id: workspace.workspaceId, person_id: binding.personId, firm_id: binding.firmId,
    entry_id: entry['entry_id']!, entry_revision: 1, hold_id: f.holdId };
}

const bad = (table: string, constraint: string, patch: Row): Case => ({
  constraint,
  run: async f => insert(f, table, { ...await seed(f, table), ...patch }),
});
const duplicate = (table: string, constraint: string, patch: () => Row = () => ({})): Case => ({
  constraint,
  run: async f => {
    const row = await seed(f, table);
    await insert(f, table, row);
    return insert(f, table, { ...row, ...patch() });
  },
});

export const LINKEDIN_MANUAL_CONSTRAINT_CASES: readonly Case[] = [
  bad(ledgers, `${ledgers}_claim_revision_check`, { claim_revision: 0 }),
  bad(ledgers, `${ledgers}_relationship_revision_check`, { relationship_revision: 0 }),
  bad(ledgers, `${ledgers}_workspace_id_owner_user_id_fkey`, { owner_user_id: missing }),
  bad(ledgers, `${ledgers}_workspace_id_account_id_fkey`, { account_id: missing }),
  bad(ledgers, `${ledgers}_workspace_id_person_id_fkey`, { person_id: missing }),
  bad(ledgers, `${ledgers}_workspace_id_firm_id_fkey`, { firm_id: missing }),
  bad(ledgers, 'linkedin_manual_ledgers_workspace_id_claim_id_claim_revisi_fkey', { claim_id: missing }),
  bad(ledgers, 'linkedin_manual_ledgers_workspace_id_relationship_id_relat_fkey', { relationship_id: missing }),
  duplicate(ledgers, `${ledgers}_pkey`),
  duplicate(ledgers, 'linkedin_manual_ledgers_workspace_id_owner_user_id_account__key', () => ({ id: randomUUID() })),
  bad(entries, `${entries}_revision_check`, { revision: 0, correction: 'date' }),
  bad(entries, `${entries}_kind_check`, { kind: 'native_observation' }),
  bad(entries, `${entries}_connection_state_check`, { kind: 'connection', connection_state: 'native_accepted' }),
  bad(entries, `${entries}_correction_check`, { revision: 2, correction: 'overwrite' }),
  bad(entries, `${entries}_check`, { connection_state: 'pending' }),
  bad(entries, `${entries}_check1`, { revision: 2 }),
  bad(entries, `${entries}_check2`, { voided: true }),
  bad(entries, `${entries}_workspace_id_ledger_id_fkey`, { ledger_id: missing }),
  bad(entries, `${entries}_workspace_id_actor_user_id_fkey`, { actor_user_id: missing }),
  duplicate(entries, `${entries}_pkey`),
  { constraint: `${entries}_sequence_key`, run: async f => {
    const row = await seed(f, entries);
    const first = await insert(f, entries, row);
    return insert(f, entries, { ...row, entry_id: randomUUID(), sequence: first.rows[0]!['sequence'] as string });
  } },
  bad(stops, `${stops}_workspace_id_person_id_fkey`, { person_id: missing }),
  bad(stops, `${stops}_workspace_id_firm_id_fkey`, { firm_id: missing }),
  bad(stops, `${stops}_workspace_id_entry_id_entry_revision_fkey`, { entry_revision: 99 }),
  bad(stops, `${stops}_workspace_id_hold_id_fkey`, { hold_id: missing }),
  duplicate(stops, `${stops}_pkey`),
];
