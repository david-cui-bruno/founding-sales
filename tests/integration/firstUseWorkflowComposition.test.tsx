// @vitest-environment jsdom
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react/pure';
import { expect, it, vi } from 'vitest';
import { App } from '../../src/renderer/App';
import type { CalliePreloadApi } from '../../src/shared/preload';
import { importCommitReceiptSchema } from '../../src/shared/contracts/importContract';
import { localCompanyCreateResultSchema } from '../../src/shared/contracts/localCompanyIntakeContract';
import { localCompanyResearchStatusSchema } from '../../src/shared/contracts/localWorkspaceContract';
import { emailDraftSchema } from '../../src/shared/contracts/outreachContract';
import { createFirstUseDomainFixture, firstUsePages } from '../fixtures/firstUseDomainFixture';
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

it('takes an empty encrypted workspace through selected research, imported identity, reviewed link and a durable unsent manual draft', async () => {
  // This is jsdom + in-process Electron invoke, not a packaged/native-browser test.
  // HTTP/DNS bytes are synthetic. Startup, health, extractor/attestation, all
  // registrars, importer, account repository, composer and encrypted SQL are real.
  const f = await createFirstUseDomainFixture(transport.handlers);
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
  const api: CalliePreloadApi = { ...f.api, appleSpike: {
    getStatus: forbidden, probeCapabilities: forbidden, requestContacts: forbidden, promptAccessibility: forbidden,
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
  const change = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label, { exact: true }), { target: { value } });
  const calls = (channel: string) => f.trace.filter(call => call.channel === channel);
  try {
    await countsEmpty(['pm_accounts', 'persons', 'person_contact_methods', 'pm_account_links', 'pm_account_sources', 'email_drafts']);
    const health = await api.health.get();
    expect(health).toMatchObject({ domainReady: true, databaseEncrypted: true });
    expect(health.cipherVersion).toBeTruthy();
    expect(readFileSync(health.databasePath).subarray(0, 16).toString()).not.toBe('SQLite format 3\0');
    expect(await api.outreach.status()).toMatchObject({ model: 'unconfigured', gmail: 'unconfigured', accountEmail: null });
    Object.defineProperty(window, 'callie', { configurable: true, value: api });
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true });
    window.history.replaceState(null, '', '#/accounts');
    render(<App />);
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
    expect(f.pages).toEqual(Object.keys(firstUsePages));
    expect(f.resolutions).toEqual(['selected.invalid', 'selected.invalid', 'selected.invalid']);
    const researched = await api.localWorkspace.getCompany({ accountId });
    expect(researched.sources).toHaveLength(3);
    for (const source of researched.sources) {
      expect(source).toMatchObject({ permitted: true, excerpt: firstUsePages[source.url],
        sha256: createHash('sha256').update(firstUsePages[source.url]).digest('hex') });
      expect(Number.isFinite(Date.parse(source.fetchedAt))).toBe(true);
      const evidence = within(screen.getByRole('region', { name: `Source ${source.id}` }));
      expect(evidence.getByText(source.sha256)).toBeTruthy();
      expect(evidence.getByText(source.excerpt)).toBeTruthy();
    }
    expect(researched.snapshot.portfolio).toEqual(expect.arrayContaining([expect.objectContaining({ count: 240 })]));
    expect(researched.snapshot.routes.length).toBeGreaterThan(0);
    expect(researched.snapshot.routes.every(route => route.personId === null && route.verification === 'published')).toBe(true);
    await countsEmpty(['persons', 'person_contact_methods', 'pm_account_links', 'email_drafts']);
    await click('Check status');
    expect(f.pages).toEqual(Object.keys(firstUsePages));

    // The global importer, not a seed or fixture-generated person ID. A nonstandard
    // header requires an actual remap before the explicit admission click.
    await click('Import named person');
    change('Paste spreadsheet rows', 'Name\tPersonal mailbox\tOrganization\nMaya Ortiz\tmaya@selected.invalid\tSelected Management');
    await click('Preview rows');
    change('Personal mailbox', 'email');
    await waitFor(() => expect((screen.getByRole('button', { name: 'Import 1 row' }) as HTMLButtonElement).disabled).toBe(false));
    await countsEmpty(['persons', 'person_contact_methods']);
    await click('Import 1 row');
    await waitFor(() => expect(screen.getByText('Imported 1 row.')).toBeTruthy());
    const receipt = importCommitReceiptSchema.parse(calls('imports:commit')[0]?.result);
    expect(receipt.importedPersonIds).toHaveLength(1);
    expect(await rows('persons')).toHaveLength(1);
    expect(await rows('source_intake_receipts')).toHaveLength(1);
    expect(calls('imports:remap').length).toBeGreaterThan(0);
    const personId = receipt.importedPersonIds[0];
    await click('Done');
    await click('Find saved person');
    await click(`Select Maya Ortiz · ${personId}`);
    const person = await api.leadDetail.get({ personId });
    expect(person.emails).toHaveLength(1);
    expect(person.emails[0].value).toBe('maya@selected.invalid');
    expect(person.emails[0].value).not.toBe('office@selected.invalid');
    const contactMethodId = person.emails[0].id;
    const team = researched.sources.find(source => source.url.endsWith('/team'))!;
    change('Role', 'Property manager');
    change('Relationship', 'Property manager at Selected Management');
    change('Relationship source', team.id);
    const quote = 'Maya Ortiz is the property manager at Selected Management.';
    change('Source quotation', quote);
    fireEvent.click(screen.getByLabelText('I confirm this saved person and quoted relationship'));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Link saved person' }) as HTMLButtonElement).disabled).toBe(false));
    const contactsBeforeLink = await rows('person_contact_methods');
    await click('Link saved person');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open saved contact' })).toBeTruthy());
    const linked = await api.localWorkspace.getCompany({ accountId });
    expect(linked.links).toEqual([expect.objectContaining({ personId, authority: 'unconfirmed', authorityEvidenceIds: [], evidenceIds: [team.id] })]);
    expect(linked.sources).toEqual(researched.sources);
    expect(linked.snapshot.routes).toEqual(researched.snapshot.routes);
    expect(await rows('person_contact_methods')).toEqual(contactsBeforeLink);
    expect(calls('local-workspace:link-company-person')[0].args).toEqual([expect.objectContaining({ accountId,
      expectedVersion: 2, sourceQuotes: [{ sourceId: team.id, quote }], link: expect.objectContaining({ personId }) })]);

    await click('Open saved contact');
    await waitFor(() => expect(screen.getByRole('complementary', { name: 'Maya Ortiz details' })).toBeTruthy());
    await click('Email');
    await waitFor(() => expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).disabled).toBe(false));
    expect(calls('outreach:open-draft')[0].args).toEqual([{ personId, contactMethodId }]);
    change('Subject', 'A local introduction');
    change('Message', 'Maya, I would like to discuss your residential portfolio. This is an unsent local draft.');
    await click('Save draft');
    const saved = emailDraftSchema.parse(calls('outreach:save-draft').at(-1)?.result);
    expect(saved).toMatchObject({ personId, contactMethodId, recipient: 'maya@selected.invalid',
      subject: 'A local introduction', status: 'draft', generation: 'edited' });
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
    expect(await api.outreach.inspectLocalAuthority({ draftId: saved.id, expectedRevision: saved.revision })).toMatchObject({
      personId, contactMethodId, state: 'held', reason: 'email_authority_unavailable' });
    await click('Close draft');
    await click('Close inspector');
    // Unmount the entire application so reopening cannot pass on visible component
    // state alone. Its next open must return the same real persisted draft via IPC.
    await act(async () => { cleanup(); await f.drain(); });
    render(<App />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add company' })).toBeTruthy());
    // Re-select the company through its public UI after owner replacement.
    await click('Local account · Selected Management');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open saved contact' })).toBeTruthy());
    await click('Open saved contact');
    await click('Email');
    await waitFor(() => expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).value).toBe(saved.body));
    expect((screen.getByRole('textbox', { name: 'Subject' }) as HTMLInputElement).value).toBe(saved.subject);
    expect(calls('outreach:open-draft')).toHaveLength(2);
    const reopened = emailDraftSchema.parse(calls('outreach:open-draft').at(-1)?.result);
    expect(reopened).toEqual(saved);
    expect(await rows('email_drafts')).toEqual([expect.objectContaining({ id: saved.id, person_id: personId,
      contact_method_id: contactMethodId, subject: saved.subject, body: saved.body, revision: saved.revision, status: 'draft' })]);
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
    await countsEmpty(['email_send_intents', 'email_send_results', 'delegated_authorities', 'delegated_commands', 'discovery_reservations']);
    const after = await api.leadDetail.get({ personId });
    expect({ stage: after.stage, activities: after.activities, history: after.history, nextAction: after.nextAction })
      .toEqual({ stage: person.stage, activities: person.activities, history: person.history, nextAction: person.nextAction });
    expect(f.pages).toEqual(Object.keys(firstUsePages));
    expect(await api.outreach.status()).toMatchObject({ model: 'unconfigured', gmail: 'unconfigured' });
    expect(screen.getByText('Local account send authority is not established. Saving your draft remains available.')).toBeTruthy();
    expect(f.denied).toEqual([]);
    expect(transport.nativeCalls).toBe(0);
    expect(f.trace.filter(call => call.error)).toEqual([]);
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
