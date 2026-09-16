// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { LocalCompanyDraft } from '../../src/renderer/features/today/LocalCompanyDraft';
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
import { createCallieApi } from '../../src/preload/createCallieApi';
import { companyDraftFacts } from '../../src/main/outreach/companyDraftContext';
import { EMAIL_PLAYBOOK } from '../../src/main/outreach/emailPlaybook';
import type { AccountClaim } from '../../src/shared/contracts/accountContract';
import { registeredIpcHandler } from '../fixtures/registeredIpcHandler';
import { createTempDatabase, createTestWorkspaceKey } from '../fixtures/tempDatabase';

import { createCompanyDraftPreparationService } from '../../src/main/outreach/companyDraftPreparationService';

import type { GeneratedDraft, OutreachProviders } from '../../src/main/outreach/providers/providerTypes';

import { generateOpenAiDraft } from '../../src/main/outreach/providers/openAiDraftProvider';

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
function allDatabaseState(database: AppDatabase) {
  const tables = database.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
  return {
    changes: database.raw.prepare('SELECT total_changes() AS n').get(),
    rows: tables.map(({ name }) => ({ name, rows: database.raw.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all() })),
  };
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });


// First Node24 run, before importing the new service: genuine eligible fixture
// reached direct prepareCompanyDraft and failed with missing-method TypeError.
// All remaining orchestration is real. Only external generate is replaced.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function generated(context: Parameters<OutreachProviders['generate']>[0]): GeneratedDraft {
  return { subject: 'Maintenance coordination', body: 'Hello company team,\n\nWould a conversation about maintenance coordination be useful?',
    evidenceIds: [context.facts[0]!.id], provider: 'openai', model: 'fixture-model', responseId: 'fixture-response' };
}
type Extra = { claims?: AccountClaim[]; status?: OutreachProviders['status'] };
async function fixture(generate = vi.fn<OutreachProviders['generate']>(async context => generated(context)), hasFacts = true, extra: Extra = {}) {
  const temp = createTempDatabase(), key = createTestWorkspaceKey();
  const forbidden = vi.fn((): never => { throw new Error('Company draft must not invoke provider/mail/phone/worker effects'); });
  vi.stubGlobal('fetch', forbidden);
  const effects = [vi.spyOn(emailService, 'createEmailService').mockImplementation(forbidden),
    vi.spyOn(phoneLauncher, 'createPhoneHandoffLauncher').mockImplementation(forbidden),
    vi.spyOn(ExecutionClient.prototype, 'submit').mockImplementation(forbidden),
    vi.spyOn(ExecutionClient.prototype, 'sync').mockImplementation(forbidden)];
  const clock = { now: () => new Date().toISOString() };
  const runtimes: FoundationRuntime[] = [], removers: (() => void)[] = [];
  const preparations: ReturnType<typeof createCompanyDraftPreparationService>[] = [];
  function session(databaseExists: boolean) {
    electron.handle.mockClear();
    const runtime = new FoundationRuntime({ appVersion: '1.0.0', databasePath: temp.path, databaseExists,
      backupDirectory: join(dirname(temp.path), 'backups'), keyEnvelopePath: join(dirname(temp.path), 'fixture-envelope.json') }, {
      loadWorkspaceKey: async () => ({ ...key, bytes: Buffer.from(key.bytes) }), prepareEncryptedDatabase,
      openDatabase, migrateToLatest,
      createDomainRuntime: database => new DomainRuntime({ database, clock, ids: { next: randomUUID } }),
      createHealthService: options => new HealthService(options), closeDatabase,
    });
    runtimes.push(runtime);
    const preparation = createCompanyDraftPreparationService({ runtime, providers: { generate, ...(extra.status ? { status: extra.status } : {}) }, clock });
    preparations.push(preparation);
    const remove = registerLocalWorkspaceIpc(createLocalWorkspaceProvider(runtime, { current: forbidden }, undefined, preparation)); removers.push(remove);
    const invoke = vi.fn(async (channel: string, ...args: unknown[]) => registeredIpcHandler(electron.handle, channel)(trusted, ...args));
    return { runtime, remove, invoke, preparation, api: createCallieApi({ invoke }).localWorkspace };
  }
  const first = session(false);
  const cleanup = async () => {
    removers.reverse().forEach(remove => remove());
    preparations.forEach(preparation => preparation.dispose());
    await Promise.all(runtimes.map(runtime => runtime.shutdown()));
    key.bytes.fill(0); temp.cleanup();
  };
  try {
    const created = await first.api.createCompany({ commandId: randomUUID(), name: 'Fictional Draft PM', domain: 'draft-pm.example' });
    expect(created.status).toBe('saved'); if (created.status !== 'saved') throw new Error('Expected real saved company');
    const accountId = created.account.id;
    // Trusted fixture admission of saved source/facts, never renderer-authored research or a real website fetch.
    await first.runtime.withDatabase(database => new AccountRepository({ database, clock, ids: { next: randomUUID },
      sourcePolicy: { attest: (candidate, owner) => owner === accountId && candidate.id === source.id && candidate.url === source.url && candidate.sha256 === source.sha256 && candidate.excerpt === source.excerpt } }).admitEvidence({
      commandId: randomUUID(), accountId, expectedVersion: created.account.version, sources: [source], routes: [], claims: hasFacts ? [
        { key: 'residential_scope', kind: 'fact', value: 'Residential homes', evidenceIds: [source.id] },
        { key: 'operating_footprint', kind: 'fact', value: 'Rhode Island', evidenceIds: [source.id] },
        { key: 'maintenance_workflow', kind: 'fact', value: 'Coordinates maintenance', evidenceIds: [source.id] },
        { key: 'technology', kind: 'fact', value: 'Resident portal', evidenceIds: [source.id] },
        ...(extra.claims ?? []),
      ] : [],
    }));
    const before = await first.api.getCompany({ accountId });
    expect(before.snapshot.claims).toHaveLength(hasFacts ? 4 + (extra.claims?.length ?? 0) : 0); expect(before.sources).toEqual([source]); expect(before.snapshot.routes).toEqual([]);
    const originalRows = await first.runtime.withDatabase(auditRows);
    expect(originalRows.every(entry => entry.rows.length === 0)).toBe(true);
    expect(await first.runtime.withDatabase(inspectDatabaseEncryption)).toMatchObject({ encrypted: true, integrity: 'ok' });

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
    if (!extra.claims?.length) expect(companyDraftFacts(admitted)).toHaveLength(hasFacts ? 4 : 0);
    const request = { accountId, draftId: opened.draft.id, expectedRevision: opened.draft.revision };
    const state = () => first.runtime.withDatabase(allDatabaseState);
    const read = () => first.api.getCompanyDraft({ accountId, draftId: opened.draft.id });
    const repo = (database: AppDatabase) => new AccountRepository({ database, clock, ids: { next: randomUUID },
      sourcePolicy: { attest: candidate => candidate.sha256 === createHash('sha256').update(candidate.excerpt).digest('hex') } });
    const change = async (kind: 'source' | 'recipient' | 'draft') => {
      if (kind === 'draft') {
        await first.api.saveCompanyDraft({ ...request, commandId: randomUUID(), subject: 'Winning concurrent edit', body: 'Do not overwrite café\n  ' });
        return;
      }
      const current = await first.api.getCompany({ accountId });
      await first.runtime.withDatabase(database => {
        const text = 'Company email: updated@draft-pm.example';
        const nextSource = { ...source, id: randomUUID(), excerpt: text, sha256: createHash('sha256').update(text).digest('hex') };
        repo(database).admitEvidence({ commandId: randomUUID(), accountId, expectedVersion: current.snapshot.account.version,
          sources: [nextSource], claims: [], routes: kind === 'recipient' ? [{ id: route.id, accountId, personId: null,
            channel: 'email', value: 'updated@draft-pm.example', purpose: 'business', verification: 'published', evidenceIds: [nextSource.id] }] : [] });
      });
    };
    return { first, session, cleanup, generate, request, accountId, opened, admitted, state, read, change,
      assertNoEffects() { expect(forbidden).not.toHaveBeenCalled(); for (const effect of effects) expect(effect).not.toHaveBeenCalled(); } };
  } catch (error) { await cleanup(); throw error; }
}

