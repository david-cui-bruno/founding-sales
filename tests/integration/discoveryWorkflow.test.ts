// @vitest-environment jsdom
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { openDatabase, closeDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { DomainRuntime } from '../../src/main/domain/domainRuntime';
import type { SourcingPollHealth } from '../../src/shared/contracts/sourcingContract';
import type { FoundationRuntime } from '../../src/main/foundation/foundationRuntime';
import { HealthService } from '../../src/main/health/healthService';
import { startApplication, type ApplicationStartupDependencies } from '../../src/main/startApplication';
import { registerApplicationIpc } from '../../src/main/ipc/registerApplicationIpc';
import { createOutboundCommandService } from '../../src/main/communications/outboundCommandService';
import { createEmailService } from '../../src/main/outreach/emailService';
import { generateOpenAiDraft } from '../../src/main/outreach/providers/openAiDraftProvider';
import type { GroundedDraftContext } from '../../src/main/outreach/providers/providerTypes';
import { createDiscoveryWorker, type DiscoveryWorker } from '../../src/main/discovery/discoveryWorker';
import { unavailableDiscoveryResearch, type DiscoveryResearchPort } from '../../src/main/discovery/discoveryResearchPort';
import type { DiscoveryEvidenceSnapshot } from '../../src/main/domain/discovery/discoveryTypes';
import type { SourcingPoller } from '../../src/main/sourcing/sourcingPoller';
import { EnrichmentRequestWriter } from '../../src/main/sourcing/enrichmentRequestWriter';
import type { UpstreamObjectStore } from '../../src/main/sourcing/upstreamSync';
import { mapCloudSourceEvent, buildNeedsIdentityIntakeCommand } from '../../src/main/sourcing/intakeMapper';
import { cloudSourceEventSchema, type CloudSourceEvent } from '../../src/shared/contracts/cloudSourceEventContract';
import type { BeginDiscoveryRequest, DiscoveryBrief, DiscoveryClaim } from '../../src/shared/contracts/discoveryContract';
import type { CalliePreloadApi } from '../../src/shared/preload';
import { FounderApp } from '../../src/renderer/app/FounderApp';
import { createTempDatabase, createTestWorkspaceKey, type TempDatabase } from '../fixtures/tempDatabase';
import { validParcelEvent, validFrboEvent, validEnrichmentEvent } from '../fixtures/cloudSourceEvents';
import type { RegisteredIpcHandler } from '../fixtures/registeredIpcHandler';

const boundary = vi.hoisted(() => ({ handlers: new Map<string, RegisteredIpcHandler>(), expose: vi.fn(), invoke: vi.fn(), frozen: null as unknown, admission: null as unknown }));
vi.mock('electron', () => ({ safeStorage: {}, dialog: {}, contextBridge: { exposeInMainWorld: boundary.expose },
  ipcRenderer: { invoke: boundary.invoke }, ipcMain: {
    handle: (name: string, handler: RegisteredIpcHandler) => {
      if (boundary.handlers.has(name)) throw new Error(`Duplicate channel ${name}`);
      boundary.handlers.set(name, handler);
    }, removeHandler: (name: string) => { boundary.handlers.delete(name); },
  } }));
// Test-owned mutation control. Ordinary runs delegate every collection unchanged.
vi.mock('../../src/main/domain/discovery/discoveryEvidence', async original => {
  const real = await original<typeof import('../../src/main/domain/discovery/discoveryEvidence')>();
  return { ...real, collectDiscoveryEvidence: (input: Parameters<typeof real.collectDiscoveryEvidence>[0]) => {
    const frozen = boundary.frozen as DiscoveryEvidenceSnapshot | null;
    const admitted = boundary.admission as Parameters<typeof real.revalidateDiscoverySnapshot> | null;
    return frozen?.prospectId === input.prospectId && admitted?.[0] === frozen && admitted[1] === input.database
      ? frozen : real.collectDiscoveryEvidence(input);
  }, revalidateDiscoverySnapshot: (...args: Parameters<typeof real.revalidateDiscoverySnapshot>) => {
    const [snapshot, database, services] = args;
    const admitted = boundary.admission as Parameters<typeof real.revalidateDiscoverySnapshot> | null;
    const keys = ['identities', 'sourceRepository', 'events', 'outboundPermission',
      'prioritizationRepository', 'prioritization', 'workspaceSettings'] as const;
    // Deliberately faulty provider only. Admission was independently verified before revision.
    if (snapshot === boundary.frozen && admitted?.[0] === snapshot && admitted[1] === database
      && keys.every(key => admitted[2][key] === services[key])) return;
    real.revalidateDiscoverySnapshot(...args);
  } };
});
const oracle = await vi.importActual<typeof import('../../src/main/domain/discovery/discoveryEvidence')>('../../src/main/domain/discovery/discoveryEvidence');
const NOW = '2026-09-06T12:00:00.000Z';
const unexpected = (): never => { throw new Error('External operation forbidden in assembled source fixture'); };
const temps: TempDatabase[] = [];
const stops: (() => Promise<void>)[] = [];
beforeEach(() => { vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(800); vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1200); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); boundary.frozen = null; boundary.admission = null; window.location.hash = ''; });
afterEach(async () => {
  cleanup(); for (const stop of stops.splice(0).reverse()) await stop();
  expect(boundary.handlers.size).toBe(0); boundary.frozen = null; boundary.admission = null;
  vi.restoreAllMocks(); vi.useRealTimers(); for (const temp of temps.splice(0)) temp.cleanup();
});
const held = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };

