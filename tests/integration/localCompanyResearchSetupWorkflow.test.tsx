// @vitest-environment jsdom
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react/pure';
import { expect, it, vi } from 'vitest';
import { App } from '../../src/renderer/App';
import type { CalliePreloadApi } from '../../src/shared/preload';
import { localCompanyCreateResultSchema } from '../../src/shared/contracts/localCompanyIntakeContract';
import { localCompanyResearchStatusSchema } from '../../src/shared/contracts/localWorkspaceContract';
import { companyResearchSettingsSchema, companyResearchSettingsUpdateReplySchema, updateCompanyResearchSettingsRequestSchema } from '../../src/shared/contracts/localCompanyResearchSettingsContract';
import { emailDraftSchema } from '../../src/shared/contracts/outreachContract';
import { createFirstUseDomainFixture, localSetupPages, localSetupClaims, localSetupRelationship } from '../fixtures/firstUseDomainFixture';
import { seedIntakePeople } from '../fixtures/discoveryDatabase';
import type { RegisteredIpcHandler } from '../fixtures/registeredIpcHandler';

const transport = vi.hoisted(() => ({ handlers: new Map<string, RegisteredIpcHandler>(), registered: [] as string[], removed: [] as string[], nativeCalls: 0 }));
vi.mock('electron', () => {
  const forbidden = () => { transport.nativeCalls++; throw Error('Native Electron access is forbidden in first-use composition'); };
  return { safeStorage: { isEncryptionAvailable: forbidden, encryptString: forbidden, decryptString: forbidden },
    dialog: { showOpenDialog: forbidden, showSaveDialog: forbidden }, shell: { openExternal: forbidden, openPath: forbidden },
    ipcMain: {
      handle(channel: string, handler: RegisteredIpcHandler) {
        if (transport.handlers.has(channel)) throw Error(`Duplicate registration: ${channel}`);
        transport.registered.push(channel); transport.handlers.set(channel, handler);
      },
      removeHandler(channel: string) { transport.removed.push(channel); transport.handlers.delete(channel); },
    },
  };
});