it('prepares a bound company-only proposal without writes, then explicit Save/reopen preserves exact edited text', async () => {
  const f = await fixture();
  try {
    const before = await f.state();
    const proposal = await f.first.api.prepareCompanyDraft(f.request);
    expect(proposal).toMatchObject({ accountId: f.accountId, draftId: f.opened.draft.id, baseRevision: 1,
      accountVersion: f.admitted.snapshot.account.version, recipientBinding: f.opened.draft.recipientBinding,
      subject: 'Maintenance coordination', body: expect.stringContaining('Hello company team') });
    expect(proposal.grounding.facts).toEqual(companyDraftFacts(f.admitted));
    expect(proposal.grounding.usedFactIds).toEqual([proposal.grounding.facts[0]!.id]);
    expect(proposal.grounding.playbookVersion).toEqual(expect.any(String));
    expect(proposal.grounding.playbookVersion.length).toBeGreaterThan(0);
    expect(f.generate).toHaveBeenCalledTimes(1);
    const [context] = f.generate.mock.calls[0]!;
    expect(context).toMatchObject({ recipientKind: 'company_business_inbox', companyName: 'Fictional Draft PM',
      purpose: 'prepare_first_conversation', facts: companyDraftFacts(f.admitted) });
    for (const field of ['personId', 'personName', 'stage', 'segment']) expect(context).not.toHaveProperty(field);
    expect(await f.state()).toEqual(before);
    expect(await f.read()).toEqual(f.opened);
    const subject = `${proposal.subject} [owner edited]`;
    const body = `${proposal.body}\nOwner edit: café • <untrusted text>\nTrailing spaces stay.  \n`;
    await f.first.api.saveCompanyDraft({ ...f.request, commandId: randomUUID(), subject, body });
    const saved = await f.read();
    expect(saved?.draft).toEqual({ ...f.opened.draft, revision: 2, subject, body, updatedAt: expect.any(String) });
    f.first.remove(); f.first.preparation.dispose(); await f.first.runtime.shutdown();
    const second = f.session(true);
    expect((await second.api.getCompanyDraft({ accountId: f.accountId, routeId: f.opened.draft.recipientBinding.routeId }))?.draft).toEqual(saved?.draft);
    expect(await second.runtime.withDatabase(inspectDatabaseEncryption)).toMatchObject({ encrypted: true, integrity: 'ok' });
    expect(f.generate).toHaveBeenCalledTimes(1);
    expect((await second.runtime.withDatabase(auditRows)).every(entry => entry.rows.length === 0)).toBe(true);
    f.assertNoEffects(); second.preparation.dispose();
  } finally { await f.cleanup(); }
}, 30_000);

