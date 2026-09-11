import { randomUUID } from 'node:crypto';
import { AccountRepository } from '../../src/main/domain/accounts/accountRepository';
import { closeDatabase, openDatabase } from '../../src/main/db/database';
import { createTestWorkspaceKey } from '../fixtures/tempDatabase';
import { describe, expect, it } from 'vitest';
import { createPmFixture, PM_NOW } from '../fixtures/pmAccounts';
import { projectAccountEvidence } from '../../src/main/domain/accounts/accountEvidence';
import type { AccountEvidenceBatch, AccountClaim } from '../../src/shared/contracts/accountContract';

export function evidence(accountId: string, expectedVersion = 1): AccountEvidenceBatch {
  const id = randomUUID();
  return { commandId: randomUUID(), accountId, expectedVersion,
    sources: [{ id, url: 'https://example.invalid/team', fetchedAt: PM_NOW, sha256: 'a'.repeat(64), excerpt: 'We manage 100 units.', permitted: true }],
    claims: [{ kind: 'fact', key: 'portfolio', value: { count: 100, measure: 'units', scope: 'managed' }, evidenceIds: [id] }],
    routes: [{ id: randomUUID(), accountId, personId: null, channel: 'phone', value: '+12025550123', purpose: 'business', evidenceIds: [id], verification: 'published' }] };
}
describe('PM evidence admission', () => {
  it('atomically admits structured claims, preserves contradictions and enforces replay/CAS', async () => {
    const f = await createPmFixture();
    try {
      const a = f.repo.create({ commandId: randomUUID(), name: 'Example PM', domain: null });
      const batch = evidence(a.id);
      expect(f.repo.admitEvidence(batch)).toEqual({ accountId: a.id, version: 2, duplicate: false });
      expect(f.repo.admitEvidence(batch)).toEqual({ accountId: a.id, version: 2, duplicate: true });
      expect(() => f.repo.admitEvidence({ ...batch, claims: [] })).toThrow(/command/i);
      expect(() => f.repo.admitEvidence({ ...batch, commandId: randomUUID() })).toThrow(/version/i);
      const conflict = evidence(a.id, 2);
      conflict.sources[0].sha256 = 'b'.repeat(64);
      conflict.claims[0] = { kind: 'fact', key: 'portfolio', value: { count: 200, measure: 'units', scope: 'managed' }, evidenceIds: [conflict.sources[0].id] };
      conflict.routes[0].purpose = 'tenant_emergency';
      f.repo.admitEvidence(conflict);
      const snapshot = f.repo.snapshot(a.id, PM_NOW);
      expect(snapshot.portfolio.map(p => p.count)).toEqual([100, 200]);
      expect(snapshot.conflicts).toContain('portfolio:managed:units');
      expect(snapshot.routes.map(r => r.purpose).sort()).toEqual(['business', 'tenant_emergency']);
      expect(snapshot.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(f.repo.snapshot(a.id, PM_NOW)).toEqual(snapshot);
    } finally { f.close(); }
  });
  it('rejects unsupported shapes, cross-account evidence and unattested sources with rollback', async () => {
    const f = await createPmFixture();
    try {
      const a = f.repo.create({ commandId: randomUUID(), name: 'Example PM', domain: null });
      const b = f.repo.create({ commandId: randomUUID(), name: 'Other PM', domain: null });
      const batch = evidence(a.id);
      f.repo.admitEvidence(batch);
      const foreign = evidence(b.id);
      foreign.sources = []; foreign.claims[0].evidenceIds = [batch.sources[0].id]; foreign.routes = [];
      expect(() => f.repo.admitEvidence(foreign)).toThrow(/evidence/i);
      const bad = evidence(b.id); bad.sources[0].url = 'https://untrusted.invalid/';
      expect(() => f.repo.admitEvidence(bad)).toThrow(/policy/i);
      expect(() => f.repo.admitEvidence({ ...evidence(b.id), claims: [{ kind: 'fact', key: 'portfolio', value: { count: 10 }, evidenceIds: [] }] } as never)).toThrow();
      expect(f.repo.snapshot(b.id, PM_NOW).account.version).toBe(1);
      expect(f.db.raw.prepare('SELECT * FROM pm_account_sources WHERE account_id=?').all(b.id)).toEqual([]);
    } finally { f.close(); }
  });
});

describe('strict PM evidence boundaries', () => {
  it('keeps explicit dated organization/person-role/property links and never infers authority from title', async () => {
    const f = await createPmFixture();
    try {
      const a = f.repo.create({ commandId: randomUUID(), name: 'Example PM', domain: null });
      const batch = evidence(a.id); f.repo.admitEvidence(batch);
      f.db.raw.prepare(`INSERT INTO properties(id,address_line_1,locality,region,country_code,created_at,updated_at)
        VALUES('fictional-property','1 Fictional St','Example','RI','US',?,?)`).run(PM_NOW, PM_NOW);
      const base = { id: randomUUID(), evidenceIds: [batch.sources[0].id], relationship: 'operates', validFrom: PM_NOW, validTo: null as string | null };
      const command = { commandId: randomUUID(), accountId: a.id, expectedVersion: 2, links: [
        { ...base, kind: 'person_role' as const, personId: 'historical-person', role: 'CEO', authority: 'unconfirmed' as const, authorityEvidenceIds: [] as string[] },
        { ...base, id: randomUUID(), kind: 'organization' as const, organizationId: 'historical-org' },
        { ...base, id: randomUUID(), kind: 'property' as const, propertyId: 'fictional-property' },
      ] };
      expect(f.repo.admitLinks(command).version).toBe(3);
      expect(f.repo.admitLinks(command).duplicate).toBe(true);
      expect(f.repo.listLinks(a.id, PM_NOW)).toHaveLength(3);
      expect(f.repo.listLinks(a.id, PM_NOW).find(l => l.kind === 'person_role')).toMatchObject({ authority: 'unconfirmed', role: 'CEO' });
      expect(() => f.repo.admitLinks({ ...command, commandId: randomUUID(), expectedVersion: 3,
        links: [{ ...base, kind: 'person_role', personId: 'historical-person', role: 'CEO', authority: 'confirmed', authorityEvidenceIds: [] }] })).toThrow(/authority/i);
      expect(f.repo.listLinks(a.id, '2026-09-07T00:00:00.000Z')).toEqual([]);
      expect(() => f.repo.admitLinks({ ...command, commandId: randomUUID() })).toThrow(/version/i);
    } finally { f.close(); }
  });
  it('rolls back newly inserted sources/claims after a bad route and does not accept permitted:true without policy', async () => {
    const f = await createPmFixture();
    try {
      const a = f.repo.create({ commandId: randomUUID(), name: 'Example PM', domain: null });
      const unconfigured = new AccountRepository({ database: f.db, clock: { now: () => PM_NOW }, ids: { next: randomUUID } });
      expect(() => unconfigured.admitEvidence(evidence(a.id))).toThrow(/policy/i);
      const batch = evidence(a.id); batch.routes[0].personId = 'absent-person';
      expect(() => f.repo.admitEvidence(batch)).toThrow();
      expect(f.db.raw.prepare('SELECT * FROM pm_account_sources').all()).toEqual([]);
      expect(f.db.raw.prepare('SELECT * FROM pm_account_claims').all()).toEqual([]);
      expect(f.repo.snapshot(a.id, PM_NOW).account.version).toBe(1);
    } finally { f.close(); }
  });
  it('rejects count/shape/length ambiguity and preserves hypotheses as unknown rather than supported portfolio', async () => {
    const f = await createPmFixture();
    try {
      const a = f.repo.create({ commandId: randomUUID(), name: 'Example PM', domain: null });
      for (const value of [{ count: -1, measure: 'units', scope: 'managed' }, { count: 1.5, measure: 'units', scope: 'managed' },
        { count: 1, measure: 'units' }, { count: 1, measure: 'units', scope: 'managed', extra: true }]) {
        const batch = evidence(a.id); (batch.claims[0] as { value: unknown }).value = value;
        expect(() => f.repo.admitEvidence(batch)).toThrow();
      }
      const tooLong = evidence(a.id); tooLong.sources[0].excerpt = 'x'.repeat(12001);
      expect(() => f.repo.admitEvidence(tooLong)).toThrow();
      const batch = evidence(a.id); batch.claims[0].kind = 'hypothesis'; f.repo.admitEvidence(batch);
      expect(f.repo.snapshot(a.id, PM_NOW).portfolio).toEqual([]);
      expect(f.repo.snapshot(a.id, PM_NOW).unknowns).toContain('portfolio');
    } finally { f.close(); }
  });
});


describe('durable evidence and exact outbound targets', () => {
  it('reopens an encrypted database and replays a committed command without another admission', async () => {
    const f = await createPmFixture();
    try {
      const a = f.repo.create({ commandId: randomUUID(), name: 'Example PM', domain: null });
      const batch = evidence(a.id); f.repo.admitEvidence(batch);
      const before = f.repo.snapshot(a.id, PM_NOW);
      closeDatabase(f.db);
      const key = createTestWorkspaceKey();
      const reopened = openDatabase({ path: f.db.path, key });
      try {
        const repo = new AccountRepository({ database: reopened, clock: { now: () => PM_NOW }, ids: { next: randomUUID } });
        expect(repo.admitEvidence(batch)).toEqual({ accountId: a.id, version: 2, duplicate: true });
        expect(repo.snapshot(a.id, PM_NOW)).toEqual(before);
      } finally { closeDatabase(reopened); key.bytes.fill(0); }
    } finally { f.close(); }
  });
  it('freezes exact route/attempt targets and keeps unknown dispatch separate from manually reported outcomes', async () => {
    const f = await createPmFixture();
    try {
      const a = f.repo.create({ commandId: randomUUID(), name: 'Example PM', domain: null });
      const b = f.repo.create({ commandId: randomUUID(), name: 'Other PM', domain: null });
      const batch = evidence(a.id); f.repo.admitEvidence(batch);
      const snapshot = f.repo.snapshot(a.id, PM_NOW);
      const route = snapshot.routes[0];
      const commandId = randomUUID(); const attemptId = randomUUID();
      const reserve = (accountId: string, routeVersion: number) => f.db.raw.prepare(`INSERT INTO pm_account_outbound_intents
        (command_id,account_id,route_id,route_version,account_version,evidence_fingerprint,command_fingerprint,attempt_id,channel,canonical_target,context_revision,created_at)
        VALUES(?,?,?,?,?,?,?,?,'call',?,'fixture-context',?)`).run(commandId, accountId, route.id, routeVersion, 2, snapshot.fingerprint, 'a'.repeat(64), attemptId, route.value, PM_NOW);
      expect(() => reserve(b.id, 1)).toThrow();
      expect(() => reserve(a.id, 2)).toThrow();
      reserve(a.id, 1);
      const append = (attempt: string, kind: string, outcome: string) => f.db.raw.prepare(`INSERT INTO pm_account_outbound_results
        (id,command_id,attempt_id,account_id,kind,outcome,result_json,created_at) VALUES(?,?,?,?,?,?,?,?)`)
        .run(randomUUID(), commandId, attempt, a.id, kind, outcome, JSON.stringify({ outcome }), PM_NOW);
      expect(() => append(randomUUID(), 'dispatch', 'unknown')).toThrow();
      append(attemptId, 'dispatch', 'unknown');
      append(attemptId, 'call_outcome', 'no_answer');
      expect(() => f.db.raw.prepare("UPDATE pm_account_outbound_results SET outcome='accepted'").run()).toThrow(/immutable/i);
      expect(() => f.db.raw.prepare('DELETE FROM pm_account_outbound_intents').run()).toThrow(/immutable/i);
      const changed: AccountEvidenceBatch = { ...batch, commandId: randomUUID(), expectedVersion: 2, sources: [], claims: [],
        routes: [{ ...batch.routes[0], value: '+12025550124' }] };
      f.repo.admitEvidence(changed);
      expect(f.repo.snapshot(a.id, PM_NOW).routes[0]).toMatchObject({ version: 2, value: '+12025550124' });
      expect(f.db.raw.prepare('SELECT route_version,canonical_target FROM pm_account_outbound_intents').get()).toEqual({ route_version: 1, canonical_target: route.value });
      expect(f.db.raw.prepare('SELECT outcome FROM pm_account_outbound_results ORDER BY rowid').all()).toEqual([{ outcome: 'unknown' }, { outcome: 'no_answer' }]);
      expect(f.db.raw.prepare('SELECT * FROM activities').all()).toEqual([]);
      expect(f.db.raw.prepare('SELECT * FROM persons ORDER BY id').all()).toEqual(f.historicalPersons);
    } finally { f.close(); }
  });
});


it('reads a snapshot inside a consumer transaction without permitting nested account commands', async () => {
  const f = await createPmFixture();
  try {
    const a = f.repo.create({ commandId: randomUUID(), name: 'Example PM', domain: null });
    f.db.raw.transaction(() => {
      expect(f.repo.snapshot(a.id, PM_NOW).account).toEqual(a);
      expect(() => f.repo.create({ commandId: randomUUID(), name: 'Nested', domain: null })).toThrow();
    }).immediate();
  } finally { f.close(); }
});


it('keeps portfolio unknown for prospect-stated counts without promoting their provenance', () => {
  const account = { id: 'fictional-account', name: 'Example PM', domain: null as string | null, version: 1 };
  const stated: AccountClaim = { kind: 'prospect_stated_problem', key: 'portfolio',
    value: { count: 100, measure: 'units', scope: 'managed' }, evidenceIds: ['fictional-source'] };
  const snapshot = projectAccountEvidence(account, [stated], []);
  expect(snapshot.portfolio).toEqual([]);
  expect(snapshot.unknowns).toContain('portfolio');
  expect(snapshot.claims).toEqual([stated]);
  expect(stated.kind).toBe('prospect_stated_problem');
  const supported = projectAccountEvidence(account, [stated, { ...stated, kind: 'fact' }], []);
  expect(supported.portfolio).toEqual([{ ...stated.value, evidenceIds: ['fictional-source'] }]);
  expect(supported.unknowns).not.toContain('portfolio');
  expect(supported.claims[0].kind).toBe('prospect_stated_problem');
});
