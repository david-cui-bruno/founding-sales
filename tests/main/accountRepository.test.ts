import { randomUUID, createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createPmFixture, PM_NOW } from '../fixtures/pmAccounts';

describe('PM account repository', () => {
  it('migrates genuine schema19 without altering people or organizations and creates no fake people/enrollment', async () => {
    const f = await createPmFixture();
    try {
      const input = { commandId: randomUUID(), name: 'Example PM', domain: 'example.invalid' };
      const account = f.repo.create(input);
      expect(account).toMatchObject({ name: input.name, domain: input.domain, version: 1 });
      expect(f.repo.create(input)).toEqual(account);
      expect(() => f.repo.create({ ...input, name: 'Changed' })).toThrow(/command/i);
      expect(f.db.raw.prepare('SELECT * FROM persons ORDER BY id').all()).toEqual(f.historicalPersons);
      expect(f.db.raw.prepare('SELECT * FROM organizations ORDER BY id').all()).toEqual(f.historicalOrganizations);
      expect(f.db.raw.prepare('SELECT * FROM cadence_enrollments').all()).toEqual([]);
      const second = f.repo.create({ ...input, commandId: randomUUID() });
      expect(second.id).not.toBe(account.id);
      expect(f.repo.listCandidates()).toHaveLength(2);
      expect(f.repo.snapshot(account.id, PM_NOW).portfolio).toEqual([]);
      expect(f.db.raw.pragma('foreign_key_check')).toEqual([]);
    } finally { f.close(); }
  });
});

describe('B1 allocated research and outbound SQL storage', () => {
  it('binds research evidence receipts to the same account and caps attempts while preserving unknown cost', async () => {
    const f = await createPmFixture();
    try {
      const create = { commandId: randomUUID(), name: 'Example PM', domain: null as string | null };
      const a = f.repo.create(create);
      const b = f.repo.create({ ...create, commandId: randomUUID() });
      const insert = (accountId: string, attempt: number, receipt: string | null) => f.db.raw.prepare(`INSERT INTO pm_account_research_jobs
        (id,account_id,command_id,fingerprint,limits_json,state,attempt,reserved_cost_micros,cost_micros,receipt_command_id,created_at,updated_at)
        VALUES(?,?,?,?,?,'parked',?,100,NULL,?,?,?)`).run(randomUUID(), accountId, randomUUID(), 'a'.repeat(64), '{"maxPages":2}', attempt, receipt, PM_NOW, PM_NOW);
      expect(() => insert(b.id, 1, create.commandId)).toThrow();
      expect(() => insert(a.id, 4, null)).toThrow();
      insert(a.id, 1, null);
      expect(f.db.raw.prepare('SELECT cost_micros FROM pm_account_research_jobs').get()).toEqual({ cost_micros: null });
    } finally { f.close(); }
  });
});

// Task 1 prospective source-only tests. Existing tests above remain unchanged.
import type { AccountSource, AccountLink } from '../../src/shared/contracts/accountContract';
import { localCompanyDetailSchema } from '../../src/shared/contracts/localWorkspaceContract';

type DetailFixture = Awaited<ReturnType<typeof createPmFixture>>;
function detailSqlState(f: DetailFixture) {
  const tables = f.db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
  return {
    changes: f.db.raw.prepare('SELECT total_changes() AS changes').get(),
    // Independent persisted rows, including command receipts, jobs and relationship joins.
    tables: tables.map(({ name }) => ({ name, rows: f.db.raw.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all() })),
  };
}
function seedDetail(f: DetailFixture, name: string, count: number) {
  const account = f.repo.create({ commandId: randomUUID(), name, domain: null });
  const sources: AccountSource[] = Array.from({ length: count }, (_, i) => ({
    id: randomUUID(), url: 'https://example.invalid/team', fetchedAt: PM_NOW,
    sha256: createHash('sha256').update(`${name} fictional admitted excerpt ${i}`).digest('hex'), excerpt: `${name} fictional admitted excerpt ${i}`, permitted: true,
  }));
  const receipt = f.repo.admitEvidence({ commandId: randomUUID(), accountId: account.id, expectedVersion: 1,
    sources, claims: [{ key: 'portfolio', kind: 'fact', value: { count: 123, measure: 'units', scope: 'managed' }, evidenceIds: [sources[0]!.id] }],
    routes: [{ id: randomUUID(), accountId: account.id, personId: null, channel: 'email', value: 'office@example.invalid',
      purpose: 'business', verification: 'published', evidenceIds: [sources[0]!.id] }],
  });
  const link: AccountLink = { id: randomUUID(), kind: 'person_role', personId: 'historical-person', role: 'Manager',
    relationship: 'Fictional source-listed role, not authority', authority: 'unconfirmed', authorityEvidenceIds: [],
    evidenceIds: [sources[0]!.id], validFrom: PM_NOW, validTo: null };
  f.repo.admitLinks({ commandId: randomUUID(), accountId: account.id, expectedVersion: receipt.version, links: [link] });
  return { account, sources, link };
}

