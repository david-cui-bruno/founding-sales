import { CALLIE_PRODUCT_FACTS } from '../../src/shared/product/callieProductFacts';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createCampaignFixture } from '../fixtures/campaignWorkspace';
import { AccountRepository } from '../../src/main/domain/accounts/accountRepository';
import { accountFingerprint } from '../../src/main/domain/accounts/accountEvidence';
import { createCompanyPageProvider } from '../../src/main/research/companyPageProvider';
import { createFetchedReceiptPolicy } from '../../src/main/research/companySourcePolicy';
import { createLinkedInDraftProvider } from '../../src/main/linkedin/linkedInDraftProvider';
import { LinkedInRepository } from '../../src/main/linkedin/linkedInRepository';
import { LinkedInService } from '../../src/main/linkedin/linkedInService';

it('prepares a durable draft from actual company-page extraction and B1 admission without a seeded LinkedIn route', async () => {
  const f = await createCampaignFixture();
  try {
    const receipts = createFetchedReceiptPolicy();
    const accounts = new AccountRepository({ database: f.db, clock: f.clock, ids: { next: randomUUID }, sourcePolicy: receipts });
    const account = accounts.create({ commandId: randomUUID(), name: 'Fictional Residential PM', domain: 'example.invalid' });
    const requests: string[] = [];
    const pages = createCompanyPageProvider({ receipts, clock: f.clock, permitted: url => url === 'https://example.invalid/',
      resolve: async () => ['93.184.216.34'], http: async ({ url }) => { requests.push(url); return new Response('<main><h1>Business team contact</h1><p>We manage residential properties.</p><a href="https://www.linkedin.com/in/fictional-business-contact">Business team LinkedIn profile</a></main>', { headers: { 'content-type': 'text/html' } }); } });
    const batch = await pages.research(accounts.snapshot(account.id, f.now), { maxCompanies: 1, maxPages: 1, maxBytes: 2000, maxCostMicros: 100 }, new AbortController().signal);
    accounts.admitEvidence(batch);
    const snapshot = accounts.snapshot(account.id, f.now);
    const route = snapshot.routes.find(route => route.channel === 'linkedin');
    expect(route).toMatchObject({ accountId: account.id, personId: null, purpose: 'business', verification: 'published', value: 'https://www.linkedin.com/in/fictional-business-contact' });
    if (!route) throw new Error('Published LinkedIn route missing');
    expect(requests).toEqual(['https://example.invalid/']);
    expect(route.evidenceIds).toEqual([batch.sources[0]!.id]);
    const version = { ...f.versions[0]!, id: randomUUID(), campaignId: randomUUID(), cohortAccountIds: [account.id], steps: [{ id: randomUUID(), channel: 'linkedin' as const, condition: 'initial' as const, delayHours: 0 }] };
    f.repo.createVersion({ commandId: randomUUID(), version });
    f.repo.approve({ commandId: randomUUID(), campaignVersionId: version.id, snapshotHash: accountFingerprint(version), approvedAt: f.now });
    const enrollment = f.repo.enroll({ commandId: randomUUID(), accountId: account.id, selectedRouteId: route.id, campaignVersionId: version.id, contextRevision: 0, executionContextId: randomUUID() });
    let suppliedContext: unknown;
    const provider = createLinkedInDraftProvider({ credentials: { load: async () => ({ model: { apiKey: 'fictional-key', model: 'fictional-model' } }) },
      fetch: async (_url, init) => { suppliedContext = JSON.parse(JSON.parse(String(init?.body)).input); return Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify({ body: 'Fictional editable message', evidenceIds: [CALLIE_PRODUCT_FACTS.facts[0].id] }) }] }] }); } });
    const repository = new LinkedInRepository({ database: f.db, workspaceId: f.workspaceId, enrollmentId: enrollment.id, clock: f.clock });
    const service = new LinkedInService({ repository, provider });
    const draft = await service.prepare({ enrollmentId: enrollment.id, stepId: version.steps[0]!.id, expectedVersion: 1 });
    expect(draft).toMatchObject({ accountId: account.id, personId: null, routeId: route.id, routeVersion: route.version, body: 'Fictional editable message', state: 'draft' });
    expect(suppliedContext).toMatchObject({ accountId: account.id, personId: null, personName: null });
    expect(JSON.stringify(suppliedContext)).toContain(`source:${batch.sources[0]!.id}`);
    await service.save({ draftId: draft.id, expectedRevision: 1, body: 'Human company-scoped edit' });
    expect((await new LinkedInService({ repository }).prepare({ enrollmentId: enrollment.id, stepId: version.steps[0]!.id, expectedVersion: 1 })).body).toBe('Human company-scoped edit');
  } finally { f.close(); }
});