it.each(['source', 'recipient', 'draft'] as const)('fails closed when %s changes during model await without overwriting the winner', async kind => {
  const entered = deferred<void>(), output = deferred<GeneratedDraft>();
  let result!: GeneratedDraft;
  const generate = vi.fn<OutreachProviders['generate']>(async context => { result = generated(context); entered.resolve(); return output.promise; });
  const f = await fixture(generate);
  try {
    const pending = f.first.api.prepareCompanyDraft(f.request);
    const rejected = expect(pending).rejects.toThrow();
    await entered.promise;
    await f.change(kind);
    const afterMutation = await f.state(), winningDraft = await f.read();
    output.resolve(result); await rejected;
    expect(await f.state()).toEqual(afterMutation); expect(await f.read()).toEqual(winningDraft);
    expect(f.generate).toHaveBeenCalledTimes(1); f.assertNoEffects();
  } finally { output.resolve(result); f.first.preparation.dispose(); await f.cleanup(); }
}, 30_000);

it.each(['unknown-evidence', 'duplicate-evidence', 'empty-evidence', 'blank-subject', 'blank-body'] as const)(
  'rejects %s model output without saving or changing the original', async kind => {
    const generate = vi.fn<OutreachProviders['generate']>(async context => {
      const result = generated(context);
      if (kind === 'unknown-evidence') result.evidenceIds = ['invented-unsupported-fact'];
      if (kind === 'duplicate-evidence') result.evidenceIds.push(result.evidenceIds[0]!);
      if (kind === 'empty-evidence') result.evidenceIds = [];
      if (kind === 'blank-subject') result.subject = '   ';
      if (kind === 'blank-body') result.body = '   ';
      return result;
    });
    const f = await fixture(generate);
    try {
      const before = await f.state();
      await expect(f.first.api.prepareCompanyDraft(f.request)).rejects.toThrow();
      expect(await f.state()).toEqual(before); expect(await f.read()).toEqual(f.opened);
      expect(generate).toHaveBeenCalledTimes(1); f.assertNoEffects();
    } finally { f.first.preparation.dispose(); await f.cleanup(); }
  }, 30_000);