// One actual startup owner. No parallel domain graph, mock shortlist or provider success.
async function fixture(input: { temp?: TempDatabase; research?: DiscoveryResearchPort; enrichmentStore?: UpstreamObjectStore; draftFetch?: typeof globalThis.fetch } = {}) {
  const temp = input.temp ?? createTempDatabase(); if (!input.temp) temps.push(temp);
  let runtime!: FoundationRuntime; let domain!: DomainRuntime; let worker!: DiscoveryWorker; let database!: AppDatabase;
  const clock = { now: () => new Date().toISOString() };
  const scheduled = new Set<{ run(): void; at: number }>();
  const late: (() => void)[] = [];
  const phoneDispatch = vi.fn(unexpected); const enrichmentUpload = vi.fn(unexpected); const outreachExternal = vi.fn(unexpected);
  const dependencies: ApplicationStartupDependencies = {
    loadWorkspaceKey: async () => createTestWorkspaceKey(), prepareEncryptedDatabase: async () => undefined,
    openDatabase: options => { database = openDatabase(options); return database; }, closeDatabase, migrateToLatest,
    createDomainRuntime: db => { domain = new DomainRuntime({ database: db, clock, ids: { next: randomUUID } }); return domain; },
    createHealthService: options => new HealthService(options),
    createEnrichmentRequester: runtime => input.enrichmentStore
      ? new EnrichmentRequestWriter({ domainGate: runtime, clock, createStore: async () => input.enrichmentStore! })
      : { request: enrichmentUpload },
    createOutboundCommandService: options => createOutboundCommandService({ ...options,
      phone: { inspectCapability: async () => ({ state: 'unavailable', reasonCode: 'phone_route_unverified' }), dispatch: phoneDispatch } }),
    createEmailService: runtime => createEmailService({ databaseGate: runtime, now: clock.now, providers: {
      status: async () => ({ model: input.draftFetch ? 'ready' : 'unconfigured', modelName: input.draftFetch ? 'fixture-model' : '', gmail: 'unconfigured', accountEmail: null, senderName: '', postalAddress: '' }),
      configure: outreachExternal, connectGmail: outreachExternal, disconnectGmail: outreachExternal,
      generate: input.draftFetch ? (context, signal) => generateOpenAiDraft({ context, signal,
        credentials: { apiKey: 'fixture-only-key', model: 'fixture-model' }, fetch: input.draftFetch! }) : outreachExternal,
      prepare: outreachExternal, dispose: () => undefined,
    } }),
    createDiscoveryWorker: options => {
      worker = createDiscoveryWorker({ ...options, clock, research: input.research ?? unavailableDiscoveryResearch,
        schedule: (run, delay) => { const job = { run, at: Date.now() + delay }; scheduled.add(job); late.push(run); return () => { scheduled.delete(job); }; } });
      return process.env.CALLIE_DISCOVERY_CONTROL === 'worker' ? { ...worker, start: () => undefined } : worker;
    },
    createBackupService: () => ({ start: async () => undefined, shutdown: async () => undefined, createBackup: unexpected, listAvailableBackups: async () => [] }),
    createRecoveryService: () => ({ status: unexpected, beginSetup: unexpected, saveSetupMaterial: unexpected, completeSetup: unexpected,
      selectAndRunRestoreDrill: unexpected, shutdown: async () => undefined }),
    createSourcingPoller: () => ({ getHealth: (): SourcingPollHealth => ({ status: 'healthy', reasons: [], lastSuccessAgeMs: null,
      state: { state: 'idle', pollId: null, startedAt: null, lastCompletedAt: null, consecutiveFailures: 0,
        lastFailureAt: null, lastFailureCode: null, backlogCount: null } }), stop: (): void => undefined, idle: async (): Promise<void> => undefined }) as unknown as SourcingPoller,
    createAppleBridgeSupervisor: unexpected,
    registerApplicationIpc: (...args) => { runtime = args[0]; return registerApplicationIpc(...args); },
  };
  const app = await startApplication({ appVersion: '1.0.0', userDataPath: dirname(temp.path),
    isTrustedRendererUrl: url => url === 'callie://app/index.html', createWindow: () => undefined }, dependencies);
  let stopped = false;
  const stop = async () => { if (stopped) return; stopped = true; await app.shutdown(); expect(scheduled.size).toBe(0);
    expect(phoneDispatch).not.toHaveBeenCalled(); expect(enrichmentUpload).not.toHaveBeenCalled(); expect(outreachExternal).not.toHaveBeenCalled(); };
  stops.push(stop); // Own cleanup before any fixture assertion can fail and leak IPC channels.
  const services = domain.getServices();
  const manualReview = vi.spyOn(services.lifecycle, 'reviewToReady');
  const facadeReview = await runtime.withDomain(d => vi.spyOn(d, 'confirmTransition'));
  boundary.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
    const handler = boundary.handlers.get(channel); if (!handler) throw new Error(`Missing channel ${channel}`);
    return handler({ senderFrame: { url: 'callie://app/index.html' } }, ...args);
  });
  boundary.expose.mockClear(); vi.resetModules(); await import('../../src/preload');
  expect(boundary.expose.mock.calls[0][0]).toBe('callie');
  const api = boundary.expose.mock.calls[0][1] as CalliePreloadApi;
  expect(await api.health.get()).toMatchObject({ databaseEncrypted: true, schemaVersion: 19, domainReady: true });
  const turn = async () => { await worker.idle(); const due = [...scheduled].filter(job => job.at <= Date.now());
    for (const job of due) { scheduled.delete(job); job.run(); } await worker.idle(); };
  const drain = async () => { for (let n = 0; n < 12; n++) { await turn(); if (![...scheduled].some(job => job.at <= Date.now())) return; }
    throw new Error('Discovery did not quiesce within twelve bounded turns'); };
  const mount = async () => { const health = await api.health.get(); return render(createElement(FounderApp, { api,
    health: { status: 'ready', health, retry: unexpected } })); };
  return { temp, runtime, database, services, api, worker, scheduled, late, clock, stop, turn, drain, mount, manualReview, facadeReview };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Owner = { personId: string; prospectId: string; sourceEventId: string; salesCycleId: string };
function intake(f: Fixture, index: number, incomplete = false, scoredZero = false): Owner {
  const event = validParcelEvent(); const hash = createHash('sha256').update(`assembled-${index}`).digest('hex');
  event.id = `se_0${hash.slice(0, 25).toUpperCase()}`; event.idempotency_key = hash;
  event.entity.cloud_entity_id = `ce_0${hash.slice(0, 25).toUpperCase()}`;
  event.entity.person!.full_name = index % 3 === 0 ? `Synthetic ${index} Holdings LLC` : `Synthetic Owner ${index}`;
  event.entity.person!.org_names = []; event.entity.person!.phones = [];
  event.entity.person!.emails = index === 0 ? ['owner0@example.test'] : [];
  event.entity.property!.situs_address.line1 = `${index + 100} Synthetic St`;
  event.entity.property!.parcel_id = `SYNTHETIC-${index}`;
  event.entity.property!.unit_count = incomplete ? null : scoredZero ? 1 : index % 2 === 0 ? 10 : 6;
  event.entity.property!.year_built = incomplete ? null : scoredZero ? 2020 : index % 2 === 0 ? 1918 : 1970;
  event.source_uri = `fixture:assembled:${index}`;
  event.observed_at = index === 35 ? '2026-09-05T00:00:00.000Z' : '2026-08-30T00:00:00.000Z';
  const mapped = mapCloudSourceEvent(cloudSourceEventSchema.parse(event));
  if (mapped.kind !== 'intake') throw new Error('Expected intake');
  const result = f.services.sources.createPersonProspect(mapped.command);
  const cycle = f.services.lifecycle.createUnreviewedCycle({ personId: result.personId, prospectId: result.prospectId, entrySourceEventId: result.sourceEventId, effectiveAt: NOW });
  return { ...result, salesCycleId: cycle.id };
}
const rows = (f: Fixture, table: string) => f.database.raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Record<string, unknown>[];
const isolated = (f: Fixture, selected?: Owner) => {
  const selectedCloudIds = new Set(selected ? rows(f, 'cloud_entity_links').filter(row => row.person_id === selected.personId).map(row => row.cloud_entity_id) : []);
  return Object.fromEntries(['sales_cycles', 'stage_events', 'next_actions', 'cadence_enrollments',
    'cadence_action_components', 'activities', 'person_contact_methods', 'sourcing_enrichment_requests'].map(table => [table,
    rows(f, table).filter(row => !selected || row.person_id !== selected.personId && row.sales_cycle_id !== selected.salesCycleId
      && row.id !== selected.salesCycleId && !(table === 'sourcing_enrichment_requests' && selectedCloudIds.has(row.cloud_entity_id)))]));
};
const beginRequest = (brief: DiscoveryBrief): BeginDiscoveryRequest => ({ commandId: randomUUID(), personId: brief.personId,
  salesCycleId: brief.salesCycleId, assessmentId: brief.assessment!.id, expectedFingerprint: brief.assessment!.fingerprint });
