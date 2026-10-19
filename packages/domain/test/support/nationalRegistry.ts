import { randomUUID } from 'node:crypto';
import { NATIONAL_DNC_COVERED_AREA_CODES } from '@fss/contracts';
import type { Queryable } from '../../db/queryable.ts';

/** Synthetic fixture observations only. Never accepted as actual acquisition evidence. */
export function testRegistryMetadata() {
  return { version: 1, parser_version: 'national-dnc-full-v1', artifacts: NATIONAL_DNC_COVERED_AREA_CODES.map(area_code => ({
    area_code, archive_sha256: 'a'.repeat(64), archive_bytes: 100,
    uncompressed_sha256: 'b'.repeat(64), uncompressed_bytes: 11, record_count: 1, crc32: '12345678',
  })) };
}
export interface TestRegistryOptions {
  readonly downloadedAt?: string;
  readonly publishedAt?: string;
  readonly revokedAt?: string | null;
  readonly e164s?: readonly { readonly e164: string; readonly result: 'clear' | 'match' }[];
}
export function testRegistrySnapshotRow(workspaceId: string, options: TestRegistryOptions = {}) {
  return { workspace_id: workspaceId, id: randomUUID(), receipt_reference: `test_dnc_${randomUUID()}`,
    downloaded_at: options.downloadedAt ?? '2026-09-01T00:00:00Z',
    published_at: options.publishedAt ?? '2026-09-15T00:00:00Z', complete: true,
    covered_area_codes: [...NATIONAL_DNC_COVERED_AREA_CODES], acquisition_id: randomUUID(),
    source_format: 'ftc_full_flat_comma_v1', validated_at: options.downloadedAt ?? '2026-09-01T00:00:00Z',
    validation_metadata: testRegistryMetadata() };
}
export async function publishTestRegistrySnapshot(db: Queryable, workspaceId: string, options: TestRegistryOptions = {}): Promise<string> {
  const row = testRegistrySnapshotRow(workspaceId, options);
  const keys = Object.keys(row);
  await db.query(`INSERT INTO national_registry_snapshots (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`, Object.values(row));
  for (const endpoint of options.e164s ?? []) await db.query(`INSERT INTO national_registry_endpoint_scrubs
    (workspace_id,snapshot_id,e164,scrubbed_at,result) VALUES($1,$2,$3,$4,$5)`,
  [workspaceId, row.id, endpoint.e164, row.published_at, endpoint.result]);
  if (options.revokedAt) await db.query('UPDATE national_registry_snapshots SET revoked_at=$3 WHERE workspace_id=$1 AND id=$2',
    [workspaceId, row.id, options.revokedAt]);
  return row.id;
}