it('coalesces or rejects concurrent duplicates without a second provider call or any writes', async () => {
  const entered = deferred<void>(), output = deferred<GeneratedDraft>();
  let result!: GeneratedDraft;
  const generate = vi.fn<OutreachProviders['generate']>(async context => { result = generated(context); entered.resolve(); return output.promise; });
  const f = await fixture(generate);
  try {
    const before = await f.state();
    const first = f.first.api.prepareCompanyDraft(f.request); await entered.promise;
    const second = f.first.api.prepareCompanyDraft(f.request);
    const settled = Promise.allSettled([first, second]);
    output.resolve(result);
    const outcomes = await settled;
    expect(outcomes[0]!.status).toBe('fulfilled');
    if (outcomes[0]!.status === 'fulfilled' && outcomes[1]!.status === 'fulfilled') expect(outcomes[1]!.value).toEqual(outcomes[0]!.value);
    expect(generate).toHaveBeenCalledTimes(1); expect(await f.state()).toEqual(before);
    expect(await f.read()).toEqual(f.opened); f.assertNoEffects();
  } finally { output.resolve(result); f.first.preparation.dispose(); await f.cleanup(); }
}, 30_000);

it('preserves original draft after provider failure and never automatically retries', async () => {
  const generate = vi.fn<OutreachProviders['generate']>(async () => { throw new Error('uncertain external model result'); });
  const f = await fixture(generate);
  try {
    const before = await f.state();
    await expect(f.first.api.prepareCompanyDraft(f.request)).rejects.toThrow();
    expect(await f.state()).toEqual(before); expect(await f.read()).toEqual(f.opened);
    expect(generate).toHaveBeenCalledTimes(1); f.assertNoEffects();
  } finally { f.first.preparation.dispose(); await f.cleanup(); }
}, 30_000);

it('refuses regeneration of saved nonempty text without calling the model or changing original', async () => {
  const f = await fixture();
  try {
    await f.change('draft'); const original = await f.read(), before = await f.state();
    await expect(f.first.api.prepareCompanyDraft({ ...f.request, expectedRevision: original!.draft.revision })).rejects.toThrow();
    expect(f.generate).not.toHaveBeenCalled(); expect(await f.state()).toEqual(before); expect(await f.read()).toEqual(original); f.assertNoEffects();
  } finally { f.first.preparation.dispose(); await f.cleanup(); }
}, 30_000);

