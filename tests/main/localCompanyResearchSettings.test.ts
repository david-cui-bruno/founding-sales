import { getCompanyResearchProfiles } from '../../src/main/research/knownCompanyRequestProfile';
import { companyResearchSettingsUpdateReplySchema } from '../../src/shared/contracts/localWorkspaceContract';
import type { FoundationRuntime } from '../../src/main/foundation/foundationRuntime';
import { AccountRepository } from "../../src/main/domain/accounts/accountRepository";

import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createCampaignFixture } from '../fixtures/campaignWorkspace';
import { createDomainServices } from '../../src/main/domain/createDomainServices';
import { createFounderSalesDomain } from '../../src/main/domain/founderSalesDomain';
import { createLocalWorkspaceProvider } from '../../src/main/workspace/localWorkspaceProvider';
it('exposes null-start unpaired local setup without research or pairing', async () => {
  const f = await createCampaignFixture();
  try {
    const ids = { next: randomUUID };
    const services = createDomainServices({ database: f.db, clock: f.clock, ids });
    const domain = createFounderSalesDomain({ database: f.db, clock: f.clock, ids, services });
    const api = createLocalWorkspaceProvider({ withDomain: async fn => fn(domain), withDatabase: async fn => fn(f.db) });
    expect(await api.getCompanyResearchSettings()).toMatchObject({ revision: 0, configuration: null, blockedReason: null, reservedOrSpentMicros: 0 });
  } finally { f.close(); }
});

it('CAS, main profile equality, retained pause, conflict and lost acknowledgement never reset the ledger', async () => {
  const f = await createCampaignFixture();
  try {
    const ids = { next: randomUUID };
    const services = createDomainServices({ database: f.db, clock: f.clock, ids });
    const domain = createFounderSalesDomain({ database: f.db, clock: f.clock, ids, services });
    const gate: Pick<FoundationRuntime, 'withDomain' | 'withDatabase'> = { withDomain: async fn => fn(domain), withDatabase: async fn => fn(f.db) };
    let paired = false; let lost = false; let callbacks = 0;
    const api = createLocalWorkspaceProvider(gate, undefined, { pairedResearchPresent: async () => paired, changed: async () => { callbacks++; if (lost) throw Error('lost'); } });
    const initial = await api.getCompanyResearchSettings(); const profile = initial.profiles[0]!;
    const configuration = { version: 1 as const, mode: 'known_company' as const, state: 'active' as const, profileId: profile.id, researchLimits: profile.researchLimits, maxAccountBudgetMicros: 100000, permittedSources: ['https://example.invalid/about'] };
    const input = { expectedRevision: 0, configuration, reviewed: true };
    const baseline = f.db.raw.prepare('SELECT timezone,daily_dial_capacity,created_at FROM workspace_settings').get();
    await expect(api.updateCompanyResearchSettings({ ...input, reviewed: false })).rejects.toThrow();
    await expect(api.updateCompanyResearchSettings({ ...input, configuration: { ...configuration, researchLimits: { ...configuration.researchLimits, maxPages: 2 } } })).rejects.toThrow();
    await expect(api.updateCompanyResearchSettings({ ...input, configuration: { ...configuration, permittedSources: ['http://example.invalid'] } })).rejects.toThrow();
    expect((await api.updateCompanyResearchSettings(input)).revision).toBe(1);
    await expect(api.updateCompanyResearchSettings(input)).rejects.toThrow();
    expect(callbacks).toBe(1);
    const repo = new AccountRepository({ database: f.db, clock: f.clock, ids, research: { maxBudgetMicros: 100000, knownCompanyExtraction: configuration.researchLimits.knownCompanyExtraction } });
    const account = repo.create({ commandId: randomUUID(), name: 'Fictional ledger company', domain: 'example.invalid' });
    const selected = { commandId: randomUUID(), accountId: account.id };
    repo.enqueue({ ...selected, limits: configuration.researchLimits });
    const job = repo.claimSelected(f.now, selected)!;
    expect((await api.getCompanyResearchSettings()).reservedOrSpentMicros).toBe(20000);
    paired = true;
    await expect(api.updateCompanyResearchSettings({ ...input, expectedRevision: 1 })).rejects.toThrow();
    const paused = { ...configuration, state: 'paused' as const };
    await expect(api.updateCompanyResearchSettings({ expectedRevision: 1, reviewed: false, configuration: { ...paused, maxAccountBudgetMicros: 200000 } })).rejects.toThrow();
    expect(await api.updateCompanyResearchSettings({ expectedRevision: 1, reviewed: false, configuration: paused })).toMatchObject({ revision: 2, configuration: paused, blockedReason: 'paired_research_present', reservedOrSpentMicros: 20000 });
    paired = false; lost = true;
    await expect(api.updateCompanyResearchSettings({ ...input, expectedRevision: 2 })).rejects.toThrow('lost');
    expect(await api.getCompanyResearchSettings()).toMatchObject({ revision: 3, configuration, reservedOrSpentMicros: 20000 });
    repo.settle({ jobId: job.id, claimToken: job.claimToken, status: 'parked', receiptCommandId: null, costMicros: 123 });
    expect((await api.getCompanyResearchSettings()).reservedOrSpentMicros).toBe(123);
    expect(f.db.raw.prepare('SELECT timezone,daily_dial_capacity,created_at FROM workspace_settings').get()).toEqual(baseline);
    f.db.raw.prepare('UPDATE workspace_settings SET known_company_research_revision=?').run(Number.MAX_SAFE_INTEGER);
    await expect(api.updateCompanyResearchSettings({ ...input, expectedRevision: Number.MAX_SAFE_INTEGER })).rejects.toThrow();
    f.db.raw.prepare("UPDATE workspace_settings SET known_company_research_json='{}'").run();
    await expect(api.getCompanyResearchSettings()).rejects.toThrow();
  } finally { f.close(); }
});

it('binds replies to exact submitted revision and configuration, with no loose discovery shape', () => {
  const profile = getCompanyResearchProfiles()[0]!;
  const configuration = { version: 1 as const, mode: 'known_company' as const, state: 'active' as const, profileId: profile.id, researchLimits: profile.researchLimits, maxAccountBudgetMicros: 20000, permittedSources: ['https://example.invalid/about'] };
  const input = { expectedRevision: 0, configuration, reviewed: true };
  const result = { revision: 1, configuration, profiles: [profile], blockedReason: null as null, reservedOrSpentMicros: 0 };
  const schema = companyResearchSettingsUpdateReplySchema(input);
  expect(schema.safeParse(result).success).toBe(true);
  expect(schema.safeParse({ ...result, revision: 0 }).success).toBe(false);
  expect(schema.safeParse({ ...result, configuration: { ...configuration, maxAccountBudgetMicros: 30000 } }).success).toBe(false);
  expect(schema.safeParse({ ...result, configuration: { ...configuration, audience: {} } }).success).toBe(false);
});
