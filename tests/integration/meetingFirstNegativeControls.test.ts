import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createPmFixture, PM_NOW } from '../fixtures/pmAccounts';
import { AccountRepository } from '../../src/main/domain/accounts/accountRepository';
import { SqlDiscoveryReservationStore } from '../../src/main/delegation/discoveryReservationStore';
import { createCompanyDiscoveryProvider, requestCompanyDiscovery } from '../../src/main/research/companyDiscoveryProvider';
import { createCompanyPageProvider } from '../../src/main/research/companyPageProvider';
import { createFetchedReceiptPolicy } from '../../src/main/research/companySourcePolicy';
import { createCompanyPreparation, createCompanyResearchWorker } from '../../src/main/research/companyResearchWorker';

const limits = { maxCompanies: 1, maxPages: 1, maxBytes: 16000, maxCostMicros: 100 };
const officialUrl = 'https://example.invalid/';
const page = '<p>We manage 240 residential units.</p><p>We are a regional property management company.</p><p>Business switchboard: +14015550100</p>';

// These tests compose public production services, not copied preparation/counting
// algorithms. All HTTP/clipboard/shell effects are fictional. No release/UI claim.
async function discoveryFixture(discoveryEnabled: boolean) {
  const f = await createPmFixture();
  const clock = { now: () => PM_NOW };
  const workspaceId = randomUUID(); const budgetId = 'fictional-negative-control-budget';
  const capability = { model: 'fictional-model', webSearch: true as const, searchCostMicros: 50, modelCostMicros: 50 };
  const receipts = createFetchedReceiptPolicy(); const requests: string[] = [];
  const accounts = new AccountRepository({ database: f.db, clock, ids: { next: randomUUID }, sourcePolicy: receipts, research: { maxBudgetMicros: 100 } });
  const reservations = new SqlDiscoveryReservationStore({ database: f.db, workspaceId, clock });
  const configuration = { workspaceId, budgetId, audience: { residential: true, regions: ['Fictional Region'], terms: ['residential PM'] },
    discoveryLimits: limits, researchLimits: limits, capability };
  const discovery = createCompanyDiscoveryProvider({ capability, request: (query, requestLimits, signal) => requestCompanyDiscovery({
    query, limits: requestLimits, signal, capability, credentials: { apiKey: 'fictional-not-a-credential', model: capability.model },
    fetch: async url => {
      expect(String(url)).toBe('https://api.openai.com/v1/responses');
      requests.push(String(url));
      // Same real adapter and SQL composition. Only external discovery is disabled.
      if (!discoveryEnabled) throw new Error('fictional discovery disabled');
      return Response.json({ status: 'completed', model: capability.model, output: [
        { type: 'web_search_call', status: 'completed', action: { type: 'search', sources: [{ type: 'url', url: officialUrl }] } },
        { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text',
          text: JSON.stringify({ companies: [{ name: 'Fictional Regional PM', domain: 'example.invalid', sourceUrl: officialUrl }] }),
          annotations: [{ type: 'url_citation', url: officialUrl }] }] },
      ] });
    },
  }) });
  const pages = createCompanyPageProvider({ receipts, clock, permitted: url => url === officialUrl,
    resolve: async host => { expect(host).toBe('example.invalid'); return ['93.184.216.34']; },
    http: async input => { expect(input.url).toBe(officialUrl); requests.push(input.url); return new Response(page, { headers: { 'content-type': 'text/html' } }); } });
  reservations.approveBudget({ budgetId, ceilingMicros: 100, evidenceRef: 'fictional-explicit-approval' });
  return { ...f, accounts, requests,
    preparation: createCompanyPreparation({ store: accounts, reservations, discovery, configuration }),
    worker: createCompanyResearchWorker({ store: accounts, pages, clock }),
    assertPreparedAccount() {
      expect(f.db.raw.prepare('SELECT name,domain FROM pm_accounts ORDER BY id').all())
        .toEqual([{ name: 'Fictional Regional PM', domain: 'example.invalid' }]);
    },
  };
}

describe('D5 partial source negative controls', () => {
  it.each([true, false])('real discovery enabled=%s: prepared-account assertion is sensitive to the external boundary', async enabled => {
    const noNetwork = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Unconfigured network forbidden'); });
    const f = await discoveryFixture(enabled);
    try {
      const signal = new AbortController().signal;
      const pending = f.preparation.prepare(randomUUID(), signal);
      if (enabled) {
        const prepared = await pending;
        expect(prepared.status).toBe('prepared');
        f.assertPreparedAccount();
        expect(await f.worker.runNext(signal)).toBe('completed');
        expect(f.accounts.snapshot(prepared.accountIds[0]!, PM_NOW).routes).toEqual([
          expect.objectContaining({ channel: 'phone', value: '+14015550100', personId: null, verification: 'published' }),
        ]);
        expect(f.requests).toEqual(['https://api.openai.com/v1/responses', officialUrl]);
      } else {
        await expect(pending).rejects.toThrow();
        expect(f.db.raw.prepare('SELECT * FROM pm_accounts').all()).toEqual([]);
        expect(f.db.raw.prepare('SELECT * FROM pm_account_research_jobs').all()).toEqual([]);
        expect(await f.worker.runNext(signal)).toBe('idle');
        // The exact positive prepared-account oracle must fail when discovery is absent.
        expect(() => f.assertPreparedAccount()).toThrow(/deeply equal/);
        expect(f.requests).toEqual(['https://api.openai.com/v1/responses']);
      }
      expect(f.db.raw.pragma('foreign_key_check')).toEqual([]);
      expect(noNetwork).not.toHaveBeenCalled();
    } finally { f.close(); noNetwork.mockRestore(); }
  });

});
