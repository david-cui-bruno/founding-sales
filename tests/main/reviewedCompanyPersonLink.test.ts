import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { openDatabase, closeDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { DomainRuntime } from '../../src/main/domain/domainRuntime';
import { createFounderSalesDomain } from '../../src/main/domain/founderSalesDomain';
import { AccountRepository } from '../../src/main/domain/accounts/accountRepository';
import { seedIntakePeople } from '../fixtures/domainRows';
import { createTempDatabase, createTestWorkspaceKey } from '../fixtures/tempDatabase';
import * as workspaceContract from '../../src/shared/contracts/localWorkspaceContract';
import type { LinkCompanyPersonRequest } from '../../src/shared/contracts/localWorkspaceContract';
import type { AccountSource } from '../../src/shared/contracts/accountContract';

const NOW = '2026-09-09T12:00:00.000Z';
const QUOTE = 'Nora Vale is the maintenance manager at Fictional Cedar PM.';
const EXCERPT = `${QUOTE} Marcus Reed is the leasing coordinator at Fictional Cedar PM.`;
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const clock = { now: () => NOW };

// Reads only. Complete table snapshots include aliases, consent, contact history,
// import receipts, source events, lifecycle history and pre-existing PM routes.
function storedRows(db: AppDatabase, preserveOnly = false) {
  const changedByLink = new Set(['pm_accounts', 'pm_account_commands', 'pm_account_links', 'pm_account_link_evidence']);
  const tables = db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[];
  return Object.fromEntries(tables.filter(t => !preserveOnly || !changedByLink.has(t.name)).map(({ name }) => [name,
    db.raw.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()
      .map(row => JSON.stringify(row)).sort(),
  ]));
}

async function reviewedFixture(sourceCount = 2, excerpt = EXCERPT) {
  const temp = createTempDatabase();
  const key = createTestWorkspaceKey();
  let db = (() => {
    try { return openDatabase({ path: temp.path, key }); }
    catch (error) { key.bytes.fill(0); temp.cleanup(); throw error; }
  })();
  let runtime: DomainRuntime | undefined;
  let counter = 1000;
  const ids = { next: () => uuid(++counter) };
  const attested = new Map<string, AccountSource>();
  const repository = () => new AccountRepository({ database: db, clock, ids,
    sourcePolicy: { attest: source => { const expected = attested.get(source.id); return expected !== undefined
      && source.url === expected.url && source.fetchedAt === expected.fetchedAt && source.sha256 === expected.sha256
      && source.excerpt === expected.excerpt && source.permitted === expected.permitted; } } });
  try {
    await migrateToLatest(db, { backupDirectory: `${temp.path}.backups`, workspaceKey: key });
    runtime = new DomainRuntime({ database: db, clock, ids });
    expect(runtime.initialize().status).toBe('ready');
    const domain = createFounderSalesDomain({ database: db, services: runtime.getServices(), clock, ids });
    const imported = seedIntakePeople(runtime.getServices(), { channel: 'registry', sourceName: 'fictional-reviewed-people.csv',
      observedAt: NOW, ids, rows: [
        { displayName: 'Nora Vale', email: 'nora.vale@cedar.invalid', organization: 'Fictional Cedar PM' },
        { displayName: 'Marcus Reed', email: 'marcus.reed@cedar.invalid', organization: 'Fictional Cedar PM' },
      ] });
    expect(imported).toHaveLength(2);
    expect(new Set(imported.map(person => person.personId)).size).toBe(2);
    const details = imported.map(({ personId }) => domain.getLeadDetail({ personId }));
    const nora = details.find(person => person.personName === 'Nora Vale')!;
    const marcus = details.find(person => person.personName === 'Marcus Reed')!;
    expect(nora).toBeDefined(); expect(marcus).toBeDefined();
    expect(nora.personId).not.toBe(marcus.personId);
    for (const [person, email] of [[nora, 'nora.vale@cedar.invalid'], [marcus, 'marcus.reed@cedar.invalid']] as const) {
      expect(person.organizationLabel).toBe('Fictional Cedar PM');
      expect(person.emails).toHaveLength(1);
      expect(person.emails[0]).toMatchObject({ value: email, validationState: 'valid', reachability: 'direct', ownershipState: 'unknown' });
      expect(person.phones).toEqual([]);
    }
    expect(nora.emails[0]!.id).not.toBe(marcus.emails[0]!.id);
    expect(db.raw.prepare('SELECT id FROM persons').all()).toHaveLength(2);
    expect(db.raw.prepare('SELECT id FROM organizations').all()).toHaveLength(1);
    expect(db.raw.prepare('SELECT * FROM prospect_organizations').all()).toHaveLength(2);
    expect(db.raw.prepare('SELECT id FROM source_events').all()).toHaveLength(2);
    expect(db.raw.prepare('SELECT id FROM stage_events').all().length).toBeGreaterThan(0);
    expect(db.raw.inTransaction).toBe(false); // Import finished before account admission starts.
    const repo = repository();
    const account = repo.create({ commandId: ids.next(), name: 'Fictional Cedar PM', domain: 'cedar.invalid' });
    const other = repo.create({ commandId: ids.next(), name: 'Other Fictional PM', domain: 'other.invalid' });
    const sources = Array.from({ length: sourceCount }, (_, i): AccountSource => ({ id: ids.next(),
      url: `https://example.invalid/team/${i}`, fetchedAt: NOW, excerpt: `${excerpt}${i ? ` Source ${i}.` : ''}`,
      sha256: createHash('sha256').update(`${excerpt}${i ? ` Source ${i}.` : ''}`).digest('hex'), permitted: true }));
    sources.forEach(source => attested.set(source.id, source));
    const admitted = repo.admitEvidence({ commandId: ids.next(), accountId: account.id, expectedVersion: 1,
      sources: sourceCount > 100 ? sources.slice(0, 100) : sources, claims: [], routes: [{ id: ids.next(), accountId: account.id, personId: null, channel: 'email',
        value: 'office@cedar.invalid', purpose: 'business', verification: 'published', evidenceIds: [sources[0]!.id] }] });
    expect(admitted).toEqual({ accountId: account.id, version: 2, duplicate: false });
    let expectedVersion = admitted.version;
    // Only the overflow fixture needs a second legal evidence batch. Default
    // two-source and positive 100-source fixtures still finish at version 2.
    if (sourceCount > 100) {
      expect(sourceCount).toBe(101);
      const overflow = repo.admitEvidence({ commandId: ids.next(), accountId: account.id,
        expectedVersion, sources: sources.slice(100), claims: [], routes: [] });
      expect(overflow).toEqual({ accountId: account.id, version: 3, duplicate: false });
      expectedVersion = overflow.version;
    }
    expect(repo.readLocalCompanyDetail(account.id, NOW).sources).toHaveLength(sourceCount);
    const request: LinkCompanyPersonRequest = { commandId: ids.next(), accountId: account.id, expectedVersion,
      link: { id: ids.next(), kind: 'person_role', personId: nora.personId, role: 'Maintenance manager',
        relationship: 'Reviewed source-listed role', authority: 'unconfirmed', authorityEvidenceIds: [],
        evidenceIds: [sources[0]!.id], validFrom: NOW, validTo: null },
      sourceQuotes: [{ sourceId: sources[0]!.id, quote: excerpt === EXCERPT ? QUOTE : excerpt }] };
    return { get db() { return db; }, repo, repository, domain, runtime, ids, sources, account, other, nora, marcus, request,
      preserve: () => storedRows(db, true), state: () => storedRows(db),
      reopen() { runtime!.shutdown(); closeDatabase(db); db = openDatabase({ path: temp.path, key }); return repository(); },
      close() { try { runtime!.shutdown(); if (db.raw.open) closeDatabase(db); } finally { key.bytes.fill(0); temp.cleanup(); } } };
  } catch (error) {
    try { runtime?.shutdown(); if (db.raw.open) closeDatabase(db); } finally { key.bytes.fill(0); temp.cleanup(); }
    throw error;
  }
}

type Fixture = Awaited<ReturnType<typeof reviewedFixture>>;
function rejectUnchanged(f: Fixture, request: LinkCompanyPersonRequest, message?: RegExp) {
  // Baseline failure must identify the absent production method, not pass because
  // calling undefined happens to throw. This precondition precedes every refusal.
  expect(f.repo.admitReviewedPersonLink).toBeTypeOf('function');
  const before = f.state();
  if (message) expect(() => f.repo.admitReviewedPersonLink(request)).toThrow(message);
  else expect(() => f.repo.admitReviewedPersonLink(request)).toThrow();
  expect(f.state()).toEqual(before);
  expect(f.db.raw.inTransaction).toBe(false);
}

describe('Task 5 reviewed saved-person relationship admission', () => {
  it('T5-D01 imports two distinct people and persists only the reviewed link across reopen without relabeling contacts or history', async () => {
    const f = await reviewedFixture();
    try {
      const preserved = f.preserve();
      const oldDetails = [f.nora, f.marcus];
      expect(f.repo.listLinks(f.account.id, NOW)).toEqual([]);
      expect(f.repo.admitReviewedPersonLink).toBeTypeOf('function');
      const receipt = f.repo.admitReviewedPersonLink(f.request);
      expect(receipt).toEqual({ accountId: f.account.id, version: 3, duplicate: false });
      expect(f.repo.listLinks(f.account.id, NOW)).toEqual([f.request.link]);
      expect(f.repo.listLinks(f.other.id, NOW)).toEqual([]);
      expect(f.preserve()).toEqual(preserved);
      // Public detail revision is the connection-wide change counter, not person state.
      const revision = (f.db.raw.prepare('SELECT total_changes() AS count').get() as { count: number }).count;
      expect(revision).toBeGreaterThan(oldDetails[0]!.revision);
      expect(oldDetails.map(p => f.domain.getLeadDetail({ personId: p.personId })))
        .toEqual(oldDetails.map(detail => ({ ...detail, revision })));
      expect(f.db.raw.prepare('SELECT person_id FROM pm_account_links').all()).toEqual([{ person_id: f.nora.personId }]);
      const reopened = f.reopen();
      expect(reopened.listLinks(f.account.id, NOW)).toEqual([f.request.link]);
      expect(reopened.admitReviewedPersonLink(f.request)).toEqual({ ...receipt, duplicate: true });
      expect(f.preserve()).toEqual(preserved);
      expect(f.db.raw.pragma('foreign_key_check')).toEqual([]);
    } finally { f.close(); }
  }, 15000);

  it('T5-D02 replays the original receipt after a later account version and never inserts a second link', async () => {
    const f = await reviewedFixture();
    try {
      expect(f.repo.admitReviewedPersonLink).toBeTypeOf('function');
      const receipt = f.repo.admitReviewedPersonLink(f.request);
      const changed = f.repo.admitEvidence({ commandId: f.ids.next(), accountId: f.account.id, expectedVersion: receipt.version,
        sources: [], routes: [], claims: [{ key: 'technology', kind: 'hypothesis', value: 'Later reviewed hypothesis', evidenceIds: [] }] });
      expect(changed.version).toBe(4);
      const before = f.state();
      expect(f.repo.admitReviewedPersonLink(f.request)).toEqual({ ...receipt, duplicate: true });
      expect(f.state()).toEqual(before);
      expect(f.repo.listLinks(f.account.id, NOW)).toEqual([f.request.link]);
      expect(f.db.raw.prepare('SELECT command_id FROM pm_account_commands WHERE command_id=?').all(f.request.commandId))
        .toEqual([{ command_id: f.request.commandId }]);
    } finally { f.close(); }
  }, 15000);

  it.each(['quote', 'role', 'relationship', 'personId', 'linkId', 'validFrom', 'evidence', 'accountId', 'expectedVersion'] as const)(
    'T5-D03 same UUID refuses changed immutable reviewed payload: %s', async field => {
      const f = await reviewedFixture();
      try {
        expect(f.repo.admitReviewedPersonLink).toBeTypeOf('function');
        f.repo.admitReviewedPersonLink(f.request);
        const changed = structuredClone(f.request);
        if (field === 'quote') changed.sourceQuotes[0]!.quote = 'Nora Vale'; // Still an exact valid substring.
        if (field === 'role') changed.link.role = 'Manager';
        if (field === 'relationship') changed.link.relationship = 'Reviewed employment';
        if (field === 'personId') changed.link.personId = f.marcus.personId;
        if (field === 'linkId') changed.link.id = f.ids.next();
        if (field === 'validFrom') changed.link.validFrom = '2026-09-08T12:00:00.000Z';
        if (field === 'evidence') { changed.link.evidenceIds = [f.sources[1]!.id]; changed.sourceQuotes = [{ sourceId: f.sources[1]!.id, quote: QUOTE }]; }
        if (field === 'accountId') changed.accountId = f.other.id;
        if (field === 'expectedVersion') changed.expectedVersion = 3;
        rejectUnchanged(f, changed, /fingerprint|command/i);
      } finally { f.close(); }
    }, 15000);

  it.each(['cross-account source', 'nonexact quotation', 'missing person', 'future validity', 'missing quote source', 'extra quote source', 'different quote set same size', 'stale account version'] as const)(
    'T5-D04 atomically refuses %s after observed real import and attested evidence', async reason => {
      const f = await reviewedFixture();
      try {
        const request = structuredClone(f.request);
        if (reason === 'cross-account source') { request.accountId = f.other.id; request.expectedVersion = 1; }
        if (reason === 'nonexact quotation') request.sourceQuotes[0]!.quote = QUOTE.toUpperCase();
        if (reason === 'missing person') request.link.personId = 'nonexistent-person';
        if (reason === 'future validity') request.link.validFrom = '2026-09-10T12:00:00.000Z';
        if (reason === 'missing quote source') request.link.evidenceIds.push(f.sources[1]!.id);
        if (reason === 'extra quote source') request.sourceQuotes.push({ sourceId: f.sources[1]!.id, quote: QUOTE });
        if (reason === 'different quote set same size') request.sourceQuotes[0]!.sourceId = f.sources[1]!.id;
        if (reason === 'stale account version') request.expectedVersion = 1;
        rejectUnchanged(f, request);
      } finally { f.close(); }
    }, 15000);

  it.each(['deleted person', 'opted-out projection', 'retained tombstone only', 'suppressed account'] as const)(
    'T5-D05 negative storage-only refusal: %s', async reason => {
      const f = await reviewedFixture();
      try {
        // These explicitly negative storage manipulations are NOT person admission.
        // The two positive saved identities were admitted by the real importer first.
        if (reason === 'deleted person') f.db.raw.prepare('UPDATE persons SET deleted_at=? WHERE id=?').run(NOW, f.nora.personId);
        if (reason === 'opted-out projection') {
          f.db.raw.exec('DROP TRIGGER protect_person_opt_out_reset');
          f.db.raw.prepare('UPDATE persons SET opted_out=1,opted_out_at=? WHERE id=?').run(NOW, f.nora.personId);
        }
        if (reason === 'retained tombstone only') {
          const prospect = f.db.raw.prepare('SELECT id FROM prospects WHERE person_id=?').get(f.nora.personId) as { id: string };
          f.runtime.getServices().optOut.apply({ personId: f.nora.personId, tombstoneId: f.ids.next(), requestedAt: NOW,
            policyVersion: 'founder_opt_out_v1', decision: { kind: 'founder_confirmed', channel: 'call' },
            evidence: { kind: 'append_activity', activity: { id: f.ids.next(), personId: f.nora.personId,
              prospectId: prospect.id, salesCycleId: f.nora.salesCycleId, kind: 'call', direction: 'outbound', channel: 'phone',
              occurredAt: NOW, observedOutcome: 'opted_out', metadata: { formatVersion: 1 } } }, terminalStageEventId: f.ids.next() });
          expect(f.db.raw.prepare('SELECT person_id FROM opt_out_tombstones WHERE person_id=?').get(f.nora.personId)).toEqual({ person_id: f.nora.personId });
          f.db.raw.exec('DROP TRIGGER protect_person_opt_out_reset');
          f.db.raw.prepare('UPDATE persons SET opted_out=0,opted_out_at=NULL WHERE id=?').run(f.nora.personId);
        }
        if (reason === 'suppressed account') f.db.raw.prepare(`INSERT INTO pm_account_suppression_tombstones
          (id,account_id,observed_at,source,evidence_ref,admitted_at) VALUES(?,?,?,?,?,?)`)
          .run(f.ids.next(), f.account.id, NOW, 'negative-storage-fixture', 'fictional suppression', NOW);
        rejectUnchanged(f, f.request, /unavailable|suppressed/i);
      } finally { f.close(); }
    }, 15000);

  it('T5-D06 uses one owned account transaction without invoking self-transactional admitLinks', async () => {
    const f = await reviewedFixture();
    try {
      expect(f.repo.admitReviewedPersonLink).toBeTypeOf('function');
      const oldMethod = vi.spyOn(f.repo, 'admitLinks').mockImplementation(() => { throw new Error('Nested public admitLinks must not be called'); });
      try {
        expect(f.repo.admitReviewedPersonLink(f.request)).toMatchObject({ duplicate: false, version: 3 });
        expect(oldMethod).not.toHaveBeenCalled();
        expect(f.db.raw.inTransaction).toBe(false);
      } finally { oldMethod.mockRestore(); }
      const before = f.state();
      expect(() => f.db.raw.transaction(() => f.repo.admitReviewedPersonLink({ ...f.request, commandId: f.ids.next(), expectedVersion: 3,
        link: { ...f.request.link, id: f.ids.next() } })).immediate()).toThrow(/own scoped transaction/i);
      expect(f.state()).toEqual(before);
    } finally { f.close(); }
  }, 15000);

  it('T5-D07 preserves existing nonminimal admitLinks authority evidence insertion', async () => {
    const f = await reviewedFixture();
    try {
      const legacy = { ...f.request.link, authority: 'confirmed' as const, authorityEvidenceIds: [f.sources[1]!.id] };
      expect(f.repo.admitLinks({ commandId: f.ids.next(), accountId: f.account.id, expectedVersion: 2, links: [legacy] }).version).toBe(3);
      expect(f.repo.listLinks(f.account.id, NOW)).toEqual([legacy]);
      expect(f.db.raw.prepare('SELECT source_id,purpose FROM pm_account_link_evidence WHERE link_id=? ORDER BY purpose').all(legacy.id))
        .toEqual([{ source_id: f.sources[1]!.id, purpose: 'authority' }, { source_id: f.sources[0]!.id, purpose: 'relationship' }]);
    } finally { f.close(); }
  }, 15000);

  it('T5-D08 preserves source attestation fail-closed independently of permitted flags', async () => {
    const f = await reviewedFixture();
    try {
      const before = f.state();
      const unconfigured = new AccountRepository({ database: f.db, clock, ids: f.ids });
      expect(() => unconfigured.admitEvidence({ commandId: f.ids.next(), accountId: f.account.id, expectedVersion: 2,
        sources: [{ ...f.sources[0]!, id: f.ids.next() }], claims: [], routes: [] })).toThrow(/attestation/i);
      expect(f.state()).toEqual(before);
    } finally { f.close(); }
  }, 15000);

  it('T5-D09 accepts exactly 100 quoted sources and exact 12000-character quotation at their bounds', async () => {
    const f = await reviewedFixture(100);
    try {
      expect(f.repo.admitReviewedPersonLink).toBeTypeOf('function');
      const request = { ...f.request, link: { ...f.request.link, evidenceIds: f.sources.map(s => s.id) },
        sourceQuotes: f.sources.map(s => ({ sourceId: s.id, quote: QUOTE })) };
      expect(f.repo.admitReviewedPersonLink(request)).toMatchObject({ version: 3, duplicate: false });
      expect(f.repo.listLinks(f.account.id, NOW)[0]!.evidenceIds).toHaveLength(100);
    } finally { f.close(); }
    const long = await reviewedFixture(1, 'N'.repeat(12000));
    try {
      expect(long.repo.admitReviewedPersonLink(long.request)).toMatchObject({ version: 3, duplicate: false });
      expect(long.repo.listLinks(long.account.id, NOW)).toEqual([long.request.link]);
    } finally { long.close(); }
  }, 20000);
});

// Missing export is a separately named schema-surface RED, not a collection-time
// named value import failure that masks the importer/domain assertions above.
const schemaRequest = (): LinkCompanyPersonRequest => ({ commandId: uuid(1), accountId: 'selected', expectedVersion: 2,
  link: { id: 'link', kind: 'person_role', personId: 'saved-person', role: 'Manager', relationship: 'Reviewed role',
    authority: 'unconfirmed', authorityEvidenceIds: [], evidenceIds: ['source'], validFrom: NOW, validTo: null },
  sourceQuotes: [{ sourceId: 'source', quote: QUOTE }] });
const invalidSchemaCases: [string, (input: LinkCompanyPersonRequest) => unknown][] = [
  ['extra request key', x => ({ ...x, workspaceId: 'invented' })],
  ['extra reviewed field', x => ({ ...x, link: { ...x.link, verifiedContact: true } })],
  ['extra quote key', x => ({ ...x, sourceQuotes: [{ ...x.sourceQuotes[0], url: 'https://example.invalid' }] })],
  ['duplicate quote sources', x => ({ ...x, sourceQuotes: [x.sourceQuotes[0], x.sourceQuotes[0]] })],
  ['duplicate evidence IDs', x => ({ ...x, link: { ...x.link, evidenceIds: [x.link.evidenceIds[0]!, x.link.evidenceIds[0]!] } })],
  ['empty evidence', x => ({ ...x, link: { ...x.link, evidenceIds: [] }, sourceQuotes: [] })],
  ['empty quote', x => ({ ...x, sourceQuotes: [{ sourceId: x.sourceQuotes[0]!.sourceId, quote: '' }] })],
  ['blank quote', x => ({ ...x, sourceQuotes: [{ sourceId: x.sourceQuotes[0]!.sourceId, quote: '   ' }] })],
  ['12001-character quote', x => ({ ...x, sourceQuotes: [{ sourceId: x.sourceQuotes[0]!.sourceId, quote: 'q'.repeat(12001) }] })],
  ['101 sources', x => {
    // Repository input supplies 101 actually admitted sources. Schema-only input
    // has no database and expands its own source ID for the aggregate bound check.
    const sourceQuotes = Array.from({ length: 101 }, (_, i) => x.sourceQuotes[i]
      ?? { sourceId: `${x.sourceQuotes[0]!.sourceId}-${i}`, quote: x.sourceQuotes[0]!.quote });
    return { ...x, link: { ...x.link, evidenceIds: sourceQuotes.map(item => item.sourceId) }, sourceQuotes };
  }],
  ['confirmed authority', x => ({ ...x, link: { ...x.link, authority: 'confirmed' } })],
  ['unconfirmed with authority evidence', x => ({ ...x, link: { ...x.link, authorityEvidenceIds: [x.link.evidenceIds[0]!] } })],
  ['ended validity', x => ({ ...x, link: { ...x.link, validTo: '2026-09-10T12:00:00.000Z' } })],
  ['invalid timestamp', x => ({ ...x, link: { ...x.link, validFrom: 'yesterday' } })],
  ['organization kind', x => ({ ...x, link: { ...x.link, kind: 'organization' } })],
  ['empty source ID', x => ({ ...x, sourceQuotes: [{ sourceId: '', quote: QUOTE }] })],
  ['overlong source ID', x => ({ ...x, sourceQuotes: [{ sourceId: 's'.repeat(201), quote: QUOTE }] })],
  ['empty saved person ID', x => ({ ...x, link: { ...x.link, personId: '' } })],
  ['overlong account ID', x => ({ ...x, accountId: 'a'.repeat(201) })],
  ['blank role', x => ({ ...x, link: { ...x.link, role: '   ' } })],
  ['overlong relationship', x => ({ ...x, link: { ...x.link, relationship: 'r'.repeat(201) } })],
  ['invalid UUID', x => ({ ...x, commandId: 'not-a-uuid' })],
  ['zero version', x => ({ ...x, expectedVersion: 0 })],
  ['unsafe version', x => ({ ...x, expectedVersion: Number.MAX_SAFE_INTEGER + 1 })],
];
describe('Task 5 strict shared reviewed relationship schema', () => {
  it('T5-S01 exports the exact request schema and retains reviewed quotation bytes', () => {
    expect(workspaceContract.linkCompanyPersonRequestSchema).toBeDefined();
    const request = schemaRequest(); request.sourceQuotes[0]!.quote = ' Nora Vale ';
    expect(workspaceContract.linkCompanyPersonRequestSchema.parse(request)).toEqual(request);
  });
  it.each(invalidSchemaCases)('T5-S02 rejects %s', (label, change) => {
    expect(workspaceContract.linkCompanyPersonRequestSchema).toBeDefined();
    expect(workspaceContract.linkCompanyPersonRequestSchema.safeParse(change(schemaRequest())).success).toBe(false);
    if (label === '101 sources') {
      // Independent quotes-only overflow: evidenceIds remains bounded, so its
      // existing max(100) cannot explain this refusal. Exact-set validation may
      // also reject it, so this is an overlapping strict-boundary guarantee,
      // not proof that a particular sourceQuotes max validator fired.
      const quotesOnly = { ...schemaRequest(), sourceQuotes: Array.from({ length: 101 }, (_, i) => ({
        sourceId: i === 0 ? 'source' : `schema-source-${i}`, quote: QUOTE,
      })) };
      expect(quotesOnly.link.evidenceIds).toEqual(['source']);
      expect(quotesOnly.sourceQuotes).toHaveLength(101);
      expect(new Set(quotesOnly.sourceQuotes.map(item => item.sourceId)).size).toBe(101);
      expect(workspaceContract.linkCompanyPersonRequestSchema.safeParse(quotesOnly).success).toBe(false);
    }
  });
});

// Exercise schema refusals at the actual repository boundary too. A standalone
// schema assertion does not prove that a mutation uses that schema.
describe('Task 5 strict mutation admission retains existing originals', () => {
  it.each(invalidSchemaCases)('T5-D10 repository refuses %s without changing imported originals or receipts', async (label, change) => {
    const f = await reviewedFixture(label === '101 sources' ? 101 : 2,
      label === 'blank quote' ? `${EXCERPT}   ` : EXCERPT);
    try {
      const input = label === '101 sources' ? { ...f.request,
        link: { ...f.request.link, evidenceIds: f.sources.map(source => source.id) },
        sourceQuotes: f.sources.map(source => ({ sourceId: source.id, quote: QUOTE })) } : f.request;
      if (label === '101 sources') {
        expect(f.sources).toHaveLength(101);
        expect(input.expectedVersion).toBe(3);
      }
      if (label === 'blank quote') expect(f.sources[0]!.excerpt).toContain('   ');
      // A 12001-character quote cannot be a substring of any legally admitted
      // excerpt (schema AND SQL cap excerpts at 12000). This is combined
      // schema/substring refusal, not isolated repository schema proof.
      // Invalid/overlong source, person or account IDs likewise cannot be
      // admitted as valid identities: these are combined schema/reference
      // refusals. S02 and B02 independently exercise strict public validation.
      rejectUnchanged(f, change(input) as LinkCompanyPersonRequest);
    } finally { f.close(); }
  }, 15000);
});

describe('Task 5 negative storage rollback', () => {
  it('T5-D11 rolls back link insertion, evidence, version and receipt if an evidence write fails', async () => {
    const f = await reviewedFixture();
    try {
      expect(f.repo.admitReviewedPersonLink).toBeTypeOf('function');
      // Negative-only storage fault injection after successful real admission setup.
      f.db.raw.exec(`CREATE TEMP TRIGGER task5_fail_link_evidence BEFORE INSERT ON pm_account_link_evidence
        BEGIN SELECT RAISE(ABORT, 'fictional link evidence failure'); END`);
      rejectUnchanged(f, f.request, /fictional link evidence failure/);
      expect(f.repo.listLinks(f.account.id, NOW)).toEqual([]);
    } finally { f.close(); }
  }, 15000);
});