it.each([true, false])('discards a delayed provider result after lifecycle invalidation (locked=%s)', async locked => {
  const entered = deferred<void>(), output = deferred<GeneratedDraft>();
  let result!: GeneratedDraft;
  const generate = vi.fn<OutreachProviders['generate']>(async context => { result = generated(context); entered.resolve(); return output.promise; });
  const f = await fixture(generate);
  try {
    const before = await f.state(); const pending = f.first.api.prepareCompanyDraft(f.request);
    const rejected = expect(pending).rejects.toThrow(); await entered.promise;
    f.first.preparation.invalidate(locked); output.resolve(result); await rejected;
    expect(await f.state()).toEqual(before); expect(await f.read()).toEqual(f.opened);
    expect(generate).toHaveBeenCalledTimes(1); f.assertNoEffects();
  } finally { output.resolve(result); f.first.preparation.dispose(); await f.cleanup(); }
}, 30_000);

it.each(['success', 'unknown-evidence', 'incomplete'] as const)(
  'uses the real HTTP generator through IPC with only fake external HTTP: %s', async outcome => {
    const http = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe('https://api.openai.com/v1/responses');
      expect(init?.redirect).toBe('error');
      const envelope = JSON.parse(String(init?.body));
      expect(envelope.store).toBe(false);
      expect(envelope).not.toHaveProperty('tools');
      expect(envelope.text.format).toMatchObject({ type: 'json_schema', strict: true });
      const context = JSON.parse(envelope.input);
      expect(context).toMatchObject({ recipientKind: 'company_business_inbox', companyName: 'Fictional Draft PM' });
      for (const field of ['personName', 'personId', 'stage', 'segment', 'senderName']) expect(context).not.toHaveProperty(field);
      expect(context.facts).toHaveLength(4);
      expect(envelope.input).not.toContain('fixture-secret');
      expect(envelope.input).not.toContain(email);
      expect(envelope.input).not.toContain(excerpt);
      return Response.json({ id: 'resp_fixture', status: outcome === 'incomplete' ? 'incomplete' : 'completed', model: 'fixture-model',
        output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify({
          subject: 'Company maintenance conversation', body: 'Hello company team,\n\nWould a conversation be useful?',
          evidenceIds: outcome === 'unknown-evidence' ? ['invented'] : [context.facts[0].id],
        }) }] }] });
    });
    const generate = vi.fn<OutreachProviders['generate']>((context, signal) => generateOpenAiDraft({ context, signal,
      credentials: { apiKey: 'fixture-secret', model: 'fixture-model' }, fetch: http }));
    const f = await fixture(generate);
    try {
      const before = await f.state();
      if (outcome === 'success') {
        const proposal = await f.first.api.prepareCompanyDraft(f.request);
        expect(proposal).toMatchObject({ accountId: f.accountId, draftId: f.request.draftId, baseRevision: 1,
          recipientBinding: f.opened.draft.recipientBinding, subject: 'Company maintenance conversation' });
        expect(proposal.grounding.facts).toEqual(companyDraftFacts(f.admitted));
        expect(proposal.grounding.usedFactIds).toEqual([proposal.grounding.facts[0]!.id]);
      } else await expect(f.first.api.prepareCompanyDraft(f.request)).rejects.toThrow();
      expect(http).toHaveBeenCalledTimes(1); expect(generate).toHaveBeenCalledTimes(1);
      expect(await f.state()).toEqual(before); expect(await f.read()).toEqual(f.opened); f.assertNoEffects();
    } finally { await f.cleanup(); }
  }, 30_000);

