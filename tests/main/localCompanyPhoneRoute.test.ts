import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { openDatabase, closeDatabase, type AppDatabase } from '../../src/main/db/database';
import { inspectDatabaseEncryption } from '../../src/main/db/databaseEncryption';
import { migrateToLatest } from '../../src/main/db/migrate';
import { AccountRepository } from '../../src/main/domain/accounts/accountRepository';
import { exportSelectedAccountRecord } from '../../src/main/delegation/selectedAccountSnapshot';
import type { AccountRoute } from '../../src/shared/contracts/accountContract';
import { companyPhoneRouteReceiptSchema, type AdmitCompanyPhoneRoute } from '../../src/shared/contracts/localCompanyPhoneRouteContract';
import { createTempDatabase, createTestWorkspaceKey } from '../fixtures/tempDatabase';

// Real repository over a disposable encrypted database. Nothing here calls, verifies that a number answers, or reaches a worker.
const T0 = '2026-09-15T18:00:00.000Z', T1 = '2026-09-15T18:01:00.000Z', T2 = '2026-09-15T18:02:00.000Z', T3 = '2026-09-15T18:03:00.000Z';
const PHONE = '+14015723322', URL = 'https://lenoxmanagement.com/';
// David's real quote from the 2026-09-16 walkthrough: the whole "Contact Us" block of the saved Lenox source.
const lenoxQuote = 'Contact Us\n\n380 Broadway Providence, Rhode Island 02909\n\ninfo@lenoxmanagement.com\n\n401-572-3322';
const lenox = 'Lenox Management\n\nProperty management, leasing and REO services across Rhode Island and Southeastern Massachusetts since 2004.\n\n'
  + lenoxQuote + '\n\nOur in-house maintenance team coordinates repairs for the properties we manage.';
const ids = { next: randomUUID };
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
function allRows(db: AppDatabase) {
  const tables = db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
  return tables.map(row => [row.name, db.raw.prepare(`SELECT * FROM "${row.name}"`).all()]);
}
type SeedRoute = Pick<AccountRoute, 'channel' | 'value' | 'purpose' | 'verification'>;
async function fixture(options: { excerpt?: string; routes?: SeedRoute[] } = {}) {
  const temp = createTempDatabase(), key = createTestWorkspaceKey(); let db = openDatabase({ path: temp.path, key }); let now = T0;
  const clock = { now: () => now }, migration = { workspaceKey: key, backupDirectory: `${temp.path}.backups` };
  await migrateToLatest(db, migration);
  const repo = () => new AccountRepository({ database: db, clock, ids, sourcePolicy: { attest: source => source.sha256 === sha(source.excerpt) } });
  const account = repo().create({ commandId: randomUUID(), name: 'Lenox Management', domain: 'lenoxmanagement.com' });
  const excerpt = options.excerpt ?? lenox, sourceId = randomUUID();
  now = T1;
  repo().admitEvidence({ commandId: randomUUID(), accountId: account.id, expectedVersion: 1, claims: [],
    sources: [{ id: sourceId, url: URL, fetchedAt: T1, sha256: sha(excerpt), excerpt, permitted: true }],
    routes: (options.routes ?? []).map(route => ({ ...route, id: randomUUID(), accountId: account.id, personId: null, evidenceIds: [sourceId] })) });
  now = T2;
  const request: AdmitCompanyPhoneRoute = { commandId: randomUUID(), accountId: account.id, expectedAccountVersion: 2, phone: PHONE, sourceId, quote: lenoxQuote,
    selection: 'published_company_business_phone' };
  const routeRows = () => db.raw.prepare('SELECT id,account_id,version,person_id,channel,value,purpose,verification,admitted_at FROM pm_account_routes ORDER BY rowid').all();
  const evidenceRows = () => db.raw.prepare('SELECT account_id,route_id,route_version,source_id FROM pm_account_route_evidence ORDER BY rowid').all();
  const version = () => (db.raw.prepare('SELECT version FROM pm_accounts WHERE id=?').get(account.id) as { version: number }).version;
  return { get db() { return db; }, repo, account, sourceId, request, routeRows, evidenceRows, version, setNow: (at: string) => { now = at; },
    async reopen() { closeDatabase(db); db = openDatabase({ path: temp.path, key }); await migrateToLatest(db, migration); },
    close() { closeDatabase(db); key.bytes.fill(0); temp.cleanup(); } };
}

