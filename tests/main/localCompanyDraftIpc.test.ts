import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
const electron = vi.hoisted(() => ({ handle: vi.fn(), removeHandler: vi.fn() }));
vi.mock('electron', () => ({ ipcMain: electron }));
import { openDatabase, closeDatabase, type AppDatabase } from '../../src/main/db/database';
import { inspectDatabaseEncryption } from '../../src/main/db/databaseEncryption';
import { prepareEncryptedDatabase } from '../../src/main/db/plaintextDatabaseUpgrade';
import { migrateToLatest } from '../../src/main/db/migrate';
import { DomainRuntime } from '../../src/main/domain/domainRuntime';
import { FoundationRuntime } from '../../src/main/foundation/foundationRuntime';
import { HealthService } from '../../src/main/health/healthService';
import { AccountRepository } from '../../src/main/domain/accounts/accountRepository';
import { ExecutionClient } from '../../src/main/delegation/executionClient';
import * as emailService from '../../src/main/outreach/emailService';
import * as phoneLauncher from '../../src/main/communications/phoneHandoffLauncher';
import { createLocalWorkspaceProvider } from '../../src/main/workspace/localWorkspaceProvider';
import { registerLocalWorkspaceIpc } from '../../src/main/workspace/registerLocalWorkspaceIpc';
import { createLocalWorkspaceApi } from '../../src/preload/apis/localWorkspaceApi';
import { createIpcClient } from '../../src/preload/ipcClient';
import { registeredIpcHandler } from '../fixtures/registeredIpcHandler';
import { createTempDatabase, createTestWorkspaceKey } from '../fixtures/tempDatabase';

const trusted = { senderFrame: { url: 'callie://app/index.html' } };
const email = 'info@draft-pm.example';
const quote = `Business email: ${email}`;
const excerpt = `Fictional Draft PM manages residential homes in Rhode Island.\nThe company coordinates maintenance and uses a resident portal.\n${quote}`;
const source = { id: 'draft-publication', url: 'https://draft-pm.example/about', fetchedAt: '2026-09-15T18:00:00.000Z',
  sha256: createHash('sha256').update(excerpt).digest('hex'), excerpt, permitted: true };
const unchangedTables = ['persons', 'prospects', 'sales_cycles', 'person_contact_methods', 'pm_account_links', 'activities',
  'email_drafts', 'email_send_intents', 'email_send_results', 'delegated_commands', 'delegated_applied_events',
  'campaign_enrollments', 'campaign_step_receipts', 'pm_account_outbound_intents', 'pm_account_outbound_results', 'pm_account_research_jobs'];