it('renders real company facts, prepares through real IPC/HTTP generation, then edits, Saves and reopens exact encrypted text', async () => {
  const http = vi.fn<typeof fetch>(async (url, init) => {
    expect(String(url)).toBe('https://api.openai.com/v1/responses');
    const envelope = JSON.parse(String(init?.body)), context = JSON.parse(envelope.input);
    expect(envelope.store).toBe(false); expect(envelope).not.toHaveProperty('tools');
    expect(context).toMatchObject({ recipientKind: 'company_business_inbox', companyName: 'Fictional Draft PM' });
    expect(context).not.toHaveProperty('personName'); expect(context.facts).toHaveLength(4);
    return Response.json({ id: 'resp_ui_fixture', status: 'completed', model: 'fixture-model',
      output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify({
        subject: 'A company maintenance conversation', body: 'Hello company team,\n\nWould a conversation about maintenance be useful?',
        evidenceIds: [context.facts[0].id],
      }) }] }] });
  });
  // The function forwards directly into the production HTTP generator. No API,
  // service, repository, session, component or positive IPC response is mocked.
  const generate = vi.fn<OutreachProviders['generate']>((context, signal) => generateOpenAiDraft({ context, signal,
    credentials: { apiKey: 'fixture-secret', model: 'fixture-model' }, fetch: http }));
  const f = await fixture(generate);
  try {
    const view = render(createElement(LocalCompanyDraft, { api: f.first.api, detail: f.admitted }));
    fireEvent.click(await screen.findByRole('button', { name: /^(Open|Reopen) company draft$/ }));
    await screen.findByRole('textbox', { name: 'Subject' });
    const prepare = screen.getByRole('button', { name: 'Prepare company draft' });
    await waitFor(() => expect(prepare).toHaveProperty('disabled', false));
    expect(http).not.toHaveBeenCalled();
    const beforePrepare = await f.state();
    fireEvent.click(prepare);
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Subject' })).toHaveProperty('value', 'A company maintenance conversation'));
    const inputs = screen.getByRole('region', { name: 'Preparation inputs' });
    expect(within(inputs).getAllByRole('listitem')).toHaveLength(4);
    for (const text of ['residential scope: Residential homes', 'operating footprint: Rhode Island',
      'maintenance workflow: Coordinates maintenance', 'technology: Resident portal']) expect(within(inputs).getByText(text)).toBeTruthy();
    expect(within(inputs).getAllByText('Saved evidence and attribution')).toHaveLength(4);
    expect(inputs.textContent).toContain(source.url); expect(inputs.textContent).toContain(source.sha256);
    expect(screen.getByText('Unsaved local text')).toBeTruthy();
    expect(screen.getByText('Company inbox, no named person verified.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^(Send|Approve|Research)$/i })).toBeNull();
    expect(await f.state()).toEqual(beforePrepare); expect(await f.read()).toEqual(f.opened);
    const subject = 'Owner edited café subject';
    const body = 'Hello company team,\n\nOwner review changed this text.\nUnicode café • <literal text>\nTrailing spaces stay.  \n';
    fireEvent.change(screen.getByRole('textbox', { name: 'Subject' }), { target: { value: subject } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: body } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved locally · revision 2');
    expect((await f.read())?.draft).toMatchObject({ subject, body, revision: 2, status: 'unsent' });
    expect(f.first.invoke.mock.calls.some(([channel]) => channel === 'local-workspace:prepare-company-draft')).toBe(true);
    expect(f.first.invoke.mock.calls.some(([channel]) => channel === 'local-workspace:save-company-draft')).toBe(true);
    view.unmount(); f.first.remove(); f.first.preparation.dispose(); await f.first.runtime.shutdown();
    const fresh = f.session(true);
    const detail = await fresh.api.getCompany({ accountId: f.accountId });
    const reopened = render(createElement(LocalCompanyDraft, { api: fresh.api, detail }));
    fireEvent.click(await screen.findByRole('button', { name: /^(Open|Reopen) company draft$/ }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toHaveProperty('value', body));
    expect(screen.getByRole('textbox', { name: 'Subject' })).toHaveProperty('value', subject);
    expect(screen.getByText('Saved locally · revision 2')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Prepare company draft' })).toBeNull();
    expect(http).toHaveBeenCalledTimes(1); expect(generate).toHaveBeenCalledTimes(1);
    expect(await fresh.runtime.withDatabase(inspectDatabaseEncryption)).toMatchObject({ encrypted: true, integrity: 'ok' });
    expect((await fresh.runtime.withDatabase(auditRows)).every(entry => entry.rows.length === 0)).toBe(true);
    f.assertNoEffects(); reopened.unmount();
  } finally { cleanup(); await f.cleanup(); }
}, 30_000);

const setup = (senderName: string): Awaited<ReturnType<OutreachProviders['status']>> => ({ model: 'ready', modelName: 'fixture-model',
  gmail: 'unconfigured', accountEmail: null, senderName, postalAddress: '' });
const paragraph = 'Fictional Draft PM has managed, leased and serviced residential homes across Rhode Island since 2004.';
// David's walkthrough D: three of four saved facts repeated one company-history paragraph, shown under two headings.
const repeatedParagraph: AccountClaim[] = [
  { key: 'ownership', kind: 'fact', value: paragraph, evidenceIds: [source.id] },
  { key: 'portfolio_description', kind: 'fact', value: paragraph, evidenceIds: [source.id] },
];

it('sends a repeated saved paragraph once, the saved sender name as data and the tighter first-draft rules, with grounding and fencing unchanged', async () => {
  const status = vi.fn<OutreachProviders['status']>(async () => setup('Fixture Founder'));
  const f = await fixture(undefined, true, { claims: repeatedParagraph, status });
  try {
    const before = await f.state();
    const proposal = await f.first.api.prepareCompanyDraft(f.request);
    expect(f.generate).toHaveBeenCalledTimes(1);
    const [context] = f.generate.mock.calls[0]!;
    if (!('recipientKind' in context)) throw new Error('Company context expected');
    // Six saved claims carry one paragraph twice: the model reads it once, under the first company heading.
    expect(context.facts).toHaveLength(5);
    const repeated = context.facts.filter(fact => fact.text.includes(paragraph));
    expect(repeated).toHaveLength(1);
    expect(repeated[0]!.text).toContain('"key":"portfolio_description"');
    expect(context.facts.map(fact => fact.text).join('\n')).not.toContain('"key":"ownership"');
    expect(context.facts).toEqual(companyDraftFacts(f.admitted));
    expect(proposal.grounding.facts).toEqual(context.facts);
    expect(proposal.grounding.usedFactIds).toEqual([context.facts[0]!.id]);
    expect(proposal.grounding.playbookVersion).toBe('2026-09-08');
    // The founder's saved sender name is read-only setup data: not evidence, not permission, never invented.
    expect(status).toHaveBeenCalledTimes(1);
    expect(context.senderName).toBe('Fixture Founder');
    expect(Object.keys(context).sort()).toEqual(['companyName', 'facts', 'playbook', 'purpose', 'recipientKind', 'senderName']);
    // The playbook carries the tighter first-draft rules without new product claims.
    expect(context.playbook).toBe(EMAIL_PLAYBOOK);
    expect(context.playbook).toMatch(/subject[^.]*at most 60 characters/i);
    expect(context.playbook).toMatch(/exactly one concrete sentence[^.]*Callie[^.]*maintenance handoff[^.]*approved product facts/i);
    expect(context.playbook).toContain('Looking forward to your insights');
    expect(context.playbook).toMatch(/senderName[^.]*founder's saved sender name/);
    expect(context.playbook).toMatch(/no senderName[^.]*no name/i);
    expect(context.playbook).toContain('Never invent, guess or default a name');
    expect(context.playbook).toContain('signature block, postal address or opt-out footer');
    expect(await f.state()).toEqual(before); expect(await f.read()).toEqual(f.opened); f.assertNoEffects();
  } finally { await f.cleanup(); }
}, 30_000);

it.each([
  ['setup has no sender name', async () => setup('')],
  ['setup has a blank sender name', async () => setup('   ')],
  ['setup is locked', async () => ({ ...setup(''), model: 'locked' as const, gmail: 'locked' as const })],
  ['this port cannot read setup', undefined],
])('sends no sender name when %s, never inventing one', async (_name, status) => {
  const f = await fixture(undefined, true, { status });
  try {
    const before = await f.state();
    await f.first.api.prepareCompanyDraft(f.request);
    const [context] = f.generate.mock.calls[0]!;
    expect(Object.keys(context).sort()).toEqual(['companyName', 'facts', 'playbook', 'purpose', 'recipientKind']);
    expect(context.playbook).toBe(EMAIL_PLAYBOOK);
    expect(await f.state()).toEqual(before); expect(await f.read()).toEqual(f.opened); f.assertNoEffects();
  } finally { await f.cleanup(); }
}, 30_000);

it('passes the saved sender name through the real HTTP generator as data only, never inside the instructions', async () => {
  const http = vi.fn<typeof fetch>(async (_url, init) => {
    const envelope = JSON.parse(String(init?.body)), context = JSON.parse(envelope.input);
    expect(context).toMatchObject({ recipientKind: 'company_business_inbox', companyName: 'Fictional Draft PM', senderName: 'Fixture Founder' });
    expect(envelope.instructions).not.toContain('Fixture Founder');
    expect(context.facts).toHaveLength(4);
    return Response.json({ id: 'resp_named_fixture', status: 'completed', model: 'fixture-model',
      output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify({
        subject: 'Maintenance handoff at Fictional Draft PM',
        body: 'Hello Fictional Draft PM team,\n\nHow does your team hand off maintenance requests to contractors today?\n\nBest,\nFixture Founder',
        evidenceIds: [context.facts[0].id],
      }) }] }] });
  });
  const generate = vi.fn<OutreachProviders['generate']>((context, signal) => generateOpenAiDraft({ context, signal,
    credentials: { apiKey: 'fixture-secret', model: 'fixture-model' }, fetch: http }));
  const f = await fixture(generate, true, { status: async () => setup('Fixture Founder') });
  try {
    const before = await f.state();
    const proposal = await f.first.api.prepareCompanyDraft(f.request);
    expect(proposal.subject.length).toBeLessThanOrEqual(60);
    expect(proposal.body.endsWith('Best,\nFixture Founder')).toBe(true);
    expect(proposal.grounding.usedFactIds).toEqual([proposal.grounding.facts[0]!.id]);
    expect(http).toHaveBeenCalledTimes(1); expect(generate).toHaveBeenCalledTimes(1);
    expect(await f.state()).toEqual(before); expect(await f.read()).toEqual(f.opened); f.assertNoEffects();
  } finally { await f.cleanup(); }
}, 30_000);