it('sets up unpaired local company research in App and preserves an attributed, edited, unsent model draft', async () => {
  // This is jsdom + in-process Electron invoke, not a packaged/native-browser test.
  // HTTP/DNS bytes are synthetic. Startup, health, extractor/attestation, all
  // registrars, importer, account repository, composer and encrypted SQL are real.
  const preparedBody = `Maya, Selected Management says: ${localSetupClaims.portfolio_description} Would a conversation be useful?`;
  const f = await createFirstUseDomainFixture(transport.handlers, { localResearchSetup: true,
    draftModel: context => {
      // Deterministic model transport, not a claim about live generation quality.
      // A generic response when the fact is absent makes missing context observable.
      const portfolio = context.facts.find(fact => fact.text.includes(localSetupClaims.portfolio_description));
      return { subject: 'A question for Selected Management',
        body: portfolio ? preparedBody : 'No supported company fact was provided.', evidenceIds: portfolio ? [portfolio.id] : [] };
    },
  });
  const previousApi = Object.getOwnPropertyDescriptor(window, 'callie');
  const previousUrl = window.location.href;
  const previousAct = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  const dialogShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
  const dialogClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.open = false; } });
  const storage = Object.entries(localStorage), session = Object.entries(sessionStorage);
  const attrs = ['data-theme', 'data-density'].map(name => [name, document.documentElement.getAttribute(name)] as const);
  const forbidden = async (): Promise<never> => f.deny('Apple spike');
  let osStatusReads = 0;
  const api: CalliePreloadApi = { ...f.api, appleSpike: {
    // Default Settings diagnostics observes the OS port. No native helper exists
    // in this in-process fixture, and every action remains forbidden below.
    getStatus: async () => { osStatusReads++; throw Error('Synthetic OS status unavailable'); },
    probeCapabilities: forbidden, requestContacts: forbidden, promptAccessibility: forbidden,
    scanRecentNotes: forbidden, scanTestMessages: forbidden, startCallObservation: forbidden, stopCallObservation: forbidden,
    sendTestMessage: forbidden, subscribeObservationEvidence: forbidden,
  } };
  // No ambient fetch is allowed, even if a future production path forgets to use its injected port.
  vi.stubGlobal('fetch', async () => f.deny('ambient fetch'));
  const rows = (table: string) => f.runtime.withDatabase(db => db.raw.prepare(`SELECT * FROM ${table}`).all());
  const countsEmpty = async (tables: string[]) => { for (const table of tables) expect(await rows(table), table).toEqual([]); };
  const click = async (name: string) => {
    await act(async () => { fireEvent.click(screen.getByRole('button', { name })); await f.drain(); });
    // Commit effects can start fresh IPC reads after the original click settles.
    await act(async () => { await f.drain(); });
  };
  const navigate = async (name: string) => {
    await act(async () => { fireEvent.click(screen.getByRole('link', { name })); await f.drain(); });
    await act(async () => { await f.drain(); });
  };
  const change = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label, { exact: true }), { target: { value } });
  const calls = (channel: string) => f.trace.filter(call => call.channel === channel);
  try {
    await countsEmpty(['pm_accounts', 'persons', 'person_contact_methods', 'pm_account_links', 'pm_account_sources', 'email_drafts']);
    const health = await api.health.get();
    expect(health).toMatchObject({ domainReady: true, databaseEncrypted: true });
    expect(health.cipherVersion).toBeTruthy();
    expect(readFileSync(health.databasePath).subarray(0, 16).toString()).not.toBe('SQLite format 3\0');
    expect(await api.outreach.status()).toMatchObject({ model: 'unconfigured', gmail: 'unconfigured', accountEmail: null });
    expect(await api.delegation.status()).toMatchObject({ state: 'unconfigured', workspaceId: null, endpoint: null, configuration: null });
    const initial = companyResearchSettingsSchema.parse(await api.localWorkspace.getCompanyResearchSettings());
    expect(initial).toMatchObject({ revision: 0, configuration: null, blockedReason: null, reservedOrSpentMicros: 0 });
    const profile = initial.profiles.find(item => item.id === 'known-company-gpt-4.1-mini-2025-04-14-v1')!;
    expect(profile).toBeDefined();
    expect(profile.researchLimits).toMatchObject({ maxCompanies: 1, maxPages: 1, maxBytes: 250000, maxCostMicros: 20000,
      knownCompanyExtraction: { model: 'gpt-4.1-mini-2025-04-14', maxInputBytes: 20000, maxOutputTokens: 2048,
        maxCostMicros: 20000, inputMicrosPerMillionTokens: 400000, outputMicrosPerMillionTokens: 1600000 } });
    Object.defineProperty(window, 'callie', { configurable: true, value: api });
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true });
    window.history.replaceState(null, '', '#/settings');
    render(<App />);
    await screen.findByRole('button', { name: 'Connections' });
    await click('Connections');
    await waitFor(() => expect((screen.getByRole('button', { name: 'Save connections' }) as HTMLButtonElement).disabled).toBe(false));
    expect(f.pages).toEqual([]); expect(f.extractionRequests).toEqual([]); expect(f.modelRequests).toEqual([]);
    change('OpenAI API key', 'fictional-local-setup-key');
    change('OpenAI model', 'gpt-4.1-mini-2025-04-14');
    await click('Save connections');
    await waitFor(() => expect(screen.getByText('Connection settings saved.')).toBeTruthy());
    expect(await api.outreach.status()).toMatchObject({ model: 'ready', modelName: 'gpt-4.1-mini-2025-04-14', gmail: 'unconfigured' });
    expect(calls('outreach:configure')).toHaveLength(1);
    // New controls intentionally use the real Settings implementation, never API seeding.
    change('Explicit HTTPS source URLs', 'https://selected.invalid/');
    change('Cumulative local ceiling (USD)', '0.10');
    expect((screen.getByLabelText('I have reviewed this setup') as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByLabelText('I have reviewed this setup'));
    await click('Save local research');
    const settingsWrites = calls('local-workspace:update-company-research-settings');
    expect(settingsWrites).toHaveLength(1);
    const setupRequest = updateCompanyResearchSettingsRequestSchema.parse(settingsWrites[0].args[0]);
    expect(setupRequest).toEqual({ expectedRevision: 0, reviewed: true, configuration: {
      version: 1, mode: 'known_company', state: 'active', profileId: profile.id, researchLimits: profile.researchLimits,
      maxAccountBudgetMicros: 100000, permittedSources: ['https://selected.invalid/'],
    } });
    const configured = companyResearchSettingsUpdateReplySchema(setupRequest).parse(settingsWrites[0].result);
    expect(await api.localWorkspace.getCompanyResearchSettings()).toEqual(configured);
    expect(f.pages).toEqual([]); expect(f.resolutions).toEqual([]);
    expect(f.extractionRequests).toEqual([]); expect(f.modelRequests).toEqual([]);
    await navigate('Accounts');
    await waitFor(() => expect((screen.getByRole('button', { name: 'Add company' }) as HTMLButtonElement).disabled).toBe(false));
    await click('Add company');
    change('Company name', 'Selected Management');
    change('Company domain (optional)', 'selected.invalid');
    await click('Review company');
    await countsEmpty(['pm_accounts', 'persons']);
    await click('Create company');
    const created = localCompanyCreateResultSchema.parse(calls('local-workspace:create-company')[0]?.result);
    expect(created.status).toBe('saved');
    if (created.status !== 'saved') throw Error('Company was not saved');
    const accountId = created.account.id;
    await waitFor(() => expect((screen.getByRole('button', { name: 'Research' }) as HTMLButtonElement).disabled).toBe(false));
    expect(f.pages).toEqual([]);
    expect(f.resolutions).toEqual([]); expect(f.extractionRequests).toEqual([]); expect(f.modelRequests).toEqual([]);
    await click('Research');
    await waitFor(() => expect(screen.getByText('Research known · completed')).toBeTruthy());
    const research = localCompanyResearchStatusSchema.parse(calls('local-workspace:research-company')[0]?.result);
    expect(research).toMatchObject({ accountId, state: 'completed', receipt: { accountId, version: 2, duplicate: false } });
    expect(calls('local-workspace:research-company')).toHaveLength(1);
    expect(await f.runtime.withDatabase(db => db.raw.prepare(`
      SELECT j.account_id, j.command_id, j.state, c.account_id AS receipt_account_id
      FROM pm_account_research_jobs j JOIN pm_account_commands c ON c.command_id = j.receipt_command_id
    `).all())).toEqual([{ account_id: accountId, command_id: research.commandId,
      state: 'completed', receipt_account_id: accountId }]);
    expect(f.pages).toEqual(Object.keys(localSetupPages));
    expect(f.resolutions).toEqual(['selected.invalid']);
    const researched = await api.localWorkspace.getCompany({ accountId });
    expect(researched.sources).toHaveLength(1);
    expect(f.extractionRequests).toHaveLength(1); expect(f.modelRequests).toEqual([]);
    for (const source of researched.sources) {
      expect(source).toMatchObject({ permitted: true, excerpt: [...Object.values(localSetupClaims), localSetupRelationship].join('\n\n'),
        sha256: createHash('sha256').update(localSetupPages[source.url]).digest('hex') });
      expect(Number.isFinite(Date.parse(source.fetchedAt))).toBe(true);
      const evidence = within(screen.getByRole('region', { name: `Source ${source.id}` }));
      expect(evidence.getByText(source.sha256)).toBeTruthy();
      expect(evidence.getByText(source.excerpt, { normalizer: text => text })).toBeTruthy();
    }
    expect(researched.snapshot.portfolio).toEqual([]);
    expect(researched.snapshot.claims).toHaveLength(2);
    for (const [key, value] of Object.entries(localSetupClaims)) {
      expect(researched.snapshot.claims).toContainEqual({ key, value, kind: 'fact', evidenceIds: [researched.sources[0].id] });
      expect(screen.getByText(`Fact: ${value}`)).toBeTruthy();
      const extracted = f.extractionRequests[0].facts.find(fact => fact.key === key)!;
      expect(extracted).toMatchObject({ quote: value, sourceId: researched.sources[0].id });
      const block = f.extractionRequests[0].input.sources[0].blocks.find(item => item.id === extracted.blockId);
      expect(block).toEqual({ id: extracted.blockId, text: value, ref: expect.any(Number) });
    }
    expect(researched.snapshot.routes).toEqual([]);
    await countsEmpty(['persons', 'person_contact_methods', 'pm_account_links', 'email_drafts']);
    await click('Check status');
    expect(f.pages).toEqual(Object.keys(localSetupPages));

    // The CSV person importer left the desktop with the legacy routes, so the same single
    // identity is admitted through the intake service the importer composed (test-only
    // seeding, no IPC channel). The reviewed link below still starts from a stored person,
    // not a fixture-generated ID.
    await countsEmpty(['persons', 'person_contact_methods']);
    const seeded = await f.runtime.withDatabase(() => seedIntakePeople(f.services(), { channel: 'custom', sourceName: 'local-setup.tsv',
      observedAt: new Date().toISOString(), rows: [{ displayName: 'Maya Ortiz', email: 'maya@selected.invalid', organization: 'Selected Management' }] }));
    expect(seeded).toHaveLength(1);
    expect(await rows('persons')).toHaveLength(1);
    expect(await rows('source_intake_receipts')).toHaveLength(1);
    expect(transport.registered.filter(channel => channel.startsWith('imports:'))).toEqual([]);
    expect(screen.queryByRole('button', { name: 'Import named person' })).toBeNull();
    const personId = seeded[0]!.personId;
    await click('Find saved person');
    await click(`Select Maya Ortiz · ${personId}`);
    const person = await api.leadDetail.get({ personId });
    expect(person.emails).toHaveLength(1);
    expect(person.emails[0].value).toBe('maya@selected.invalid');
    expect(person.emails[0].value).not.toBe('office@selected.invalid');
    const contactMethodId = person.emails[0].id;
    const team = researched.sources[0];
    change('Role', 'Property manager');
    change('Relationship', 'Property manager at Selected Management');
    change('Relationship source', team.id);
    const quote = localSetupRelationship;
    change('Source quotation', quote);
    fireEvent.click(screen.getByLabelText('I confirm this saved person and quoted relationship'));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Link saved person' }) as HTMLButtonElement).disabled).toBe(false));
    const contactsBeforeLink = await rows('person_contact_methods');
    await click('Link saved person');
    await screen.findByText(`${personId} · Property manager · Property manager at Selected Management`);
    const linked = await api.localWorkspace.getCompany({ accountId });
    expect(linked.links).toEqual([expect.objectContaining({ personId, authority: 'unconfirmed', authorityEvidenceIds: [], evidenceIds: [team.id] })]);
    expect(linked.sources).toEqual(researched.sources);
    expect(linked.snapshot.routes).toEqual(researched.snapshot.routes);
    expect(await rows('person_contact_methods')).toEqual(contactsBeforeLink);
    expect(calls('local-workspace:link-company-person')[0].args).toEqual([expect.objectContaining({ accountId,
      expectedVersion: 2, sourceQuotes: [{ sourceId: team.id, quote }], link: expect.objectContaining({ personId }) })]);

    // The lead inspector and its person composer left with the legacy routes; the desktop keeps
    // the company draft panel as its only composer. The retained outreach preload namespace still
    // opens and saves the person-level draft through the same validated IPC, without any renderer.
    expect(screen.queryByRole('button', { name: 'Open saved contact' })).toBeNull();
    expect(screen.queryByRole('complementary', { name: 'Maya Ortiz details' })).toBeNull();
    const opened = emailDraftSchema.parse(await api.outreach.openDraft({ personId, contactMethodId }));
    expect(calls('outreach:open-draft')[0].args).toEqual([{ personId, contactMethodId }]);
    {
      expect(opened).toMatchObject({ generation: 'model', body: preparedBody, notice: null });
      expect(f.modelRequests).toHaveLength(1);
      const supplied = f.modelRequests[0];
      expect(supplied).toMatchObject({ url: 'https://api.openai.com/v1/responses', model: 'gpt-4.1-mini-2025-04-14', store: false,
        context: { personName: 'Maya Ortiz', organizationLabel: 'Selected Management' } });
      const portfolio = supplied.context.facts.find(fact => fact.text.includes('"key":"portfolio_description"'))!;
      const source = researched.sources.find(item => item.url === 'https://selected.invalid/')!;
      for (const value of [accountId, 'Selected Management', localSetupClaims.portfolio_description, source.id, source.url, source.fetchedAt, source.sha256]) {
        expect(portfolio.text).toContain(value);
      }
      const allFacts = JSON.stringify(supplied.context.facts);
      expect(allFacts).not.toContain(localSetupRelationship);
      expect(allFacts).not.toContain('office@selected.invalid');
      expect(allFacts).not.toContain('<p>');
      expect(calls('outreach:generate-draft')).toHaveLength(0);
      expect(calls('outreach:save-draft')).toHaveLength(0);
    }
    const saved = emailDraftSchema.parse(await api.outreach.saveDraft({ draftId: opened.id, expectedRevision: opened.revision,
      subject: 'A local introduction', body: 'Maya, I would like to discuss your residential portfolio. This is an unsent local draft.' }));
    expect(emailDraftSchema.parse(calls('outreach:save-draft').at(-1)?.result)).toEqual(saved);
    expect(saved).toMatchObject({ personId, contactMethodId, recipient: 'maya@selected.invalid',
      subject: 'A local introduction', status: 'draft', generation: 'edited' });
    expect(await api.outreach.inspectLocalAuthority({ draftId: saved.id, expectedRevision: saved.revision })).toMatchObject({
      personId, contactMethodId, state: 'held', reason: 'email_authority_unavailable' });
    await navigate('Settings');
    expect(f.extractionRequests).toHaveLength(1); expect(f.modelRequests).toHaveLength(1);
    await navigate('Accounts');
    // Unmount the entire application so reopening cannot pass on visible component
    // state alone. Its next open must return the same real persisted draft via IPC.
    await act(async () => { cleanup(); await f.drain(); });
    render(<App />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add company' })).toBeTruthy());
    // Re-select the company through its public UI after owner replacement.
    await click('Local account · Selected Management');
    await screen.findByText(`${personId} · Property manager · Property manager at Selected Management`);
    expect(screen.queryByRole('button', { name: 'Open saved contact' })).toBeNull();
    const reopened = emailDraftSchema.parse(await api.outreach.openDraft({ personId, contactMethodId }));
    expect(calls('outreach:open-draft')).toHaveLength(2);
    expect(f.modelRequests).toHaveLength(1);
    expect(f.extractionRequests).toHaveLength(1);
    expect(calls('local-workspace:research-company')).toHaveLength(1);
    expect(calls('local-workspace:update-company-research-settings')).toHaveLength(1);
    expect(await api.localWorkspace.getCompanyResearchSettings()).toMatchObject({ revision: configured.revision,
      configuration: configured.configuration, blockedReason: null });
    expect(reopened).toEqual(saved);
    expect(await rows('email_drafts')).toEqual([expect.objectContaining({ id: saved.id, person_id: personId,
      contact_method_id: contactMethodId, subject: saved.subject, body: saved.body, revision: saved.revision, status: 'draft' })]);
    expect(await api.outreach.inspectLocalAuthority({ draftId: reopened.id, expectedRevision: reopened.revision })).toMatchObject({ state: 'held' });
    await countsEmpty(['email_send_intents', 'email_send_results', 'delegated_authorities', 'delegated_commands', 'discovery_reservations', 'cadence_enrollments']);
    for (const channel of ['outreach:send-draft', 'outreach:google-connection-begin', 'outreach:google-connection-revoke',
      'outreach:connect-gmail', 'outreach:delegation-configure', 'outreach:delegation-sync']) expect(calls(channel)).toEqual([]);
    expect(await api.delegation.status()).toMatchObject({ state: 'unconfigured', workspaceId: null, configuration: null });
    const after = await api.leadDetail.get({ personId });
    expect({ stage: after.stage, activities: after.activities, history: after.history, nextAction: after.nextAction })
      .toEqual({ stage: person.stage, activities: person.activities, history: person.history, nextAction: person.nextAction });
    expect(f.pages).toEqual(Object.keys(localSetupPages));
    expect(await api.outreach.status()).toMatchObject({ model: 'ready', gmail: 'unconfigured' });
    expect(f.denied).toEqual([]);
    expect(osStatusReads).toBe(2);
    expect(transport.nativeCalls).toBe(0);
    // Existing cloud panels may observe status, but unpaired main rejects before any transport.
    const readOnlyCloudChannels = ['outreach:google-connection-status', 'outreach:google-connection-disclosure'];
    expect(f.trace.filter(call => call.error && !readOnlyCloudChannels.includes(call.channel))).toEqual([]);
    for (const call of f.trace.filter(call => readOnlyCloudChannels.includes(call.channel))) expect(call.error).toBeTruthy();
  } finally {
    try {
      try { await act(async () => { cleanup(); await f.drain(); }); } finally { await f.close(); }
      expect(existsSync(f.directory)).toBe(false);
    }
    finally {
      vi.unstubAllGlobals();
      for (const [name, descriptor] of [['showModal', dialogShow], ['close', dialogClose]] as const) {
        if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, name, descriptor);
        else Reflect.deleteProperty(HTMLDialogElement.prototype, name);
      }
      if (previousApi) Object.defineProperty(window, 'callie', previousApi); else Reflect.deleteProperty(window, 'callie');
      if (previousAct) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previousAct); else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
      window.history.replaceState(null, '', previousUrl);
      localStorage.clear(); for (const [key, value] of storage) localStorage.setItem(key, value);
      sessionStorage.clear(); for (const [key, value] of session) sessionStorage.setItem(key, value);
      for (const [name, value] of attrs) { if (value === null) document.documentElement.removeAttribute(name); else document.documentElement.setAttribute(name, value); }
    }
    expect(transport.handlers.size).toBe(0);
    expect([...transport.removed].sort()).toEqual([...transport.registered].sort());
  }
}, 30000);
