import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { seedTwoWorkspaces } from './support/fixtures.ts';
import { publishTestRegistrySnapshot, testRegistrySnapshotRow, testRegistryMetadata } from '../support/nationalRegistry.ts';
let db: TestDatabase;
let w: string;
beforeAll(async () => {
  db = await createTestDatabase(); w = (await seedTwoWorkspaces(db.session)).alpha.workspaceId;
});
afterAll(async () => { await db.drop(); });
async function insert(row: Record<string, unknown>) {
  const keys = Object.keys(row);
  return await db.session.query(`INSERT INTO national_registry_snapshots(${keys.join(',')}) VALUES(${keys.map((_, i) => `$${i + 1}`).join(',')})`, Object.values(row));
}
describe('0124 real publication constraints and immutable body-free metadata', () => {
  it('accepts ordinary exact-five-code test metadata with guard enabled, then allows only revocation', async () => {
    const id = await publishTestRegistrySnapshot(db.session, w);
    await expect(db.session.query('UPDATE national_registry_snapshots SET complete=false WHERE id=$1', [id])).rejects.toThrow('immutable');
    await expect(db.session.query('UPDATE national_registry_snapshots SET published_at=NULL WHERE id=$1', [id])).rejects.toThrow('immutable');
    await db.session.query('UPDATE national_registry_snapshots SET revoked_at=clock_timestamp() WHERE id=$1', [id]);
    await expect(db.session.query('UPDATE national_registry_snapshots SET revoked_at=NULL WHERE id=$1', [id])).rejects.toThrow('immutable');
  });
  it('rejects incomplete publication and legacy-shaped publication without validated evidence', async () => {
    await expect(insert({ workspace_id: w, receipt_reference: 'test_only', downloaded_at: '2026-09-01', published_at: '2026-09-15', complete: true, covered_area_codes: ['401'] })).rejects.toThrow('validated');
    await expect(insert({ ...testRegistrySnapshotRow(w), complete: false })).rejects.toThrow('validated');
  });
  it('rejects wrong code set, extra copied content, malformed digest and repeated code as exact constraint', async () => {
    for (const metadata of [
      { ...testRegistryMetadata(), raw: 'forbidden' },
      { ...testRegistryMetadata(), artifacts: testRegistryMetadata().artifacts.map(item => ({ ...item, archive_sha256: 'bad' })) },
      { ...testRegistryMetadata(), artifacts: testRegistryMetadata().artifacts.map(item => ({ ...item, area_code: '401' })) },
    ]) await expect(insert({ ...testRegistrySnapshotRow(w), published_at: null, validation_metadata: metadata })).rejects.toMatchObject({ constraint: 'national_registry_snapshots_import_metadata' });
    await expect(insert({ ...testRegistrySnapshotRow(w), published_at: null, covered_area_codes: ['817','972','469','214','940'] })).rejects.toMatchObject({ constraint: 'national_registry_snapshots_import_metadata' });
  });
  it('requires acquisition idempotency and preserves no-runtime-delete privilege', async () => {
    const row = testRegistrySnapshotRow(w); await insert(row);
    await expect(insert({ ...row, id: crypto.randomUUID() })).rejects.toMatchObject({ constraint: 'national_registry_snapshots_acquisition' });
    expect((await db.session.query("SELECT has_table_privilege('app_runtime','national_registry_snapshots','DELETE') AS allowed")).rows).toEqual([{ allowed: false }]);
  });
});