const auditRows = (database: AppDatabase) => unchangedTables.map(table => ({ table, rows: database.raw.prepare(`SELECT * FROM ${table}`).all() }));
const evidenceRows = (database: AppDatabase, accountId: string) => ['pm_account_claims', 'pm_account_claim_evidence', 'pm_account_sources']
  .map(table => ({ table, rows: database.raw.prepare(`SELECT * FROM ${table} WHERE account_id=?`).all(accountId) }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('company-only unsent draft admits quoted inbox, saves exact text and survives a fresh encrypted runtime without personal or outbound effects', async () => {
  const temp = createTempDatabase(), key = createTestWorkspaceKey();
  const forbidden = vi.fn((): never => { throw new Error('Company draft must not invoke provider/mail/phone/worker effects'); });
  vi.stubGlobal('fetch', forbidden);
  const effects = [vi.spyOn(emailService, 'createEmailService').mockImplementation(forbidden),
    vi.spyOn(phoneLauncher, 'createPhoneHandoffLauncher').mockImplementation(forbidden),
    vi.spyOn(ExecutionClient.prototype, 'submit').mockImplementation(forbidden),
    vi.spyOn(ExecutionClient.prototype, 'sync').mockImplementation(forbidden)];
  const clock = { now: () => new Date().toISOString() };
  const runtimes: FoundationRuntime[] = [], removers: (() => void)[] = [];
  let opens = 0, closes = 0;
  function session(databaseExists: boolean) {
    electron.handle.mockClear();
    const runtime = new FoundationRuntime({ appVersion: '1.0.0', databasePath: temp.path, databaseExists,
      backupDirectory: join(dirname(temp.path), 'backups'), keyEnvelopePath: join(dirname(temp.path), 'fixture-envelope.json') }, {
      loadWorkspaceKey: async () => ({ ...key, bytes: Buffer.from(key.bytes) }), prepareEncryptedDatabase,
      openDatabase: options => { opens++; return openDatabase(options); }, migrateToLatest,
      createDomainRuntime: database => new DomainRuntime({ database, clock, ids: { next: randomUUID } }),
      createHealthService: options => new HealthService(options), closeDatabase: database => { closeDatabase(database); closes++; },
    });
    runtimes.push(runtime);
    const remove = registerLocalWorkspaceIpc(createLocalWorkspaceProvider(runtime, { current: forbidden })); removers.push(remove);
    const invoke = vi.fn(async (channel: string, ...args: unknown[]) => registeredIpcHandler(electron.handle, channel)(trusted, ...args));
    return { runtime, remove, invoke, api: createLocalWorkspaceApi(createIpcClient({ invoke })) };
  }
  try {
    const first = session(false);
    const created = await first.api.createCompany({ commandId: randomUUID(), name: 'Fictional Draft PM', domain: 'draft-pm.example' });
    expect(created.status).toBe('saved'); if (created.status !== 'saved') throw new Error('Expected real saved company');
    const accountId = created.account.id;
    // Trusted fixture admission of saved source/facts, never renderer-authored research or a real website fetch.
    await first.runtime.withDatabase(database => new AccountRepository({ database, clock, ids: { next: randomUUID },
      sourcePolicy: { attest: (candidate, owner) => owner === accountId && candidate.id === source.id && candidate.url === source.url && candidate.sha256 === source.sha256 && candidate.excerpt === source.excerpt } }).admitEvidence({
      commandId: randomUUID(), accountId, expectedVersion: created.account.version, sources: [source], routes: [], claims: [
        { key: 'residential_scope', kind: 'fact', value: 'Residential homes', evidenceIds: [source.id] },
        { key: 'operating_footprint', kind: 'fact', value: 'Rhode Island', evidenceIds: [source.id] },
        { key: 'maintenance_workflow', kind: 'fact', value: 'Coordinates maintenance', evidenceIds: [source.id] },
        { key: 'technology', kind: 'fact', value: 'Resident portal', evidenceIds: [source.id] },
      ],
    }));
    const before = await first.api.getCompany({ accountId });
    expect(before.snapshot.claims).toHaveLength(4); expect(before.sources).toEqual([source]); expect(before.snapshot.routes).toEqual([]);
    const originalRows = await first.runtime.withDatabase(auditRows);
    const originalEvidence = await first.runtime.withDatabase(database => evidenceRows(database, accountId));
    expect(originalRows.every(entry => entry.rows.length === 0)).toBe(true);
    expect(await first.runtime.withDatabase(inspectDatabaseEncryption)).toMatchObject({ encrypted: true, integrity: 'ok' });

    // Intended first absent-method RED on the current product. Keep this direct public call, not a fake API or optional fallback.
    await first.api.admitCompanyDraftEmail({ commandId: randomUUID(), accountId, expectedAccountVersion: before.snapshot.account.version,
      email, sourceId: source.id, quote, selection: 'published_company_business_inbox' });
    const admitted = await first.api.getCompany({ accountId });
    expect(admitted.snapshot.routes).toHaveLength(1); const route = admitted.snapshot.routes[0];
    expect(route).toMatchObject({ accountId, personId: null, channel: 'email', value: email, purpose: 'business', verification: 'published', evidenceIds: [source.id] });
    expect(admitted.snapshot.claims).toEqual(before.snapshot.claims); expect(admitted.sources).toEqual(before.sources);
    await first.api.openCompanyDraft({ commandId: randomUUID(), accountId, routeId: route.id,
      expectedRouteVersion: route.version, expectedAccountVersion: admitted.snapshot.account.version });
    const opened = await first.api.getCompanyDraft({ accountId, routeId: route.id });
    expect(opened).not.toBeNull(); if (!opened) throw new Error('Opened draft must be discoverable by saved route');
    expect(opened).toMatchObject({ stale: false, editable: true });
    expect(opened.draft).toMatchObject({ kind: 'local_company_email', status: 'unsent', accountId, revision: 1, subject: '', body: '',
      recipientBinding: { routeId: route.id, routeVersion: route.version, email, personId: null } });
    const subject = 'Manual unsent draft: exact company context';
    const body = 'Hello company team,\n\nThis is manually saved text, not a sent message.\nUnicode: café • <untrusted text>\nTrailing spaces stay here.  \n';
    await first.api.saveCompanyDraft({ commandId: randomUUID(), accountId, draftId: opened.draft.id, expectedRevision: 1, subject, body });
    const saved = await first.api.getCompanyDraft({ accountId, draftId: opened.draft.id });
    expect(saved).not.toBeNull(); if (!saved) throw new Error('Saved draft missing');
    expect(saved.draft).toEqual({ ...opened.draft, revision: 2, subject, body, updatedAt: expect.any(String) });
    expect(await first.api.getCompany({ accountId })).toMatchObject({ snapshot: { account: admitted.snapshot.account, claims: before.snapshot.claims }, sources: before.sources });
    expect(await first.runtime.withDatabase(auditRows)).toEqual(originalRows);
    expect(await first.runtime.withDatabase(database => evidenceRows(database, accountId))).toEqual(originalEvidence);
    first.remove(); await first.runtime.shutdown(); expect(opens).toBe(1); expect(closes).toBe(1);

    const second = session(true); expect(second.runtime).not.toBe(first.runtime); expect(second.api).not.toBe(first.api);
    const discovered = await second.api.getCompanyDraft({ accountId, routeId: route.id });
    expect(discovered).not.toBeNull(); if (!discovered) throw new Error('Restart lost the route-discoverable draft');
    expect(discovered.draft).toEqual(saved.draft); expect(discovered).toMatchObject({ stale: false, editable: true });
    const changes = await second.runtime.withDatabase(database => database.raw.prepare('SELECT total_changes() AS n').get());
    expect((await second.api.getCompanyDraft({ accountId, draftId: saved.draft.id }))?.draft).toEqual(saved.draft);
    expect(await second.runtime.withDatabase(database => database.raw.prepare('SELECT total_changes() AS n').get())).toEqual(changes);
    expect(await second.api.getCompany({ accountId })).toMatchObject({ snapshot: { account: admitted.snapshot.account, claims: before.snapshot.claims }, sources: before.sources });
    expect(await second.runtime.withDatabase(auditRows)).toEqual(originalRows);
    expect(await second.runtime.withDatabase(database => evidenceRows(database, accountId))).toEqual(originalEvidence);
    expect(await second.runtime.withDatabase(inspectDatabaseEncryption)).toMatchObject({ encrypted: true, integrity: 'ok' });
    expect(opens).toBe(2); expect(forbidden).not.toHaveBeenCalled(); for (const effect of effects) expect(effect).not.toHaveBeenCalled();
    second.remove(); await second.runtime.shutdown(); expect(closes).toBe(2);
  } finally {
    removers.reverse().forEach(remove => remove());
    await Promise.all(runtimes.map(runtime => runtime.shutdown())); key.bytes.fill(0); temp.cleanup();
  }
}, 30_000);
