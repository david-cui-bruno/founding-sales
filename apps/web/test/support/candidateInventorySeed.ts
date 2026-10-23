import assert from 'node:assert/strict';
import { repositoryContext, workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import { withTransaction } from '@fss/domain/db/queryable.ts';
import { saveCandidate, reviewCandidate } from '@fss/domain/sourcing/candidates.ts';
import type { CandidateInput } from '@fss/contracts';
import type { ThinHostApp } from './thinHostApp.ts';

/** Synthetic retained observations only. Normal domain seed operations do not run
 * source checks, qualification, acquisition, provider work or sending. */
export async function seedCandidateInventory(app: ThinHostApp) {
  const f = app.fixture;
  const rows: { id: string; status: 'needs_review' | 'kept' | 'dismissed'; input: CandidateInput }[] = [];
  for (const [workspace, count] of [[f.alpha, 53], [f.beta, 1]] as const) {
    const context = repositoryContext(workspaceScope(workspace.workspaceId, { kind: 'user', userId: workspace.admin.userId, role: 'admin' }), f.db);
    for (let index = 0; index < count; index += 1) {
      const input: CandidateInput = {
        firmName: `Inventory ${workspace === f.alpha ? 'Alpha' : 'Beta'} ${String(index).padStart(2, '0')}`,
        website: `https://inventory-${workspace === f.alpha ? 'alpha' : 'beta'}-${index}.example.test/`,
        locality: 'Dallas', region: 'TX', signal: 'fit_only',
        evidence: `Retained synthetic observation ${index}, not qualification or contact authority.`,
        sourceUrl: `https://source.example.test/observation-${index}`,
        observedOn: '2026-10-20', preparedBy: 'Synthetic inventory acceptance',
      };
      const saved = await withTransaction(f.db, () => saveCandidate(context, input));
      assert(saved.ok, saved.ok ? '' : saved.reason);
      const status = index === 51 ? 'kept' : index === 52 ? 'dismissed' : 'needs_review';
      if (status !== 'needs_review') {
        const reviewed = await withTransaction(f.db, () => reviewCandidate(context, { id: saved.value.id, expectedRevision: 1, status }));
        assert(reviewed.ok, reviewed.ok ? '' : reviewed.reason);
      }
      if (workspace === f.alpha) rows.push({ id: saved.value.id, status, input });
    }
  }
  return rows;
}

/** Compare product records after fixture setup. Auth/session bookkeeping is not
 * included. No workers are started by the HTTPS host. */
export async function inventoryProductSnapshot(app: ThinHostApp) {
  const result: Record<string, unknown[]> = {};
  for (const table of ['sourcing_candidates', 'sourcing_qualification_runs', 'jobs', 'command_receipts', 'contacts', 'email_addresses', 'phone_routes', 'sequence_enrollments', 'outbound_messages', 'sourcing_admissions']) {
    result[table] = (await app.fixture.db.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
  }
  return result;
}
