import { createHash, randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { openDatabase, closeDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { AccountRepository } from '../../src/main/domain/accounts/accountRepository';
import { LocalCompanyDraftRepository } from '../../src/main/domain/accounts/localCompanyDraftRepository';
import { DomainRuntime } from '../../src/main/domain/domainRuntime';
import { companyDraftAdmissionReply, companyDraftGetReply, companyDraftOpenReply, companyDraftSaveReply, admitCompanyDraftEmailSchema, getCompanyDraftSchema, openCompanyDraftSchema, saveCompanyDraftSchema } from '../../src/shared/contracts/localCompanyDraftContract';
import { createTempDatabase, createTestWorkspaceKey } from '../fixtures/tempDatabase';
import { insertPerson } from '../fixtures/domainRows';
const NOW = '2026-09-15T18:00:00.000Z', EMAIL = 'info@company.example', QUOTE = `Business email: ${EMAIL}`;
const ids = { next: randomUUID };
function allRows(db: AppDatabase, exclude: string[] = []) {
  const tables = db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
  return tables.filter(row => !exclude.includes(row.name)).map(row => [row.name, db.raw.prepare(`SELECT * FROM "${row.name}"`).all()]);
}
async function fixture(excerpt = QUOTE) {
  const temp = createTempDatabase(), key = createTestWorkspaceKey(); let db = openDatabase({ path: temp.path, key }); let now = NOW;
  const clock = { now: () => now }, options = { workspaceKey: key, backupDirectory: `${temp.path}.backups` };
  await migrateToLatest(db, options);
  const repo = () => new AccountRepository({ database: db, clock, ids, sourcePolicy: { attest: source => source.sha256 === createHash('sha256').update(source.excerpt).digest('hex') } });
  const drafts = () => new LocalCompanyDraftRepository({ database: db, clock, ids });
  const account = repo().create({ commandId: randomUUID(), name: 'Company PM', domain: 'company.example' });
  function source(text: string, accountId = account.id) {
    const id = randomUUID(); const version = (db.raw.prepare('SELECT version FROM pm_accounts WHERE id=?').get(accountId) as { version: number }).version;
    repo().admitEvidence({ commandId: randomUUID(), accountId, expectedVersion: version, sources: [{ id, url: 'https://company.example/about', fetchedAt: now,
      excerpt: text, permitted: true, sha256: createHash('sha256').update(text).digest('hex') }], claims: [], routes: [] }); return id;
  }
  const sourceId = source(excerpt);
  const request = { commandId: randomUUID(), accountId: account.id, expectedAccountVersion: 2, email: EMAIL, sourceId, quote: QUOTE, selection: 'published_company_business_inbox' as const };
  const admit = () => repo().admitReviewedBusinessEmail(request);
  function open() { const receipt = admit(); return drafts().open({ commandId: randomUUID(), accountId: account.id, routeId: receipt.recipientBinding.routeId,
    expectedRouteVersion: receipt.recipientBinding.routeVersion, expectedAccountVersion: receipt.accountVersion }); }
  return { get db() { return db; }, repo, drafts, account, sourceId, source, request, admit, open, clock, setTime: (value: string) => { now = value; },
    async reopen() { closeDatabase(db); db = openDatabase({ path: temp.path, key }); await migrateToLatest(db, options); },
    close() { closeDatabase(db); key.bytes.fill(0); temp.cleanup(); } };
}
it('P2 exact receipts survive reopen, convergent opens, CAS winners and old replay retain current text', async () => {
  const f = await fixture();
  try {
    const untouched = allRows(f.db, ['pm_accounts','pm_account_commands','pm_account_routes','pm_account_route_evidence','local_company_email_drafts','local_company_draft_commands']);
    const admission = f.admit(); expect(f.admit()).toEqual(admission);
    expect(() => f.repo().admitReviewedBusinessEmail({ ...f.request, quote: EMAIL })).toThrow();
    const open = { commandId: randomUUID(), accountId: f.account.id, routeId: admission.recipientBinding.routeId, expectedRouteVersion: 1, expectedAccountVersion: 3 };
    const first = f.drafts().open(open);
    expect(f.drafts().open({ ...open, commandId: randomUUID() }).current.draft.id).toBe(first.current.draft.id);
    const save = { commandId: randomUUID(), accountId: f.account.id, draftId: first.current.draft.id, expectedRevision: 1, subject: 'First', body: 'Exact café\n  ' };
    const saved = f.drafts().save(save); expect(saved.receipt.appliedRevision).toBe(2);
    expect(f.drafts().save(save)).toEqual(saved);
    const competing = { ...save, commandId: randomUUID(), subject: 'Loser' };
    const before = allRows(f.db); expect(() => f.drafts().save(competing)).toThrow(); expect(allRows(f.db)).toEqual(before);
    const later = f.drafts().save({ ...save, commandId: randomUUID(), expectedRevision: 2, subject: 'Latest', body: 'Latest exact\n' });
    await f.reopen(); expect(f.admit()).toEqual(admission);
    expect(f.drafts().open(open)).toEqual({ receipt: first.receipt, current: later.current });
    expect(f.drafts().save(save)).toEqual({ receipt: saved.receipt, current: later.current });
    expect(() => f.drafts().save({ ...save, body: 'changed fingerprint' })).toThrow();
    expect(allRows(f.db, ['pm_accounts','pm_account_commands','pm_account_routes','pm_account_route_evidence','local_company_email_drafts','local_company_draft_commands'])).toEqual(untouched);
  } finally { f.close(); }
});
it.each([
  ['clipped local prefix', `Business email: prefix${EMAIL}`, EMAIL], ['clipped domain suffix', `${QUOTE}.evil`, EMAIL],
  ['plus tag', `Business email: info+tag@company.example`, EMAIL], ['unicode prefix', `Business email: é${EMAIL}`, EMAIL],
  ['domain underscore', `${QUOTE}_other`, EMAIL], ['unrelated quote', QUOTE, 'Business email:'],
  ['tenant only', `Tenant emergency only: ${EMAIL}`, EMAIL], ['markup attribute', `<a href="mailto:${EMAIL}">${EMAIL}</a>`, EMAIL],
])('P3 rejects %s without any partial writes', async (_name, excerpt, quote) => {
  const f = await fixture(excerpt);
  try { const before = allRows(f.db); expect(() => f.repo().admitReviewedBusinessEmail({ ...f.request, quote })).toThrow(); expect(allRows(f.db)).toEqual(before); }
  finally { f.close(); }
});
it.each([`After-hours tenant emergencies only: ${EMAIL}`, `Emergencies only: ${EMAIL}.`, `Emergency email:\n\n${EMAIL}`])('P3 same-target negative evidence %s blocks admission and existing route open, unlike unrelated emergency context', async negative => {
  const f = await fixture(`${QUOTE}\nWe offer 24/7 emergency maintenance.\nTenant email: tenants@company.example`);
  try {
    const admitted = f.admit(); const beforeVersion = admitted.accountVersion;
    f.source(negative);
    const before = allRows(f.db);
    expect(() => f.repo().admitReviewedBusinessEmail({ ...f.request, commandId: randomUUID(), expectedAccountVersion: beforeVersion + 1 })).toThrow();
    expect(() => f.drafts().open({ commandId: randomUUID(), accountId: f.account.id, routeId: admitted.recipientBinding.routeId, expectedRouteVersion: 1, expectedAccountVersion: beforeVersion + 1 })).toThrow();
    expect(allRows(f.db)).toEqual(before);
  } finally { f.close(); }
});
it('P3 current source bounds, future evidence, missing and cross-account source/route/draft are held', async () => {
  const f = await fixture();
  try {
    const opened = f.open(); const other = f.repo().create({ commandId: randomUUID(), name: 'Other', domain: null });
    expect(f.drafts().get({ accountId: other.id, draftId: opened.current.draft.id })).toBeNull();
    const sourceId = f.source(QUOTE, other.id); const before = allRows(f.db);
    expect(() => f.repo().admitReviewedBusinessEmail({ ...f.request, commandId: randomUUID(), sourceId, expectedAccountVersion: 3 })).toThrow();
    expect(() => f.drafts().open({ commandId: randomUUID(), accountId: other.id, routeId: opened.current.draft.recipientBinding.routeId, expectedRouteVersion: 1, expectedAccountVersion: 2 })).toThrow();
    expect(() => f.repo().admitReviewedBusinessEmail({ ...f.request, accountId: 'missing', commandId: randomUUID() })).toThrow();
    expect(allRows(f.db)).toEqual(before);
    f.setTime('2026-09-16T18:00:00.000Z'); f.source('Saved later'); f.setTime(NOW);
    expect(f.drafts().get({ accountId: f.account.id, draftId: opened.current.draft.id })).toMatchObject({ stale: true, editable: true, reason: 'evidence_unavailable' });
    expect(() => f.repo().admitReviewedBusinessEmail({ ...f.request, commandId: randomUUID(), expectedAccountVersion: 4 })).toThrow();
  } finally { f.close(); }
});
it('P3 exact-source proof opens existing route, personal/unverified routes cannot be relabeled', async () => {
  const f = await fixture();
  try {
    const routeId = randomUUID();
    f.repo().admitEvidence({ commandId: randomUUID(), accountId: f.account.id, expectedVersion: 2, sources: [], claims: [], routes: [{ id: routeId,
      accountId: f.account.id, personId: null, channel: 'email', value: EMAIL, purpose: 'business', verification: 'published', evidenceIds: [f.sourceId] }] });
    const open = f.drafts().open({ commandId: randomUUID(), accountId: f.account.id, routeId, expectedRouteVersion: 1, expectedAccountVersion: 3 });
    expect(open.current).toMatchObject({ stale: false, editable: true });
    expect(f.repo().admitReviewedBusinessEmail({ ...f.request, expectedAccountVersion: 3 }).recipientBinding.routeId).toBe(routeId);
    insertPerson(f.db.raw, 'personal');
    f.repo().admitEvidence({ commandId: randomUUID(), accountId: f.account.id, expectedVersion: 4, sources: [], claims: [], routes: [{ id: routeId,
      accountId: f.account.id, personId: 'personal', channel: 'email', value: EMAIL, purpose: 'business', verification: 'unverified', evidenceIds: [f.sourceId] }] });
    const before = allRows(f.db);
    expect(() => f.repo().admitReviewedBusinessEmail({ ...f.request, commandId: randomUUID(), expectedAccountVersion: 5 })).toThrow(); expect(allRows(f.db)).toEqual(before);
  } finally { f.close(); }
});
it('P4 frozen stale recipient remains text-editable, suppression is readable but blocks new mutations and allows exact replay', async () => {
  const f = await fixture();
  try {
    const opened = f.open(), draft = opened.current.draft, routeId = draft.recipientBinding.routeId;
    f.repo().admitEvidence({ commandId: randomUUID(), accountId: f.account.id, expectedVersion: 3, sources: [], claims: [], routes: [{ id: routeId,
      accountId: f.account.id, personId: null, channel: 'email', value: 'new@company.example', purpose: 'business', verification: 'published', evidenceIds: [f.sourceId] }] });
    const stale = f.drafts().get({ accountId: f.account.id, routeId }); expect(stale).toMatchObject({ stale: true, reason: 'route_changed', editable: true, draft });
    const save = { commandId: randomUUID(), accountId: f.account.id, draftId: draft.id, expectedRevision: 1, subject: 'Recover', body: 'Old target text' };
    const saved = f.drafts().save(save); expect(saved.current.draft.recipientBinding).toEqual(draft.recipientBinding);
    f.db.raw.prepare(`INSERT INTO pm_handle_suppression_tombstones(id,kind,normalized_value,observed_at,source,evidence_ref,admitted_at) VALUES(?,'email',?,?,?, ?,?)`)
      .run(randomUUID(), EMAIL, NOW, 'fixture', 'target suppression', NOW);
    const before = allRows(f.db);
    expect(f.drafts().get({ accountId: f.account.id, routeId })).toMatchObject({ reason: 'suppressed', editable: false, draft: saved.current.draft });
    expect(() => f.drafts().save({ ...save, commandId: randomUUID(), expectedRevision: 2 })).toThrow();
    expect(f.drafts().save(save)).toMatchObject({ receipt: saved.receipt, current: { editable: false } });
    expect(allRows(f.db)).toEqual(before);
    const prepare = vi.spyOn(f.db.raw, 'prepare'); f.drafts().get({ accountId: f.account.id, routeId });
    expect(prepare.mock.calls.every(call => /^SELECT\b/i.test(call[0].trim()))).toBe(true); prepare.mockRestore();
  } finally { f.close(); }
});
it('review correction: unrelated genuinely opted-out linked person does not suppress company inbox, matching handle does', async () => {
  const f = await fixture(); const runtime = new DomainRuntime({ database: f.db, clock: f.clock, ids });
  try {
    expect(runtime.initialize().status).toBe('ready'); insertPerson(f.db.raw, 'unrelated');
    f.db.raw.prepare(`INSERT INTO person_contact_methods(id,person_id,kind,normalized_value,validation_state,reachability,created_at,updated_at)
      VALUES('contact','unrelated','email','other@company.example','valid','direct',?,?)`).run(NOW,NOW);
    f.repo().admitLinks({ commandId: randomUUID(), accountId: f.account.id, expectedVersion: 2, links: [{ id: randomUUID(),
      kind: 'person_role', personId: 'unrelated', relationship: 'employee', role: 'Manager', authority: 'unconfirmed',
      validFrom: NOW, validTo: null, evidenceIds: [f.sourceId], authorityEvidenceIds: [] }] });
    runtime.getServices().optOut.apply({ personId: 'unrelated', tombstoneId: randomUUID(), requestedAt: NOW, policyVersion: 'founder_opt_out_v1',
      decision: { kind: 'founder_confirmed', channel: 'call' }, evidence: { kind: 'append_activity', activity: { id: randomUUID(), personId: 'unrelated',
        prospectId: null, salesCycleId: null, kind: 'call', direction: 'outbound', channel: 'phone', occurredAt: NOW, observedOutcome: 'opted_out', metadata: { formatVersion: 1 } } }, terminalStageEventId: null });
    expect(f.db.raw.prepare("SELECT opted_out FROM persons WHERE id='unrelated'").get()).toEqual({ opted_out: 1 });
    const admission = f.repo().admitReviewedBusinessEmail({ ...f.request, expectedAccountVersion: 3 });
    const opened = f.drafts().open({ commandId: randomUUID(), accountId: f.account.id, routeId: admission.recipientBinding.routeId, expectedRouteVersion: 1, expectedAccountVersion: 4 });
    expect(opened.current.editable).toBe(true);
    insertPerson(f.db.raw, 'matching');
    f.db.raw.prepare(`INSERT INTO person_contact_methods(id,person_id,kind,normalized_value,validation_state,reachability,created_at,updated_at)
      VALUES('matching-contact','matching','email',?,'valid','direct',?,?)`).run(EMAIL,NOW,NOW);
    f.db.raw.prepare("UPDATE persons SET deleted_at=? WHERE id='matching'").run(NOW);
    expect(f.drafts().get({ accountId: f.account.id, draftId: opened.current.draft.id })).toMatchObject({ reason: 'suppressed', editable: false });
  } finally { runtime.shutdown(); f.close(); }
});
it('strict scalar requests reject scope/send/person extras, mixed selectors and header controls', () => {
  const command = { commandId: randomUUID(), accountId: 'a', expectedAccountVersion: 1, email: EMAIL, sourceId: 's', quote: QUOTE, selection: 'published_company_business_inbox' };
  for (const extra of [{ workspaceId: 'w' }, { sender: EMAIL }, { personId: 'p' }, { send: true }]) expect(admitCompanyDraftEmailSchema.safeParse({ ...command, ...extra }).success).toBe(false);
  expect(getCompanyDraftSchema.safeParse({ accountId: 'a', draftId: 'd', routeId: 'r' }).success).toBe(false);
  expect(openCompanyDraftSchema.safeParse({ commandId: randomUUID(), accountId: 'a', routeId: 'r', expectedRouteVersion: 1, expectedAccountVersion: 1, email: EMAIL }).success).toBe(false);
  for (const subject of ['a\r\nBcc: bad', '\0', '\t']) expect(saveCompanyDraftSchema.safeParse({ commandId: randomUUID(), accountId: 'a', draftId: 'd', expectedRevision: 1, subject, body: '' }).success).toBe(false);
});
it.each(['count', 'bytes'] as const)('P3 complete evidence %s budget holds without truncating or writing', async bound => {
  const f = await fixture();
  try {
    for (let index = 0; index < (bound === 'count' ? 100 : 22); index++) f.source(`Saved source ${index}: ${bound === 'bytes' ? 'x'.repeat(11900) : 'plain context'}`);
    const version = (f.db.raw.prepare('SELECT version FROM pm_accounts WHERE id=?').get(f.account.id) as { version: number }).version;
    const before = allRows(f.db);
    expect(() => f.repo().admitReviewedBusinessEmail({ ...f.request, expectedAccountVersion: version })).toThrow('publication unavailable');
    expect(allRows(f.db)).toEqual(before);
  } finally { f.close(); }
});
it.each(['account', 'handle'] as const)('P3 %s suppression blocks admission/open/save without erasing persisted recovery', async kind => {
  const f = await fixture();
  try {
    const opened = f.open(), draft = opened.current.draft;
    if (kind === 'account') f.db.raw.prepare(`INSERT INTO pm_account_suppression_tombstones(id,account_id,observed_at,source,evidence_ref,admitted_at) VALUES(?,?,?,?,?,?)`)
      .run(randomUUID(), f.account.id, NOW, 'fixture', 'suppression', NOW);
    else f.db.raw.prepare(`INSERT INTO pm_handle_suppression_tombstones(id,kind,normalized_value,observed_at,source,evidence_ref,admitted_at) VALUES(?,'email',?,?,?,?,?)`)
      .run(randomUUID(), EMAIL, NOW, 'fixture', 'suppression', NOW);
    const before = allRows(f.db);
    expect(() => f.repo().admitReviewedBusinessEmail({ ...f.request, commandId: randomUUID(), expectedAccountVersion: 3 })).toThrow();
    expect(() => f.drafts().open({ commandId: randomUUID(), accountId: f.account.id, routeId: draft.recipientBinding.routeId, expectedRouteVersion: 1, expectedAccountVersion: 3 })).toThrow();
    expect(() => f.drafts().save({ commandId: randomUUID(), accountId: f.account.id, draftId: draft.id, expectedRevision: 1, subject: 'held', body: 'held' })).toThrow();
    expect(f.drafts().get({ accountId: f.account.id, draftId: draft.id })).toMatchObject({ draft, reason: 'suppressed', editable: false });
    expect(allRows(f.db)).toEqual(before);
  } finally { f.close(); }
});
it('P4 ordinary new facts retain eligibility, later target-negative evidence allows frozen text-only recovery, DB bindings stay immutable', async () => {
  const f = await fixture();
  try {
    const opened = f.open(), draft = opened.current.draft;
    f.repo().admitEvidence({ commandId: randomUUID(), accountId: f.account.id, expectedVersion: 3, sources: [], routes: [],
      claims: [{ key: 'technology', kind: 'fact', value: 'New portal fact', evidenceIds: [f.sourceId] }] });
    expect(f.drafts().get({ accountId: f.account.id, draftId: draft.id })).toMatchObject({ stale: false, editable: true, draft });
    f.source(`Tenant-only email: ${EMAIL}`);
    expect(f.drafts().get({ accountId: f.account.id, draftId: draft.id })).toMatchObject({ reason: 'evidence_unavailable', editable: true, draft });
    const saved = f.drafts().save({ commandId: randomUUID(), accountId: f.account.id, draftId: draft.id, expectedRevision: 1, subject: 'Manual recovery', body: 'Still frozen' });
    expect(saved.current.draft.recipientBinding).toEqual(draft.recipientBinding);
    const before = allRows(f.db);
    for (const column of ['email', 'company_label', 'source_ids_json', 'publication_json', 'account_id', 'route_id', 'kind', 'status', 'created_at']) {
      expect(() => f.db.raw.prepare(`UPDATE local_company_email_drafts SET ${column}='changed',revision=revision+1 WHERE id=?`).run(draft.id)).toThrow();
    }
    expect(() => f.db.raw.prepare('DELETE FROM local_company_email_drafts WHERE id=?').run(draft.id)).toThrow();
    expect(() => f.db.raw.prepare('UPDATE local_company_draft_commands SET applied_revision=99').run()).toThrow();
    expect(() => f.db.raw.prepare('DELETE FROM local_company_draft_commands').run()).toThrow();
    expect(() => f.db.raw.prepare('DELETE FROM pm_accounts WHERE id=?').run(f.account.id)).toThrow();
    expect(allRows(f.db)).toEqual(before);
    await f.reopen(); expect(f.drafts().get({ accountId: f.account.id, draftId: draft.id })).toEqual(saved.current);
  } finally { f.close(); }
});

it('request-dependent replies bind original receipt and current frozen draft without accepting unrelated publication or selectors', async () => {
  const f = await fixture();
  try {
    const admission = f.admit(), opened = f.open(), draft = opened.current.draft;
    expect(companyDraftAdmissionReply(f.request).parse(admission)).toEqual(admission);
    expect(companyDraftAdmissionReply({ ...f.request, quote: 'Unrelated quote' }).safeParse({ ...admission, publication: { ...admission.publication, quote: 'Unrelated quote' } }).success).toBe(false);
    expect(companyDraftGetReply({ accountId: f.account.id, routeId: 'wrong' }).safeParse(opened.current).success).toBe(false);
    expect(companyDraftGetReply({ accountId: 'other', draftId: draft.id }).safeParse(opened.current).success).toBe(false);
    expect(companyDraftOpenReply({ commandId: opened.receipt.commandId, accountId: f.account.id, routeId: draft.recipientBinding.routeId, expectedRouteVersion: 2, expectedAccountVersion: 3 }).safeParse(opened).success).toBe(false);
    const save = { commandId: randomUUID(), accountId: f.account.id, draftId: draft.id, expectedRevision: 1, subject: 'Exact', body: 'Text' };
    const saved = f.drafts().save(save);
    expect(companyDraftSaveReply(save).parse(saved)).toEqual(saved);
    expect(companyDraftSaveReply(save).safeParse({ ...saved, current: { ...saved.current, draft: { ...saved.current.draft, body: 'Wrong current text' } } }).success).toBe(false);
  } finally { f.close(); }
});