it('rejects an eligible reviewed inbox with no supported company facts before invoking the provider', async () => {
  const f = await fixture(undefined, false);
  try {
    expect(f.opened).toMatchObject({ editable: true, stale: false });
    expect(companyDraftFacts(f.admitted)).toEqual([]);
    const before = await f.state();
    await expect(f.first.api.prepareCompanyDraft(f.request)).rejects.toThrow();
    expect(f.generate).not.toHaveBeenCalled(); expect(await f.state()).toEqual(before);
    expect(await f.read()).toEqual(f.opened); f.assertNoEffects();
  } finally { await f.cleanup(); }
}, 30_000);

it('rejects a suppressed company before invoking the provider and preserves its original draft', async () => {
  const f = await fixture();
  try {
    await f.first.runtime.withDatabase(database => database.raw.prepare(`INSERT INTO pm_account_suppression_tombstones
      (id,account_id,observed_at,source,evidence_ref,admitted_at) VALUES(?,?,?,?,?,?)`)
      .run(randomUUID(), f.accountId, source.fetchedAt, 'negative-storage-fixture', 'Company suppression fixture', source.fetchedAt));
    const original = await f.read();
    expect(original).toMatchObject({ editable: false, reason: 'suppressed', draft: f.opened.draft });
    const before = await f.state();
    await expect(f.first.api.prepareCompanyDraft(f.request)).rejects.toThrow();
    expect(f.generate).not.toHaveBeenCalled(); expect(await f.state()).toEqual(before);
    expect(await f.read()).toEqual(original); f.assertNoEffects();
  } finally { await f.cleanup(); }
}, 30_000);