function revise(f: Fixture, owner: Owner) {
  const source = f.services.sourceRepository.getById(owner.sourceEventId)!;
  return f.services.sources.appendSourceInteraction({ id: randomUUID(), personId: owner.personId, prospectId: owner.prospectId,
    salesCycleId: owner.salesCycleId, channel: 'parcel', observedAt: source.observedAt, sourceRecord: source.sourceRecord });
}
async function drainResearch(f: Fixture) { await act(async () => { await f.drain(); }); }

describe('assembled automatic discovery through startup, encrypted DB, registrar, full preload and FounderApp', () => {
  // Removing the reachable UI path, mechanical preparation, actual upload, intake
  // refresh or durable draft must break this test. Only the external object store is fake.
  it('S0 selects a no-contact suggestion through real preparation and enrichment intake to a durable unsent draft', async () => {
    const uploads: Parameters<UpstreamObjectStore['putObjectText']>[0][] = [];
    const draftContexts: GroundedDraftContext[] = [];
    const f = await fixture({ enrichmentStore: { putObjectText: async input => { uploads.push(input); } }, draftFetch: async (url, init) => {
      expect(url).toBe('https://api.openai.com/v1/responses');
      const request = JSON.parse(String(init!.body));
      expect(request).toMatchObject({ model: 'fixture-model', store: false, text: { format: { type: 'json_schema', strict: true } } });
      const context = JSON.parse(request.input) as GroundedDraftContext;
      draftContexts.push(context);
      return Response.json({ id: 'response_fixture', status: 'completed', model: 'fixture-model', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify({ subject: 'A question about property maintenance', body: 'Could we talk briefly about how you arrange maintenance?', evidenceIds: [] }) }] }] });
    } });
    const owners: Owner[] = [];
    const events: CloudSourceEvent[] = [];
    for (let index = 0; index < 5; index++) {
      const event = validParcelEvent();
      const hash = createHash('sha256').update(`contact-repair-${index}`).digest('hex');
      event.id = `se_0${hash.slice(0, 25).toUpperCase()}`;
      event.idempotency_key = hash;
      event.entity.cloud_entity_id = `ce_0${hash.slice(0, 25).toUpperCase()}`;
      event.entity.person!.full_name = `Contact Repair Owner ${index}`;
      event.entity.person!.org_names = [];
      event.entity.person!.phones = [];
      event.entity.person!.emails = [];
      event.entity.property!.situs_address.line1 = `${800 + index} Synthetic St`;
      event.entity.property!.parcel_id = `CONTACT-REPAIR-${index}`;
      event.entity.property!.unit_count = 10;
      event.entity.property!.year_built = 1918;
      const mapped = mapCloudSourceEvent(cloudSourceEventSchema.parse(event));
      if (mapped.kind !== 'intake') throw new Error('Expected parcel intake');
      const result = await f.runtime.withDomain(domain => domain.importCloudSourceEvent({ command: mapped.command, cloudEntityId: mapped.cloudEntityId }));
      const detail = await f.api.leadDetail.get({ personId: result.personId });
      expect(detail).toMatchObject({ stage: 'unreviewed', phones: [], emails: [], cloudLinked: true });
      owners.push({ ...result, salesCycleId: detail.salesCycleId });
      events.push(event);
    }
    await drainResearch(f);
    const snapshot = await f.api.discovery.get();
    expect(snapshot.prepared).toHaveLength(5);
    const selected = snapshot.prepared[0];
    const index = owners.findIndex(owner => owner.personId === selected.personId);
    const owner = owners[index]; const source = events[index];
    const beforeRead = isolated(f); const unrelated = isolated(f, owner);
    await f.mount();
    const suggestions = await screen.findByRole('region', { name: 'Suggested contacts' });
    const selectedSuggestion = await within(suggestions).findByRole('button', { name: selected.personName });
    expect(within(suggestions).getAllByRole('button')).toHaveLength(3);
    fireEvent.click(selectedSuggestion);
    const inspector = await screen.findByRole('complementary', { name: `${selected.personName} details` });
    expect(isolated(f)).toEqual(beforeRead);
    expect(uploads).toEqual([]);
    const findContact = within(inspector).getByRole('button', { name: 'Find contact info' }) as HTMLButtonElement;
    await waitFor(() => expect(findContact.disabled).toBe(false));
    fireEvent.click(findContact);
    await waitFor(() => expect(uploads).toHaveLength(1));
    expect(JSON.parse(uploads[0].body)).toEqual({ cloud_entity_id: source.entity.cloud_entity_id,
      requested_at: NOW, owner_full_name: selected.personName,
      situs_address: { line1: `${800 + index} synthetic st`, locality: 'providence', region: 'ri', postal_code: '02906' } });
    expect(uploads[0].key).toMatch(/^upstream\/enrichment-requests\/2026-09-06-[0-9A-HJKMNP-TV-Z]{26}\.ndjson$/);
    expect(uploads[0].contentType).toBe('application/x-ndjson');
    await waitFor(() => expect(rows(f, 'sourcing_enrichment_requests')).toHaveLength(1));
    const ready = await f.api.leadDetail.get({ personId: owner.personId });
    expect(ready).toMatchObject({ stage: 'ready', activities: [], phones: [], emails: [] });
    expect(f.manualReview).not.toHaveBeenCalled();
    expect(f.facadeReview).not.toHaveBeenCalled();
    expect(rows(f, 'discovery_preparations')).toHaveLength(1);
    // Deliver a real cloud-shaped response through the production mapper/facade,
    // not a pre-inserted valid email or a mocked detail response.
    const response = validEnrichmentEvent();
    response.entity.cloud_entity_id = source.entity.cloud_entity_id;
    response.entity.person!.full_name = selected.personName;
    response.observed_at = NOW;
    const mapped = mapCloudSourceEvent(cloudSourceEventSchema.parse(response));
    if (mapped.kind !== 'intake') throw new Error('Expected enrichment intake');
    await act(async () => { await f.runtime.withDomain(domain => domain.importCloudSourceEvent({ command: mapped.command, cloudEntityId: mapped.cloudEntityId })); });
    fireEvent(window, new Event('focus'));
    fireEvent.click(await within(inspector).findByRole('button', { name: 'Email' }));
    const message = await within(inspector).findByRole('textbox', { name: 'Message' });
    await waitFor(() => expect((message as HTMLTextAreaElement).value).toBe('Could we talk briefly about how you arrange maintenance?'));
    expect(draftContexts).toHaveLength(1);
    expect(draftContexts[0]).toMatchObject({ personName: selected.personName, segment: 'cold', stage: 'ready' });
    expect(draftContexts[0].facts.map(fact => fact.text)).toEqual([`Recorded owner of ${800 + index} Synthetic St, Providence, RI.`]);
    expect(Object.keys(draftContexts[0]).sort()).toEqual(['actionLabel', 'facts', 'organizationLabel', 'personName', 'playbook', 'segment', 'stage']);
    fireEvent.change(message, { target: { value: 'A selected-source introduction, saved but never sent.' } });
    expect((within(inspector).getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(inspector).getByRole('button', { name: 'Close draft' }));
    await waitFor(() => expect(within(inspector).queryByRole('textbox', { name: 'Message' })).toBeNull());
    expect(isolated(f, owner)).toEqual(unrelated);
    expect((await f.api.leadDetail.get({ personId: owner.personId })).emails[0]).toMatchObject({ validationState: 'unverified', ownershipState: 'vendor_candidate' });
    cleanup(); await f.stop();
    const reopened = await fixture({ temp: f.temp });
    await reopened.mount();
    fireEvent.click(screen.getByRole('link', { name: 'Leads' }));
    fireEvent.change(await screen.findByRole('searchbox', { name: 'Search leads' }), { target: { value: selected.personName } });
    fireEvent.click(await screen.findByRole('row', { name: new RegExp(selected.personName) }));
    const reopenedInspector = await screen.findByRole('complementary', { name: `${selected.personName} details` });
    fireEvent.click(within(reopenedInspector).getByRole('button', { name: 'Email' }));
    expect((await within(reopenedInspector).findByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).value).toBe('A selected-source introduction, saved but never sent.');
    expect((await reopened.api.leadDetail.get({ personId: owner.personId })).activities).toEqual([]);
    expect(uploads).toHaveLength(1);
  });

  // Disconnecting startup must fail the SAME nonzero assertion after successful health, intake and rendering.
  it('S1 automatically shortlists 35+ source owners, prepares only one, records actual pilot evidence and reopens idempotently', async () => {
    const f = await fixture(); const owners = Array.from({ length: 37 }, (_, i) => intake(f, i, i >= 35));
    const placeholder = mapCloudSourceEvent(validFrboEvent());
    if (placeholder.kind !== 'needs-identity') throw new Error('Expected unknown owner');
    const unknown = f.services.sources.createPersonProspect(buildNeedsIdentityIntakeCommand(placeholder)!);
    f.services.lifecycle.createUnreviewedCycle({ personId: unknown.personId, prospectId: unknown.prospectId, entrySourceEventId: unknown.sourceEventId, effectiveAt: NOW });
    const conflict = owners[34]; const source = f.services.sourceRepository.getById(conflict.sourceEventId)!;
    f.database.raw.prepare('INSERT INTO cloud_entity_links(cloud_entity_id, person_id, linked_at) VALUES (?, ?, ?)')
      .run((source.sourceRecord.cloudSourceEvent as CloudSourceEvent).entity.cloud_entity_id, owners[33].personId, NOW);
    const excluded = owners[31];
    await f.api.leadDetail.dismissLead({ personId: excluded.personId, salesCycleId: excluded.salesCycleId,
      qualificationGateReason: 'out_of_area', expectedRevision: (await f.api.leadDetail.get({ personId: excluded.personId })).revision });
    const selected = owners[0]; const baseline = isolated(f, selected);
    expect((await f.api.leadDetail.get({ personId: selected.personId })).priorityContext).toBeNull();
    expect((await f.api.leads.list({ query: '', stages: [], priorities: [], sort: 'priority', cursor: null, limit: 200 })).rows.every(row => row.priorityContext === null)).toBe(true);
    await f.mount(); await screen.findByRole('heading', { name: 'Contacts due' });
    expect(screen.queryByRole('button', { name: 'Refresh shortlist' })).toBeNull();
    await drainResearch(f);
    const snapshot = await f.api.discovery.get();
    expect(snapshot.prepared.length, 'startup-owned worker must produce a shortlist').toBeGreaterThan(0);
    expect(snapshot.prepared).toHaveLength(10);
    // Both6/10-door pre1980 properties support15 points. Contact evidence ranks0 first, then Prospect IDs, never cycle IDs.
    const primary = [selected, ...owners.filter((_, i) => i > 0 && i < 34 && i !== 31)
      .sort((a, b) => a.prospectId < b.prospectId ? -1 : 1)];
    expect(snapshot.prepared.slice(0, 8).map(b => b.personId)).toEqual(primary.slice(0, 8).map(o => o.personId));
    expect(snapshot.prepared.some(b => b.personId === excluded.personId)).toBe(false);
    expect(snapshot.prepared.slice(-2).map(b => b.personId)).toEqual([owners[35].personId, owners[36].personId]);
    expect(snapshot.prepared.some(b => b.personId === unknown.personId || b.personId === conflict.personId)).toBe(false);
    expect(snapshot.judgment.find(b => b.personId === conflict.personId)?.assessment?.reasonCodes).toContain('ownership_conflict');
    expect(snapshot.researchCapability).toBe('not_configured');
    const brief = await f.api.discovery.getBrief({ personId: selected.personId });
    expect(brief.pilotNextStep).toBeNull(); expect(brief.assessment?.axes.fit).toMatchObject({ points: 15, completeness: 'partial' });
    expect(brief.assessment?.questions).toHaveLength(3);
    const inspectionBefore = isolated(f);
    fireEvent.click(screen.getByRole('link', { name: 'Leads' }));
    // Real search makes the selected owner reachable regardless of its UUID-tied
    // priority rank in the virtualized grid. It does not alter business state.
    fireEvent.change(await screen.findByRole('searchbox', { name: 'Search leads' }), { target: { value: brief.personName } });
    fireEvent.click(await screen.findByRole('row', { name: /Synthetic 0/i }));
    await act(async () => { await f.api.leadDetail.get({ personId: selected.personId }); });
    const inspector = await screen.findByRole('complementary', { name: /Synthetic 0.*details/ });
    expect(within(inspector).getByRole('region', { name: 'Known portfolio' })).toBeTruthy();
    expect(within(inspector).queryByText(/supported points/)).toBeNull();
    expect(rows(f, 'discovery_preparations')).toEqual([]); expect(isolated(f)).toEqual(inspectionBefore);
    fireEvent.click(within(inspector).getByText('Details', { selector: 'summary' }));
    await within(inspector).findByText('Fit: 15 supported points /30 (partial)');
    for (const claim of brief.assessment!.claims) for (const ref of claim.refs) if (ref.kind === 'source') {
      expect(f.services.sourceRepository.getById(ref.sourceEventId)?.observedAt).toBe(ref.observedAt);
      expect(within(inspector).getAllByText(`Source ${ref.sourceEventId}, ${ref.field}, ${ref.observedAt}`).length).toBeGreaterThan(0);
    }
    expect(rows(f, 'discovery_preparations')).toEqual([]); expect(isolated(f)).toEqual(inspectionBefore);
    fireEvent.click(within(inspector).getByRole('button', { name: 'Close inspector' }));
    // The default contact UI no longer prepares a lifecycle. Exercise the retained
    // explicit preload command independently, never as a side effect of selection.
    const request = beginRequest(brief); const receipt = await f.api.discovery.begin(request);
    expect(rows(f, 'discovery_preparations')).toHaveLength(1);
    expect(f.manualReview).not.toHaveBeenCalled();
    expect(f.facadeReview.mock.calls.filter(([request]) => request.transition === 'review_to_ready')).toEqual([]);
    expect(f.services.identities.getCanonicalProspect(selected.personId)?.qualificationState).toBe('eligible');
    expect(rows(f, 'stage_events').filter(row => row.sales_cycle_id === selected.salesCycleId).at(-1)?.confirmation_kind).toBe('mechanical');
    expect(rows(f, 'next_actions').find(row => row.id === receipt.actionId)?.work_intent).toBe('discretionary_prospecting');
    expect(f.services.prioritizationRepository.getProjection(selected.prospectId)?.fitPoints).toBe(15);
    expect(f.database.raw.prepare('SELECT qualification_reason AS reason FROM prospects WHERE id = ?').get(selected.prospectId))
      .toEqual({ reason: `Discovery assessment ${request.assessmentId}` });
    expect(f.database.raw.prepare(`SELECT d.family FROM cadence_enrollments e JOIN cadence_definitions d
      ON d.id = e.cadence_definition_id WHERE e.sales_cycle_id = ?`).all(selected.salesCycleId)).toEqual([{ family: 'cadence_b' }]);
    expect(isolated(f, selected)).toEqual(baseline);
    // Explicit manual command, never a generated conversation or provider callback.
    await f.api.today.logCallOutcome({ personId: selected.personId, salesCycleId: selected.salesCycleId, outcome: 'spoke', callbackAt: null, occurredAt: NOW });
    let detail = await f.api.leadDetail.get({ personId: selected.personId });
    const spokenId = detail.activities[0].id;
    await expect(f.api.leadDetail.confirmTransition({ transition: 'confirm_interviewed', salesCycleId: selected.salesCycleId, expectedRevision: detail.revision, suggestionActivityId: detail.activities[0].id })).rejects.toThrow(/conversation evidence/);
    await f.api.today.logPastActivity({ personId: selected.personId, salesCycleId: selected.salesCycleId, kind: 'call', direction: 'outbound', occurredAt: NOW, summary: 'I completed the discovery conversation with this owner.', outcome: 'answered' });
    detail = await f.api.leadDetail.get({ personId: selected.personId });
    const conversation = detail.activities.find(a => a.outcome === 'answered')!;
    await f.api.conversations.attachTranscript({ activityId: spokenId, personId: selected.personId, rawText: `Lead: I self-manage ${f.services.identities.listPropertiesForProspect(selected.prospectId)[0].addressLine1}.` });
    await f.api.leadDetail.confirmTransition({ transition: 'confirm_interviewed', salesCycleId: selected.salesCycleId,
      expectedRevision: detail.revision, suggestionActivityId: conversation.id });
    vi.setSystemTime(Date.now() + 60_000); await f.drain();
    expect((await f.api.discovery.getBrief({ personId: selected.personId })).pilotNextStep).toMatchObject({ activityIds: [spokenId] });
    vi.setSystemTime('2026-09-06T20:00:00.000Z');
    cleanup(); await f.mount(); fireEvent.click(screen.getByRole('link', { name: 'Leads' }));
    fireEvent.change(await screen.findByRole('searchbox', { name: 'Search leads' }), { target: { value: brief.personName } });
    fireEvent.click(await screen.findByRole('row', { name: /Synthetic 0/i }));
    fireEvent.click(await screen.findByRole('tab', { name: 'Activity' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Log dated past activity' }));
    fireEvent.change(screen.getByLabelText('What happened'), { target: { value: 'We discussed a $50 supervised trial.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Log activity' }));
    await waitFor(async () => expect((await f.api.leadDetail.get({ personId: selected.personId })).activities).toHaveLength(3));
    expect(rows(f, 'activities').some(row => row.observed_outcome === 'price_said')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Log dated past activity' }));
    fireEvent.change(screen.getByLabelText('What happened'), { target: { value: 'I stated the $50 supervised trial price.' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'I stated the price' }));
    fireEvent.click(screen.getByRole('button', { name: 'Log activity' }));
    await waitFor(async () => expect((await f.api.leadDetail.get({ personId: selected.personId })).activities.some(a => a.outcome === 'price_said')).toBe(true));
    detail = await f.api.leadDetail.get({ personId: selected.personId }); const price = detail.activities.find(a => a.outcome === 'price_said')!;
    await f.api.leadDetail.confirmTransition({ transition: 'confirm_offered', salesCycleId: selected.salesCycleId, expectedRevision: detail.revision, suggestionActivityId: price.id });
    expect((await f.api.leadDetail.get({ personId: selected.personId })).stage).toBe('offered');
    cleanup(); await f.stop(); const reopened = await fixture({ temp: f.temp }); await reopened.mount(); await reopened.drain();
    expect(await reopened.api.discovery.begin(request)).toEqual(receipt);
    await expect(reopened.api.discovery.begin({ ...request, expectedFingerprint: 'f'.repeat(64) })).rejects.toThrow();
    expect(rows(reopened, 'discovery_preparations')).toHaveLength(1);
    expect(rows(reopened, 'activities')).toHaveLength(4);
  });

  it('S1 preserves actual absent-score displays across views and distinguishes a real supported zero', async () => {
    const f = await fixture(); const owner = intake(f, 0, false, true); const business = isolated(f);
    expect((await f.api.pipeline.get()).stages.flatMap(stage => stage.cards).map(card => card.priorityContext)).toEqual([null]);
    await f.mount();
    await screen.findByRole('heading', { name: 'Contacts due' });
    fireEvent.click(screen.getByRole('link', { name: 'Leads' }));
    const row = await screen.findByRole('row', { name: /Synthetic 0/i });
    for (const axis of ['fit', 'timing']) expect(row.querySelector(`.leads-grid__col--${axis}`)?.textContent).toBe('—');
    expect(row.textContent).not.toMatch(/0\/30|0\/40|Low|P3/);
    fireEvent.click(row); const inspector = await screen.findByRole('complementary', { name: /Synthetic 0/i });
    expect(within(inspector).queryByText('Not assessed')).toBeNull();
    fireEvent.click(within(inspector).getByText('Details', { selector: 'summary' }));
    expect(within(inspector).getAllByText('Not assessed').length).toBeGreaterThanOrEqual(2);
    fireEvent.click(within(inspector).getByRole('button', { name: 'Close inspector' }));
    fireEvent.click(screen.getByRole('link', { name: 'Pipeline' }));
    const card = await screen.findByRole('button', { name: /Synthetic 0/i });
    expect(card.querySelector('.pipeline-card__chip')).toBeNull(); expect(card.textContent).not.toMatch(/0\/30|Low|P3/);
    fireEvent.click(screen.getByRole('radio', { name: 'Table' })); expect(await screen.findByText('No priority data')).toBeTruthy();
    expect(isolated(f)).toEqual(business); expect(rows(f, 'discovery_assessments')).toEqual([]);
    fireEvent.click(screen.getByRole('link', { name: 'Today' })); await screen.findByRole('heading', { name: 'Contacts due' }); await drainResearch(f);
    expect((await f.api.discovery.getBrief({ personId: owner.personId })).assessment?.axes.fit).toMatchObject({ points: 0, completeness: 'partial' });
    fireEvent.click(screen.getByRole('link', { name: 'Leads' }));
    fireEvent.click(await screen.findByRole('row', { name: /Synthetic 0/i }));
    const assessedInspector = await screen.findByRole('complementary', { name: /Synthetic 0/i });
    fireEvent.click(within(assessedInspector).getByText('Details', { selector: 'summary' }));
    expect(await screen.findByText('Fit: 0 supported points /30 (partial)')).toBeTruthy();
    expect(screen.getAllByText('No current trigger established').length).toBeGreaterThan(0);
    expect(rows(f, 'discovery_preparations')).toEqual([]); expect(isolated(f)).toEqual(business);
  });

  // Frozen evidence bypass must fail persisted-job/current-fingerprint assertions, not only a view or parser.
  it('S2 supersedes held research after a genuine source revision and persists only current evidence', async () => {
    const started = held<{ claims: readonly DiscoveryClaim[] }>(); const result = held<readonly DiscoveryClaim[]>(); let first = true;
    const f = await fixture({ research: { capability: () => 'available', research: async input => {
      if (!first) return input.claims; first = false; started.resolve(input); return result.promise;
    } } });
    const owner = intake(f, 0); const original = f.services.unitOfWork.immediate(() => oracle.collectDiscoveryEvidence({ database: f.database, services: f.services, prospectId: owner.prospectId, asOf: NOW }));
    const pump = f.turn(); const request = await started.promise;
    expect((await f.api.leadDetail.get({ personId: owner.personId })).personId).toBe(owner.personId); // lease released during research
    const oldJob = rows(f, 'jobs').find(row => row.state === 'running')!;
    f.services.unitOfWork.immediate(() => oracle.revalidateDiscoverySnapshot(original, f.database, f.services));
    revise(f, owner);
    const fresh = f.services.unitOfWork.immediate(() => oracle.collectDiscoveryEvidence({ database: f.database, services: f.services, prospectId: owner.prospectId, asOf: NOW }));
    expect(fresh.inputFingerprint).not.toBe(original.inputFingerprint);
    if (process.env.CALLIE_DISCOVERY_CONTROL === 'freshness') {
      boundary.frozen = original; boundary.admission = [original, f.database, f.services];
    }
    result.resolve(request.claims); await pump; await f.drain();
    expect(f.services.jobs.get(String(oldJob.id))?.state).toBe('succeeded');
    expect(rows(f, 'discovery_assessments')).toHaveLength(1);
    expect.soft(JSON.parse(String(rows(f, 'jobs').find(row => row.id === oldJob.id)!.result_json))).toMatchObject({ status: 'superseded_research' });
    expect.soft(f.services.discoveryRepository.getCurrent(owner.prospectId)?.fingerprint).toBe(fresh.inputFingerprint);
    expect(rows(f, 'discovery_preparations')).toEqual([]);
  });

  it('S2 keeps watch/exclude/reconsider authority, prior override provenance, rule changes and founder-local day freshness', async () => {
    const f = await fixture(); const owner = intake(f, 0); await f.drain();
    const business = isolated(f);
    for (const decision of ['watch', 'exclude', 'reconsider'] as const) {
      const before = await f.api.discovery.getBrief({ personId: owner.personId });
      const request = beginRequest(before);
      await f.api.discovery.override({ commandId: randomUUID(), personId: owner.personId, assessmentId: request.assessmentId,
        expectedFingerprint: request.expectedFingerprint, decision, reason: `Founder ${decision} decision` });
      await expect(f.api.discovery.begin(request)).rejects.toThrow();
      vi.setSystemTime(Date.now() + 60_000); await f.drain();
      const after = await f.api.discovery.getBrief({ personId: owner.personId });
      expect(after.latestOverride).toMatchObject({ decision, evidenceChanged: false });
      expect(after.assessment?.fingerprint).toBe(before.assessment?.fingerprint);
      expect((await f.api.discovery.get()).prepared.some(b => b.personId === owner.personId)).toBe(decision === 'reconsider');
    }
    const prior = await f.api.discovery.getBrief({ personId: owner.personId }); revise(f, owner);
    await expect(f.api.discovery.begin(beginRequest(prior))).rejects.toThrow();
    vi.setSystemTime(Date.now() + 60_000); await f.drain();
    expect((await f.api.discovery.getBrief({ personId: owner.personId })).latestOverride).toMatchObject({ decision: 'reconsider', evidenceChanged: true });
    const revised = await f.api.discovery.getBrief({ personId: owner.personId });
    f.services.unitOfWork.immediate(() => {
      const rule = f.services.prioritizationRepository.getActiveRuleVersion()!;
      f.services.prioritizationRepository.installRuleVersion({ ...rule.document, id: 'assembly-rule-v2', version: 2 });
      f.services.prioritizationRepository.activateRuleVersion({ ruleVersionId: 'assembly-rule-v2', expectedActiveRuleVersionId: rule.id });
    });
    await expect(f.api.discovery.begin(beginRequest(revised))).rejects.toThrow();
    vi.setSystemTime(Date.now() + 60_000); await f.drain();
    const ruleBrief = await f.api.discovery.getBrief({ personId: owner.personId });
    expect(ruleBrief.assessment?.ruleVersionId).toBe('assembly-rule-v2');
    vi.setSystemTime('2026-09-07T04:00:00.000Z');
    await expect(f.api.discovery.begin(beginRequest(ruleBrief))).rejects.toThrow(); await f.drain();
    expect((await f.api.discovery.getBrief({ personId: owner.personId })).assessment?.localDate).toBe('2026-09-07');
    expect(isolated(f)).toEqual(business); expect(rows(f, 'discovery_preparations')).toEqual([]);
  });

  it('S2 reassesses at an actual same-day supported trigger expiry without accepting the stale begin request', async () => {
    const f = await fixture(); const event = validFrboEvent(); event.entity.person = validParcelEvent().entity.person; event.signal_flags.vacancy = true;
    const mapped = mapCloudSourceEvent(event); if (mapped.kind !== 'intake') throw new Error('Expected intake');
    const owner = f.services.sources.createPersonProspect(mapped.command);
    f.services.lifecycle.createUnreviewedCycle({ personId: owner.personId, prospectId: owner.prospectId, entrySourceEventId: owner.sourceEventId, effectiveAt: NOW });
    f.services.prioritization.recordTriggerEvent({ id: randomUUID(), prospectId: owner.prospectId, triggerType: 'live_vacancy',
      effectiveAt: event.observed_at, sourceExpiresAt: '2026-09-06T13:00:00.000Z', strengthMultiplier: 1, verificationState: 'unverified',
      evidence: { formatVersion: 1, triggerType: 'live_vacancy', authoredUnderRuleVersionId: 'founder-priority-v1', function: 'decaying',
        evidenceRefs: [String(event.payload.listing_url)], proof: { kind: 'source_event', sourceEventId: owner.sourceEventId, sourceObservedAt: event.observed_at } } });
    await f.drain(); const before = await f.api.discovery.getBrief({ personId: owner.personId });
    expect(before.assessment?.expiresAt).toBe('2026-09-06T13:00:00.000Z');
    vi.setSystemTime('2026-09-06T13:00:00.000Z');
    await expect(f.api.discovery.begin(beginRequest(before))).rejects.toThrow(); await f.drain();
    const after = await f.api.discovery.getBrief({ personId: owner.personId });
    expect(after.assessment?.id).not.toBe(before.assessment?.id);
    expect(after.assessment?.axes.timing.hasSupportedTrigger).toBe(false);
    expect(rows(f, 'discovery_preparations')).toEqual([]);
  });

  it('S3 resumes durable work after exactly25 of35 dispatches, rejects old timers and never duplicates preparation', async () => {
    const f = await fixture(); Array.from({ length: 35 }, (_, i) => intake(f, i));
    await f.turn(); expect(rows(f, 'discovery_assessments')).toHaveLength(25);
    expect(rows(f, 'jobs').filter(row => row.state === 'queued')).toHaveLength(10);
    expect((await f.api.discovery.get()).processing).toBe('running');
    const first = rows(f, 'discovery_assessments'); await f.stop();
    const reopened = await fixture({ temp: f.temp }); const before = rows(reopened, 'jobs');
    f.late.forEach(run => run()); await f.worker.idle(); expect(rows(reopened, 'jobs')).toEqual(before);
    await reopened.drain(); expect(rows(reopened, 'discovery_assessments')).toHaveLength(35);
    expect(rows(reopened, 'discovery_assessments')).toEqual(expect.arrayContaining(first));
    expect(new Set(rows(reopened, 'discovery_current').map(row => row.prospect_id)).size).toBe(35);
    expect((await reopened.api.discovery.get()).processing).toBe('idle');
    expect(rows(reopened, 'discovery_preparations')).toEqual([]); expect(rows(reopened, 'activities')).toEqual([]);
  });

  it('S3 cancels a held result at old-owner shutdown and cannot admit it to the reopened runtime', async () => {
    const entered = held<{ claims: readonly DiscoveryClaim[]; signal: AbortSignal }>(); const result = held<readonly DiscoveryClaim[]>();
    const f = await fixture({ research: { capability: () => 'available', research: async input => { entered.resolve(input); return result.promise; } } });
    const owner = intake(f, 0); const pump = f.turn(); const request = await entered.promise;
    await f.stop(); await pump; expect(request.signal.aborted).toBe(true);
    const reopened = await fixture({ temp: f.temp }); const before = rows(reopened, 'discovery_assessments');
    result.resolve(request.claims); f.late.forEach(run => run()); await f.worker.idle();
    expect(rows(reopened, 'discovery_assessments')).toEqual(before);
    vi.setSystemTime(Date.now() + 60_000); await reopened.drain();
    expect(reopened.services.discoveryRepository.getCurrent(owner.prospectId)).not.toBeNull();
    expect(rows(reopened, 'discovery_assessments')).toHaveLength(1);
  });

  it('S3 automatically restores one normal assessment failure with a charged recovery and retained diagnostic', async () => {
    let corrupt = true;
    const f: Fixture = await fixture({ research: { capability: () => corrupt ? 'available' : 'not_configured', research: async input => {
      f.database.raw.prepare("UPDATE source_events SET source_record_json = '{}' WHERE id = ?").run(owner.sourceEventId); return input.claims;
    } } });
    const owner = intake(f, 0);
    const originalBytes = (f.database.raw.prepare('SELECT source_record_json AS bytes FROM source_events WHERE id = ?').get(owner.sourceEventId) as { bytes: string }).bytes;
    const trigger = f.database.raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'immutable_source_events'").get() as { sql: string };
    f.database.raw.exec('DROP TRIGGER immutable_source_events'); await f.turn();
    const root = f.services.jobs.listByTypeState('discovery_assessment', 'failed', 50).find(job => (job.payload as { diagnostic: unknown }).diagnostic === null)!;
    expect(root.error?.code).toBe('invalid_evidence'); expect((await f.api.discovery.get()).processing).toBe('error');
    f.database.raw.prepare('UPDATE source_events SET source_record_json = ? WHERE id = ?').run(originalBytes, owner.sourceEventId);
    f.database.raw.exec(trigger.sql); corrupt = false;
    vi.setSystemTime(Date.now() + 60_000); await f.drain(); vi.setSystemTime(Date.now() + 60_000); await f.drain();
    expect(f.services.discoveryRepository.getCurrent(owner.prospectId)).not.toBeNull();
    expect(f.services.jobs.listByTypeState('discovery_assessment', 'succeeded', 50)).toEqual(expect.arrayContaining([
      expect.objectContaining({ retryCount: 1, payload: expect.objectContaining({ recovery: { kind: 'discovery_recovery_v1', rootJobId: root.id } }) })]));
    expect(f.services.jobs.get(root.id)).toMatchObject({ state: 'failed', payload: root.payload, error: root.error,
      result: { kind: 'discovery_diagnostic_status_v1', status: 'resolved' } });
    expect((await f.api.discovery.get()).processing).toBe('idle');
  });

  it('S3 repairs a startup-created priority job after exact restoration with a new real evaluation', async () => {
    const seed = await fixture(); const owner = intake(seed, 0); await seed.drain();
    await seed.api.discovery.begin(beginRequest(await seed.api.discovery.getBrief({ personId: owner.personId })));
    seed.database.raw.prepare('DELETE FROM prospect_priority_projection WHERE prospect_id = ?').run(owner.prospectId);
    await seed.stop(); const f = await fixture({ temp: seed.temp });
    const root = f.services.jobs.listByTypeState('priority_projection_rebuild_v1', 'queued', 50)[0]!;
    expect(root).toBeDefined();
    const original = f.services.sourceRepository.getById(owner.sourceEventId)!;
    const trigger = f.database.raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'immutable_source_events'").get() as { sql: string };
    f.database.raw.exec('DROP TRIGGER immutable_source_events');
    f.database.raw.prepare('UPDATE source_events SET observed_at = ? WHERE id = ?').run('not-a-timestamp', owner.sourceEventId);
    await f.runtime.withDomain(d => d.processPriorityRefreshJob(root.id));
    const failed = f.services.jobs.get(root.id)!; expect(failed.error?.code).toBe('invalid_evidence');
    f.database.raw.prepare('UPDATE source_events SET observed_at = ? WHERE id = ?').run(original.observedAt, owner.sourceEventId);
    f.database.raw.exec(trigger.sql); vi.setSystemTime(Date.now() + 60_000); await f.drain();
    vi.setSystemTime(Date.now() + 60_000); await f.drain();
    const projection = f.services.prioritizationRepository.getProjection(owner.prospectId)!;
    expect(projection).not.toBeNull(); expect(projection.evaluationId).not.toBe((root.payload as { evaluationId: string }).evaluationId);
    expect(f.services.jobs.listByTypeState('priority_projection_rebuild_v1', 'succeeded', 50)).toEqual(expect.arrayContaining([
      expect.objectContaining({ retryCount: 1, payload: expect.objectContaining({ recovery: { kind: 'discovery_recovery_v1', rootJobId: root.id } }) })]));
    expect(f.services.jobs.get(root.id)).toMatchObject({ state: 'failed', error: failed.error, payload: failed.payload,
      result: { kind: 'discovery_diagnostic_status_v1', status: 'resolved' } });
  });

  it('S4 puts a real due promise first, rechecks capacity and preserves unsent email without lifecycle or outbound writes', async () => {
    vi.setSystemTime('2026-09-08T16:00:00.000Z'); // Permitted local contact window, still no dispatch.
    const f = await fixture(); const owner = intake(f, 0); const other = intake(f, 2);
    // Pre-existing synthetic contact/compliance evidence, fixed before the no-side-effects baseline.
    f.database.raw.prepare(`INSERT INTO person_contact_methods
      (id, person_id, kind, normalized_value, validation_state, reachability, created_at, updated_at,
       federal_status, compliance_tcpa_flag, covered_area_code, compliance_source, scrubbed_at, compliance_expires_at)
      VALUES (?, ?, 'phone', '+14015550100', 'valid', 'direct', ?, ?, 'verified_clear', 0, '401',
        'ftc_download', '2026-08-15T00:00:00.000Z', '2026-09-15T00:00:00.000Z')`).run(randomUUID(), owner.personId, NOW, NOW);
    f.database.raw.prepare(`INSERT INTO person_outbound_jurisdictions
      (person_id, region_code, timezone, source, effective_at, updated_at)
      VALUES (?, 'RI', 'America/New_York', 'manual_review', ?, ?)`).run(owner.personId, NOW, NOW);
    f.database.raw.prepare(`INSERT INTO outbound_jurisdiction_clearances
      (region_code, channel, decision, registration_confirmed, state_dnc_subscription_confirmed,
       consent_rule_confirmed, source, effective_at, expires_at, updated_at)
      VALUES ('RI', 'text', 'allowed', 1, 1, 1, 'test', '2026-08-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', ?)`)
      .run(NOW);
    await f.drain();
    await f.api.discovery.begin(beginRequest(await f.api.discovery.getBrief({ personId: owner.personId })));
    await f.api.today.logCallOutcome({ personId: owner.personId, salesCycleId: owner.salesCycleId, outcome: 'spoke', callbackAt: new Date(Date.now() + 60_000).toISOString(), occurredAt: f.clock.now() });
    vi.setSystemTime(Date.now() + 60_000); await f.drain();
    const today = await f.api.today.get(); expect(today.lanes.flatMap(lane => lane.items)[0]?.personId).toBe(owner.personId);
    await f.mount();
    const queue = await screen.findByRole('list', { name: 'Work queue' });
    const first = within(queue).getAllByRole('listitem')[0];
    expect(first.getAttribute('data-cycle-id')).toBe(owner.salesCycleId);
    expect(within(first).getByText(/Callback you promised/)).toBeTruthy();
    const fetched = beginRequest(await f.api.discovery.getBrief({ personId: other.personId }));
    f.database.raw.exec('UPDATE workspace_settings SET daily_dial_capacity = 0');
    const before = isolated(f); await expect(f.api.discovery.begin(fetched)).rejects.toThrow(); expect(isolated(f)).toEqual(before);
    fireEvent.click(screen.getByRole('link', { name: 'Leads' }));
    fireEvent.click(await screen.findByRole('row', { name: /Synthetic 0/i }));
    expect((await f.api.leadDetail.get({ personId: owner.personId })).phones[0].compliance?.textRefusalReason).toBeNull();
    const email = await screen.findByRole('button', { name: 'Email' });
    const storage = vi.spyOn(Storage.prototype, 'setItem'); const writes = rows(f, 'activities'); const business = isolated(f);
    const clipboard = vi.fn(unexpected); const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: clipboard } });
    const outbound = vi.spyOn(f.api.leadDetail, 'beginOutbound');
    try {
      fireEvent.click(email);
      await waitFor(() => expect((screen.getByLabelText('Subject') as HTMLInputElement).disabled).toBe(false));
      fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Unsent subject' } });
      fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Unsent private draft' } });
      expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(screen.getByRole('button', { name: 'Close draft' }));
      await waitFor(() => expect(screen.queryByLabelText('Message')).toBeNull());
      expect(rows(f, 'email_drafts')).toEqual([expect.objectContaining({ subject: 'Unsent subject', body: 'Unsent private draft', status: 'draft' })]);
      fireEvent.click(email);
      await waitFor(() => expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('Unsent private draft'));
      expect((screen.getByLabelText('Subject') as HTMLInputElement).value).toBe('Unsent subject');
      fireEvent.click(screen.getByRole('button', { name: 'Close draft' }));
      await waitFor(() => expect(screen.queryByLabelText('Message')).toBeNull());
      fireEvent.click(screen.getByText('Details', { selector: 'summary' }));
      fireEvent.click(screen.getByRole('button', { name: 'Text +14015550100' }));
      fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Unsent synthetic text' } });
      expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(screen.getByRole('button', { name: 'Close draft' }));
      fireEvent.click(screen.getByRole('button', { name: 'Text +14015550100' }));
      expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('');
      fireEvent.click(screen.getByRole('button', { name: 'Close draft' }));
      expect(clipboard).not.toHaveBeenCalled(); expect(outbound).not.toHaveBeenCalled();
    } finally {
      if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor); else Reflect.deleteProperty(navigator, 'clipboard');
    }
    expect(rows(f, 'email_send_intents')).toEqual([]); expect(rows(f, 'email_send_results')).toEqual([]);
    expect(storage).not.toHaveBeenCalled(); expect(rows(f, 'activities')).toEqual(writes); expect(isolated(f)).toEqual(business);
  });
});
