import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { applyMigrations } from '../../db/migrationRunner.ts';
import { readPhoneRegistryDecision } from '../../dial/registryCoverage.ts';
import { phoneFixture, type PhoneFixture } from './phoneHandoffFixtures.ts';
let db: TestDatabase;
let f: PhoneFixture;
beforeEach(async () => { db = await createTestDatabase({ throughVersion: 123 }); f = await phoneFixture(db); });
afterEach(async () => { await db.drop(); });
type Legacy = { complete?: boolean; revokedAt?: string; result?: 'clear' | 'match' | null; downloadedAt?: string; publishedAt?: string | null; scrubbedAt?: string; covered?: string[]; workspaceId?: string };
/** Intentionally persisted pre0124 history. Never disable a latest-schema trigger. */
async function legacy(value: Legacy = {}) {
  const w = value.workspaceId ?? f.w;
  const id = (await db.session.query<{ id: string }>(`INSERT INTO national_registry_snapshots
    (workspace_id,receipt_reference,downloaded_at,published_at,complete,covered_area_codes,revoked_at)
    VALUES($1,'legacy_test_only',$2,$3,$4,$5,$6) RETURNING id`, [w, value.downloadedAt ?? '2026-09-01T00:00:00Z',
    value.publishedAt === undefined ? '2026-09-15T00:00:00Z' : value.publishedAt, value.complete ?? true, value.covered ?? ['401'], value.revokedAt ?? null])).rows[0]!.id;
  if (value.result !== null) await db.session.query(`INSERT INTO national_registry_endpoint_scrubs(workspace_id,snapshot_id,e164,scrubbed_at,result)
    VALUES($1,$2,$3,$4,$5)`, [w,id,f.policy.alpha.e164,value.scrubbedAt ?? '2026-09-15T00:00:00Z',value.result ?? 'clear']);
  return id;
}
async function read(e164 = f.policy.alpha.e164, at = f.policy.insideWindow) {
  await applyMigrations(db.session);
  return await readPhoneRegistryDecision(f.context, e164, at);
}
describe('latest-schema reader still distrusts inherited legacy registry evidence', () => {
  it('refuses no evidence', async () => { expect(await read()).toEqual({ ok: false, reason: 'dnc_coverage_unknown' }); });
  it.each([{ covered: ['212'] }, { workspaceId: 'beta' }])('refuses uncovered or cross-workspace evidence %j', async value => {
    await legacy(value.workspaceId ? { workspaceId: f.seeded.beta.workspaceId } : value);
    expect(await read()).toEqual({ ok: false, reason: 'dnc_coverage_unknown' });
  });
  it('accepts only fresh published covered complete exact-endpoint scrub', async () => {
    const id = await legacy();
    expect(await read()).toMatchObject({ ok: true, snapshotId: id, at: f.policy.insideWindow });
    expect(await readPhoneRegistryDecision(f.context, '+442079460123', f.policy.insideWindow)).toEqual({ ok: false, reason: 'dnc_coverage_unknown' });
  });
  it.each([
    { complete: false }, { revokedAt: '2026-09-16T00:00:00Z' }, { result: null },
    { downloadedAt: '2026-08-01T00:00:00Z' }, { downloadedAt: '2026-09-17T00:00:00Z', publishedAt: '2026-09-17T00:00:00Z' },
    { scrubbedAt: '2026-08-31T23:59:59Z' }, { scrubbedAt: '2026-09-17T00:00:00Z' },
  ] satisfies Legacy[])('fails closed for inherited invalid evidence %j', async value => {
    await legacy(value); expect(await read()).toEqual({ ok: false, reason: 'dnc_coverage_unknown' });
  });
  it.each([
    [{ complete: false }, 'dnc_coverage_unknown'], [{ result: null }, 'dnc_coverage_unknown'],
    [{ result: 'match' }, 'dnc_registry_match'], [{ revokedAt: '2026-09-16T00:00:00Z' }, 'dnc_coverage_unknown'],
  ] as const)('never falls back to older clearance after %j', async (value, reason) => {
    await legacy(); await legacy({ ...value, publishedAt: '2026-09-16T01:00:00Z' });
    expect(await read()).toEqual({ ok: false, reason });
  });
  it('ignores drafts but never treats them as clearance', async () => {
    await legacy({ publishedAt: null }); expect(await read()).toEqual({ ok: false, reason: 'dnc_coverage_unknown' });
  });
  it('refuses at exact31day boundary and still refuses known match on stale evidence', async () => {
    await legacy({ result: 'match', downloadedAt: '2026-08-01T00:00:00Z' });
    expect(await read()).toEqual({ ok: false, reason: 'dnc_registry_match' });
  });
  it('refuses clear at exact31day boundary', async () => {
    await legacy(); expect(await read(f.policy.alpha.e164, '2026-10-02T00:00:00Z')).toEqual({ ok: false, reason: 'dnc_coverage_unknown' });
  });
});
