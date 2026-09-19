import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { closeDatabase, openDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { AccountRepository } from '../../src/main/domain/accounts/accountRepository';
import { createCompanyDiscoveryProvider, requestCompanyDiscovery } from '../../src/main/research/companyDiscoveryProvider';
import { createCompanyPageProvider } from '../../src/main/research/companyPageProvider';
import { createFetchedReceiptPolicy } from '../../src/main/research/companySourcePolicy';
import { createCompanyPreparation, createCompanyResearchWorker } from '../../src/main/research/companyResearchWorker';
import { SqlDiscoveryReservationStore } from '../../src/main/delegation/discoveryReservationStore';
import { createDomainServices } from '../../src/main/domain/createDomainServices';
import { rankAccount } from '../../src/shared/accounts/accountRanking';
import { rankAccount as workerRankAccount } from '../../cloud/lambdas/delegated-worker/src/index';
import { createTempDatabase, createTestWorkspaceKey } from '../fixtures/tempDatabase';

const now = '2026-09-08T14:00:00.000Z';
const clock = { now: () => now };
const limits = { maxCompanies: 1, maxPages: 1, maxBytes: 16000, maxCostMicros: 100 };
const page = '<p>We manage 240 residential units.</p><p>We are a regional property management company.</p><p>Business switchboard: +14015550100</p>';

describe('assembled fictional company preparation, not renderer acceptance', () => {
  it('uses HTTP discovery and pages, durable budgets and receipt restart before actual Today projection', async () => {
    const temp = createTempDatabase(); const key = createTestWorkspaceKey();
    let database = openDatabase({ path: temp.path, key });
    const noNetwork = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Unconfigured network forbidden'); });
    try {
      await migrateToLatest(database, { backupDirectory: `${temp.path}.backups`, workspaceKey: key });
      const workspaceId = randomUUID(); const budgetId = 'fictional-approved-budget';
      const capability = { model: 'fictional-model', webSearch: true as const, searchCostMicros: 50, modelCostMicros: 50 };
      const receipts = createFetchedReceiptPolicy(); const requests: string[] = [];
      const makeRepo = () => new AccountRepository({ database, clock, ids: { next: randomUUID }, sourcePolicy: receipts, research: { maxBudgetMicros: 100 } });
      let repo = makeRepo();
      const makeReservations = () => new SqlDiscoveryReservationStore({ database, workspaceId, clock });
      let reservations = makeReservations();
      const discovery = createCompanyDiscoveryProvider({ capability, request: (query, requestLimits, signal) => requestCompanyDiscovery({
        query, limits: requestLimits, signal, capability, credentials: { apiKey: 'fictional-not-a-credential', model: capability.model },
        fetch: async (url, init) => {
          expect(String(url)).toBe('https://api.openai.com/v1/responses');
          expect(JSON.parse(String(init?.body))).toMatchObject({ store: false, tool_choice: 'required' });
          requests.push(String(url));
          return new Response(JSON.stringify({ status: 'completed', model: capability.model, output: [
            { type: 'web_search_call', status: 'completed', action: { type: 'search', sources: [{ type: 'url', url: 'https://example.invalid/' }] } },
            { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text',
              text: JSON.stringify({ companies: [{ name: 'Fictional Regional PM', domain: 'example.invalid', sourceUrl: 'https://example.invalid/' }] }),
              annotations: [{ type: 'url_citation', url: 'https://example.invalid/' }] }] },
          ] }));
        },
      }) });
      const configuration = { workspaceId, budgetId, audience: { residential: true, regions: ['Fictional Region'], terms: ['residential PM'] }, discoveryLimits: limits, researchLimits: limits, capability };
      const prepare = () => createCompanyPreparation({ store: repo, reservations, discovery, configuration });
      const command = randomUUID(); const signal = new AbortController().signal;
      expect(await prepare().prepare(command, signal)).toEqual({ status: 'blocked', accountIds: [] });
      expect(requests).toEqual([]);
      reservations.approveBudget({ budgetId, ceilingMicros: 100, evidenceRef: 'fictional-explicit-budget-approval' });
      const prepared = await prepare().prepare(command, signal);
      expect(prepared.status).toBe('prepared'); expect(prepared.accountIds).toHaveLength(1);
      const accountId = prepared.accountIds[0];
      expect(repo.snapshot(accountId, now).routes).toEqual([]); // Search is never contact evidence.
      const pages = createCompanyPageProvider({ receipts, clock, permitted: url => url === 'https://example.invalid/',
        resolve: async host => { expect(host).toBe('example.invalid'); return ['93.184.216.34']; },
        http: async input => {
          expect(input.url).toBe('https://example.invalid/'); requests.push(input.url);
          return new Response(page, { headers: { 'content-type': 'text/html' } });
        } });
      // Inject crash only at settlement after real worker has admitted real HTTP evidence.
      // No fake successful provider result, contact, or in-memory receipt ledger.
      const settlement = vi.spyOn(repo, 'settle').mockImplementation(() => { throw new Error('fictional crash after durable receipt'); });
      await expect(createCompanyResearchWorker({ store: repo, pages, clock }).runNext(signal)).rejects.toThrow('fictional crash after durable receipt');
      settlement.mockRestore();
      expect(database.raw.prepare('SELECT state,cost_micros,reserved_cost_micros FROM pm_account_research_jobs').get())
        .toEqual({ state: 'running', cost_micros: null, reserved_cost_micros: 100 });
      const committedSources = database.raw.prepare('SELECT id,url,fetched_at,sha256,excerpt FROM pm_account_sources ORDER BY id').all();
      expect(committedSources).toEqual([expect.objectContaining({ url: 'https://example.invalid/', fetched_at: now,
        sha256: createHash('sha256').update(page).digest('hex'), excerpt: page })]);
      const committedCommands = database.raw.prepare('SELECT command_id,account_id,fingerprint,result_json,account_version,created_at FROM pm_account_commands ORDER BY command_id').all();
      closeDatabase(database); database = openDatabase({ path: temp.path, key });
      repo = makeRepo(); reservations = makeReservations();
      expect(await createCompanyResearchWorker({ store: repo, pages, clock }).runNext(signal)).toBe('completed');
      expect(await prepare().prepare(command, signal)).toEqual(prepared);
      expect(await prepare().prepare(randomUUID(), signal)).toEqual({ status: 'blocked', accountIds: [] });
      expect(requests).toEqual(['https://api.openai.com/v1/responses', 'https://example.invalid/']);
      expect(database.raw.prepare('SELECT id,url,fetched_at,sha256,excerpt FROM pm_account_sources ORDER BY id').all()).toEqual(committedSources);
      expect(database.raw.prepare('SELECT command_id,account_id,fingerprint,result_json,account_version,created_at FROM pm_account_commands ORDER BY command_id').all()).toEqual(committedCommands);
      expect(database.raw.prepare('SELECT state,cost_micros,reserved_cost_micros FROM pm_account_research_jobs').get())
        .toEqual({ state: 'completed', cost_micros: null, reserved_cost_micros: 100 });
      const snapshot = repo.snapshot(accountId, now);
      expect(snapshot.routes).toEqual([expect.objectContaining({ accountId, personId: null, channel: 'phone', value: '+14015550100', purpose: 'business', verification: 'published' })]);
      expect(snapshot.claims).toContainEqual(expect.objectContaining({ key: 'operating_footprint', kind: 'fact' }));
      expect(rankAccount(snapshot, now)).toMatchObject({ fit: 'supported', contactable: true });
      expect(workerRankAccount(snapshot, now)).toEqual(rankAccount(snapshot, now));
      const later = '2027-09-08T14:00:00.000Z';
      expect(workerRankAccount(snapshot, later)).toEqual(rankAccount(snapshot, later));
      expect(rankAccount(snapshot, later)).toEqual(rankAccount(snapshot, now));
      // Current snapshot deliberately has no source timestamps. This is an honest
      // representation check, not proof of any stale-source eligibility policy.
      expect(snapshot).not.toHaveProperty('sources');
      expect(snapshot.claims.every(claim => !('fetchedAt' in claim))).toBe(true);
      const services = createDomainServices({ database, clock, ids: { next: randomUUID }, expectedWorkspaceId: workspaceId });
      const planning: Parameters<typeof services.today.planMeetingFirstAccountCalls>[0] = { due: [], ranked: [snapshot], generatedAt: now };
      // Unconfigured call settings mean the D2 default of 30 new firms a day, so the prepared firm is listed before Settings is touched.
      expect(services.today.planMeetingFirstAccountCalls(planning)).toEqual({ accountIds: [accountId], workloadConflict: false });
      const settings = services.workspaceSettings.readMeetingFirstAccountCallSettings();
      services.unitOfWork.immediate(() => services.workspaceSettings.updateMeetingFirstAccountCallSettingsCas({
        expectedRevision: settings.revision, newCallSlots: 1, totalCallCapacity: 1, updatedAt: now,
      }));
      expect(services.today.planMeetingFirstAccountCalls(planning)).toEqual({ accountIds: [accountId], workloadConflict: false });
      expect(snapshot.unknowns).toEqual(expect.arrayContaining(['technology', 'role', 'pain']));
      expect(snapshot.routes[0].evidenceIds).toEqual(committedSources.map((source: { id: string }) => source.id));
      expect(database.raw.prepare('SELECT * FROM persons').all()).toEqual([]);
      expect(database.raw.prepare('SELECT * FROM cadence_enrollments').all()).toEqual([]);
      expect(database.raw.pragma('foreign_key_check')).toEqual([]);
      expect(noNetwork).not.toHaveBeenCalled();
    } finally { noNetwork.mockRestore(); closeDatabase(database); key.bytes.fill(0); temp.cleanup(); }
  });
});