describe('reviewed business phone route (real encrypted repository)', () => {
  it('admits the Lenox business line from the whole Contact Us block: one route, one evidence link, version bump, recorded command, exact replay and export', async () => {
    const f = await fixture();
    try {
      expect(f.routeRows()).toEqual([]);
      const receipt = f.repo().admitReviewedBusinessPhone(f.request);
      expect(companyPhoneRouteReceiptSchema.parse(receipt)).toEqual(receipt);
      expect(receipt).toEqual({ commandId: f.request.commandId, accountId: f.account.id, accountVersion: 3, selection: 'published_company_business_phone',
        route: { routeId: expect.any(String), routeVersion: 1, phone: PHONE, personId: null },
        publication: { sourceId: f.sourceId, url: URL, sha256: sha(lenox), fetchedAt: T1, quote: lenoxQuote } });
      expect(f.routeRows()).toEqual([{ id: receipt.route.routeId, account_id: f.account.id, version: 1, person_id: null, channel: 'phone', value: PHONE,
        purpose: 'business', verification: 'published', admitted_at: T2 }]);
      expect(f.evidenceRows()).toEqual([{ account_id: f.account.id, route_id: receipt.route.routeId, route_version: 1, source_id: f.sourceId }]);
      expect(f.version()).toBe(3);
      expect(f.db.raw.prepare('SELECT account_id,account_version,created_at FROM pm_account_commands WHERE command_id=?').get(f.request.commandId))
        .toEqual({ account_id: f.account.id, account_version: 3, created_at: T2 });
      const detail = f.repo().readLocalCompanyDetail(f.account.id, T2);
      expect(detail.snapshot.routes).toEqual([{ id: receipt.route.routeId, accountId: f.account.id, version: 1, personId: null, channel: 'phone', value: PHONE,
        purpose: 'business', verification: 'published', evidenceIds: [f.sourceId] }]);
      // The same command with the same reviewed values replays the identical receipt and writes nothing, before and after a restart.
      const after = allRows(f.db);
      expect(f.repo().admitReviewedBusinessPhone(f.request)).toEqual(receipt);
      expect(allRows(f.db)).toEqual(after);
      expect(() => f.repo().admitReviewedBusinessPhone({ ...f.request, quote: '401-572-3322' })).toThrow(/fingerprint/);
      expect(allRows(f.db)).toEqual(after);
      await f.reopen();
      expect(f.repo().admitReviewedBusinessPhone(f.request)).toEqual(receipt);
      expect(allRows(f.db)).toEqual(after);
      expect(inspectDatabaseEncryption(f.db)).toMatchObject({ encrypted: true, integrity: 'ok' });
      // Read-only selected export (what a later lane sends) carries the route with its single evidence source.
      const record = exportSelectedAccountRecord({ database: f.db, workspaceId: 'phone-route-workspace', researchRevision: 1, accountId: f.account.id, asOf: T2 });
      expect(record.account.version).toBe(3);
      expect(record.routes).toEqual(detail.snapshot.routes);
      expect(record.history.map(entry => [entry.at, entry.account.version, entry.routes.length])).toEqual([[T0, 1, 0], [T1, 2, 0], [T2, 3, 1]]);
      expect(allRows(f.db)).toEqual(after);
    } finally { f.close(); }
  });
  it('reviewing the same number again reuses the saved route without a duplicate row', async () => {
    const f = await fixture();
    try {
      const first = f.repo().admitReviewedBusinessPhone(f.request);
      f.setNow(T3);
      const second = f.repo().admitReviewedBusinessPhone({ ...f.request, commandId: randomUUID(), expectedAccountVersion: 3 });
      expect(second.route).toEqual(first.route);
      expect(second.accountVersion).toBe(4);
      expect(f.routeRows()).toHaveLength(1); expect(f.evidenceRows()).toHaveLength(1); expect(f.version()).toBe(4);
      expect(f.repo().admitReviewedBusinessPhone(f.request)).toEqual(first);
    } finally { f.close(); }
  });
  it('reuses a saved business route whose value was written differently, matching on the normalised number', async () => {
    const f = await fixture({ routes: [{ channel: 'phone', value: '(401) 572-3322', purpose: 'business', verification: 'confirmed' }] });
    try {
      const [seeded] = f.routeRows() as { id: string }[];
      const receipt = f.repo().admitReviewedBusinessPhone(f.request);
      expect(receipt.route).toEqual({ routeId: seeded.id, routeVersion: 1, phone: PHONE, personId: null });
      expect(f.routeRows()).toHaveLength(1);
    } finally { f.close(); }
  });
  it.each<[string, (request: AdmitCompanyPhoneRoute) => AdmitCompanyPhoneRoute, RegExp | typeof ZodError]>([
    ['a stale account version', request => ({ ...request, expectedAccountVersion: 1 }), /unavailable/],
    ['a quote that is not verbatim in the saved excerpt', request => ({ ...request, quote: 'Contact Us\n401-572-3322' }), /unavailable/],
    ['a quote without the number', request => ({ ...request, quote: 'Contact Us\n\n380 Broadway Providence, Rhode Island 02909' }), /unavailable/],
    ['a number the source never mentions', request => ({ ...request, phone: '+14015550199' }), /unavailable/],
    ['a clipped occurrence', request => ({ ...request, quote: '572-3322' }), /unavailable/],
    ['an unknown source', request => ({ ...request, sourceId: randomUUID() }), /unavailable/],
    ['a value that is not E.164', request => ({ ...request, phone: '401-572-3322' }), ZodError],
    ['the inbox selection', request => ({ ...request, selection: 'published_company_business_inbox' as unknown as 'published_company_business_phone' }), ZodError],
  ])('rejects %s without any partial writes', async (_name, change, expected) => {
    const f = await fixture();
    try {
      const before = allRows(f.db);
      expect(() => f.repo().admitReviewedBusinessPhone(change(f.request))).toThrow(expected);
      expect(allRows(f.db)).toEqual(before);
    } finally { f.close(); }
  });
  it('never publishes from a source that was not permitted: such a source is refused at admission, by the schema, and as a review target', async () => {
    const f = await fixture();
    try {
      const unpermitted = { id: randomUUID(), url: 'https://lenoxmanagement.com/tenants', fetchedAt: T2, excerpt: 'Office line 401-555-0100', permitted: false, sha256: sha('Office line 401-555-0100') };
      expect(() => f.repo().admitEvidence({ commandId: randomUUID(), accountId: f.account.id, expectedVersion: 2, sources: [unpermitted], claims: [], routes: [] })).toThrow(/attestation/);
      expect(() => f.db.raw.prepare('INSERT INTO pm_account_sources(id,account_id,source_key,url,fetched_at,sha256,excerpt,permitted,admitted_at) VALUES(?,?,?,?,?,?,?,0,?)')
        .run(unpermitted.id, f.account.id, 'k'.repeat(64), unpermitted.url, T2, unpermitted.sha256, unpermitted.excerpt, T2)).toThrow(/permitted/);
      const before = allRows(f.db);
      expect(() => f.repo().admitReviewedBusinessPhone({ ...f.request, phone: '+14015550100', sourceId: unpermitted.id, quote: 'Office line 401-555-0100' })).toThrow(/unavailable/);
      expect(allRows(f.db)).toEqual(before);
    } finally { f.close(); }
  });
  it('a saved tenant emergency route with the same number makes the review ambiguous', async () => {
    const f = await fixture({ routes: [{ channel: 'phone', value: PHONE, purpose: 'tenant_emergency', verification: 'published' }] });
    try {
      const before = allRows(f.db);
      expect(() => f.repo().admitReviewedBusinessPhone(f.request)).toThrow(/ambiguous/);
      expect(allRows(f.db)).toEqual(before);
    } finally { f.close(); }
  });
  it('a saved line naming the number as a tenant, resident, emergency or after-hours line blocks admission, unlike unrelated emergency wording', async () => {
    const blocked = await fixture({ excerpt: lenox + '\n\nTenant emergencies: call 401-572-3322 after hours.' });
    try {
      const before = allRows(blocked.db);
      expect(() => blocked.repo().admitReviewedBusinessPhone(blocked.request)).toThrow(/conflicts/);
      expect(allRows(blocked.db)).toEqual(before);
    } finally { blocked.close(); }
    const unrelated = await fixture({ excerpt: lenox + '\n\nWe offer 24/7 emergency maintenance through our tenant portal.' });
    try { expect(unrelated.repo().admitReviewedBusinessPhone(unrelated.request).route.phone).toBe(PHONE); } finally { unrelated.close(); }
  });
});