describe('Task 1 complete selected local company read', () => {
  it('reads one real saved account without changing it', async () => {
    const f = await createPmFixture();
    try {
      const account = f.repo.create({ commandId: randomUUID(), name: 'Selected', domain: 'selected.invalid' });
      const snapshot = f.repo.snapshot(account.id, PM_NOW);
      const before = detailSqlState(f);
      expect(f.repo.readLocalCompanyDetail(account.id, PM_NOW)).toEqual({ scope: 'local_database', generatedAt: PM_NOW, snapshot, sources: [], links: [] });
      expect(f.repo.snapshot(account.id, PM_NOW)).toEqual(snapshot);
      expect(detailSqlState(f)).toEqual(before);
    } finally { f.close(); }
  });

  it('returns all 51 attested source records and only the selected account claims routes and links', async () => {
    const f = await createPmFixture();
    try {
      const selected = seedDetail(f, 'Selected', 51);
      const other = seedDetail(f, 'Other', 2);
      const before = detailSqlState(f);
      for (const saved of [selected, other]) {
        const detail = f.repo.readLocalCompanyDetail(saved.account.id, PM_NOW);
        expect(localCompanyDetailSchema.parse(detail)).toEqual(detail);
        expect(detail.snapshot).toEqual(f.repo.snapshot(saved.account.id, PM_NOW));
        expect(detail.sources).toHaveLength(saved.sources.length);
        expect([...detail.sources].sort((a, b) => a.id.localeCompare(b.id))).toEqual([...saved.sources].sort((a, b) => a.id.localeCompare(b.id)));
        expect(detail.links).toEqual([saved.link]);
        const sourceIds = new Set(detail.sources.map(source => source.id));
        expect(detail.snapshot.claims.every(claim => claim.evidenceIds.every(id => sourceIds.has(id)))).toBe(true);
        expect(detail.snapshot.routes.every(route => route.accountId === saved.account.id && route.evidenceIds.every(id => sourceIds.has(id)))).toBe(true);
        expect(detail.snapshot.portfolio.every(item => item.evidenceIds.every(id => sourceIds.has(id)))).toBe(true);
        // Verify database ownership independently of DTOs (AccountSource/AccountLink have no accountId field).
        expect(f.db.raw.prepare('SELECT id FROM pm_account_sources WHERE account_id=? ORDER BY id').all(saved.account.id))
          .toEqual([...sourceIds].sort().map(id => ({ id })));
        for (const table of ['pm_account_claim_evidence', 'pm_account_route_evidence']) {
          expect(f.db.raw.prepare(`SELECT e.source_id FROM ${table} e JOIN pm_account_sources s
            ON s.id=e.source_id AND s.account_id=e.account_id WHERE e.account_id=? ORDER BY e.source_id`).all(saved.account.id))
            .toEqual([{ source_id: saved.sources[0]!.id }]);
        }
        expect(f.db.raw.prepare(`SELECT e.source_id FROM pm_account_link_evidence e JOIN pm_account_sources s
          ON s.id=e.source_id AND s.account_id=e.account_id WHERE e.account_id=? ORDER BY e.source_id`).all(saved.account.id))
          .toEqual([{ source_id: saved.sources[0]!.id }]);
      }
      expect(detailSqlState(f)).toEqual(before);
    } finally { f.close(); }
  });

  it.each([
    ['at admission', PM_NOW, ['current', 'ended']],
    ['at exclusive end', '2026-09-09T12:00:00.000Z', ['current', 'future']],
  ] as const)('selects active links asOf %s without changing history', async (_label, asOf, expected) => {
    const f = await createPmFixture();
    try {
      const saved = seedDetail(f, 'Intervals', 1);
      const end = '2026-09-09T12:00:00.000Z';
      const ended = { ...saved.link, id: randomUUID(), relationship: 'ended', validTo: end };
      const future = { ...saved.link, id: randomUUID(), relationship: 'future', validFrom: end };
      f.repo.admitLinks({ commandId: randomUUID(), accountId: saved.account.id, expectedVersion: 3, links: [ended, future] });
      const before = detailSqlState(f);
      const detail = f.repo.readLocalCompanyDetail(saved.account.id, asOf);
      expect(detail.links.map(link => link.id === saved.link.id ? 'current' : link.relationship).sort()).toEqual([...expected].sort());
      expect(detail.links).toEqual(f.repo.listLinks(saved.account.id, asOf));
      expect(detail.generatedAt).toBe(asOf);
      expect(detailSqlState(f)).toEqual(before);
    } finally { f.close(); }
  });

  it.each(['missing', 'invalid account', 'invalid instant', 'before creation'] as const)('rejects %s instead of empty availability', async kind => {
    const f = await createPmFixture();
    try {
      const account = f.repo.create({ commandId: randomUUID(), name: 'Saved', domain: null });
      const before = detailSqlState(f);
      const id = kind === 'missing' ? 'missing' : kind === 'invalid account' ? '' : account.id;
      const at = kind === 'invalid instant' ? 'yesterday' : kind === 'before creation' ? '2026-09-07T12:00:00.000Z' : PM_NOW;
      expect(() => f.repo.readLocalCompanyDetail(id, at)).toThrow();
      expect(f.db.raw.inTransaction).toBe(false);
      expect(detailSqlState(f)).toEqual(before);
    } finally { f.close(); }
  });

  it.each(['claim shape', 'claim ownership', 'source hash', 'link role'] as const)('rejects explicit disposable corruption: %s', async kind => {
    const f = await createPmFixture();
    try {
      const saved = seedDetail(f, 'Selected', 1);
      const other = seedDetail(f, 'Other', 1);
      // Negative-only corruption, never a lifecycle fixture writer. Baseline is recorded AFTER setup.
      // Migration 0020 protects immutable evidence. Disable only this disposable negative fixture trigger.
      f.db.raw.exec(kind === 'source hash' ? 'DROP TRIGGER pm_account_sources_no_update'
        : kind === 'link role' ? 'DROP TRIGGER pm_account_links_no_update' : 'DROP TRIGGER pm_account_claims_no_update');
      if (kind === 'source hash') f.db.raw.prepare('UPDATE pm_account_sources SET sha256=? WHERE id=?').run('z'.repeat(64), saved.sources[0]!.id);
      else if (kind === 'link role') f.db.raw.prepare('UPDATE pm_account_links SET role=? WHERE id=?').run('', saved.link.id);
      else f.db.raw.prepare('UPDATE pm_account_claims SET claim_json=? WHERE account_id=?').run(JSON.stringify(kind === 'claim shape'
        ? { key: 'portfolio', kind: 'fact', value: { count: -1, measure: 'units', scope: 'managed' }, evidenceIds: [saved.sources[0]!.id] }
        : { key: 'technology', kind: 'fact', value: 'Corrupted cross-account reference', evidenceIds: [other.sources[0]!.id] }), saved.account.id);
      const before = detailSqlState(f);
      expect(() => f.repo.readLocalCompanyDetail(saved.account.id, PM_NOW)).toThrow();
      expect(f.db.raw.inTransaction).toBe(false);
      expect(detailSqlState(f)).toEqual(before);
    } finally { f.close(); }
  });

  it.each([false, true])('uses actual snapshot and links in one read transaction, joining outer=%s', async outer => {
    const f = await createPmFixture();
    try {
      const saved = seedDetail(f, 'Transaction', 1);
      const before = detailSqlState(f);
      const snapshot = f.repo.snapshot.bind(f.repo);
      const links = f.repo.listLinks.bind(f.repo);
      const snapshotSpy = vi.spyOn(f.repo, 'snapshot').mockImplementation((id, at) => { expect(f.db.raw.inTransaction).toBe(true); return snapshot(id, at); });
      const linksSpy = vi.spyOn(f.repo, 'listLinks').mockImplementation((id, at) => { expect(f.db.raw.inTransaction).toBe(true); return links(id, at); });
      const prepare = f.db.raw.prepare.bind(f.db.raw);
      const sourceTransactions: boolean[] = [];
      vi.spyOn(f.db.raw, 'prepare').mockImplementation(((sql: string) => {
        if (/\bpm_account_sources\b/i.test(sql)) sourceTransactions.push(f.db.raw.inTransaction);
        return prepare(sql);
      }) as typeof f.db.raw.prepare);
      if (outer) f.db.raw.exec('BEGIN');
      const detail = f.repo.readLocalCompanyDetail(saved.account.id, PM_NOW);
      expect(sourceTransactions.length).toBeGreaterThan(0);
      expect(sourceTransactions.every(Boolean)).toBe(true);
      expect(detail.snapshot.account.id).toBe(saved.account.id);
      expect(snapshotSpy).toHaveBeenCalledWith(saved.account.id, PM_NOW);
      expect(linksSpy).toHaveBeenCalledWith(saved.account.id, PM_NOW);
      expect(f.db.raw.inTransaction).toBe(outer);
      if (outer) f.db.raw.exec('ROLLBACK');
      expect(detailSqlState(f)).toEqual(before);
    } finally { vi.restoreAllMocks(); if (f.db.raw.inTransaction) f.db.raw.exec('ROLLBACK'); f.close(); }
  });

  it.each([false, true])('propagates read failure and retains only caller-owned transaction outer=%s', async outer => {
    const f = await createPmFixture();
    try {
      const saved = seedDetail(f, 'Read failure', 1);
      const before = detailSqlState(f);
      const failure = new Error('injected snapshot read failure');
      vi.spyOn(f.repo, 'snapshot').mockImplementation(() => { expect(f.db.raw.inTransaction).toBe(true); throw failure; });
      if (outer) f.db.raw.exec('BEGIN');
      expect(() => f.repo.readLocalCompanyDetail(saved.account.id, PM_NOW)).toThrow(failure);
      expect(f.db.raw.inTransaction).toBe(outer);
      expect(f.db.raw.prepare('SELECT 1 AS usable').get()).toEqual({ usable: 1 });
      if (outer) f.db.raw.exec('ROLLBACK');
      expect(detailSqlState(f)).toEqual(before);
    } finally { vi.restoreAllMocks(); if (f.db.raw.inTransaction) f.db.raw.exec('ROLLBACK'); f.close(); }
  });
});
