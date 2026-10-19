import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { readPhoneRegistryDecision } from '../../dial/registryCoverage.ts';
import { phoneFixture, type PhoneFixture } from './phoneHandoffFixtures.ts';
let db: TestDatabase;
let f: PhoneFixture;
beforeAll(async () => { db = await createTestDatabase(); f = await phoneFixture(db); });
afterAll(async () => { await db.drop(); });
beforeEach(async () => { await db.session.query('BEGIN'); return async () => { await db.session.query('ROLLBACK'); }; });
const read = async () => await readPhoneRegistryDecision(f.context, f.policy.alpha.e164, f.policy.insideWindow);
describe('real registry evidence, never internal suppression masquerading as clearance', () => {
  it('refuses no evidence, an uncovered endpoint, and workspace-crossing evidence', async () => {
    expect(await read()).toEqual({ ok: false, reason: 'dnc_coverage_unknown' });
    await f.publish({ covered: ['212'], result: null });
    expect(await read()).toEqual({ ok: false, reason: 'dnc_coverage_unknown' });
    await db.session.query("UPDATE national_registry_snapshots SET workspace_id=$1", [f.seeded.beta.workspaceId]);
    expect(await read()).toEqual({ ok: false, reason: 'dnc_coverage_unknown' });
  });
  it('accepts a fresh published covered complete exact-endpoint scrub only', async () => {
    const id = await f.publish();
    expect(await read()).toMatchObject({ ok: true, snapshotId: id, at: f.policy.insideWindow });
    expect(await readPhoneRegistryDecision(f.context, '+442079460123', f.policy.insideWindow)).toEqual({ ok: false, reason: 'dnc_coverage_unknown' });
  });
  it.each([
    ['incomplete', { complete: false }], ['revoked', { revokedAt: '2026-09-16T00:00:00Z' }],
    ['missing scrub', { result: null }], ['stale', { downloadedAt: '2026-08-01T00:00:00Z' }],
    ['future', { downloadedAt: '2026-09-17T00:00:00Z', publishedAt: '2026-09-17T00:00:00Z' }],
  ] as const)('fails closed for %s', async (_name, value) => {
    await f.publish(value);
    expect(await read()).toEqual({ ok: false, reason: 'dnc_coverage_unknown' });
  });
  it.each([
    ['incomplete', { complete: false }, 'dnc_coverage_unknown'],
    ['missing scrub', { result: null }, 'dnc_coverage_unknown'],
    ['match', { result: 'match' }, 'dnc_registry_match'],
    ['revoked', { revokedAt: '2026-09-16T00:00:00Z' }, 'dnc_coverage_unknown'],
  ] as const)('never falls back to older clearance when latest is %s', async (_name, value, reason) => {
    await f.publish();
    await f.publish({ ...value, publishedAt: '2026-09-16T01:00:00Z' });
    expect(await read()).toEqual({ ok: false, reason });
  });
  it('ignores drafts but refuses an outdated endpoint scrub', async () => {
    await f.publish();
    await db.session.query("UPDATE national_registry_endpoint_scrubs SET scrubbed_at='2026-08-31T23:59:59Z'");
    expect(await read()).toEqual({ ok: false, reason: 'dnc_coverage_unknown' });
    await db.session.query("UPDATE national_registry_snapshots SET published_at=NULL");
    expect(await read()).toEqual({ ok: false, reason: 'dnc_coverage_unknown' });
  });
});
