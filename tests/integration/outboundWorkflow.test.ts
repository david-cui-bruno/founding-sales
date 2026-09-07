// @vitest-environment jsdom

import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { openDatabase, closeDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { DomainRuntime } from '../../src/main/domain/domainRuntime';
import { createDiscoveryWorker, type DiscoveryWorker } from '../../src/main/discovery/discoveryWorker';
import { createDomainServices } from '../../src/main/domain/createDomainServices';
import { UuidGenerator } from '../../src/main/domain/support/idGenerator';
import type { FoundationRuntime } from '../../src/main/foundation/foundationRuntime';
import { HealthService } from '../../src/main/health/healthService';
import { startApplication, type ApplicationStartupDependencies } from '../../src/main/startApplication';
import { registerApplicationIpc } from '../../src/main/ipc/registerApplicationIpc';
import { createOutboundCommandService } from '../../src/main/communications/outboundCommandService';
import type { OutboundCommandServiceApi, OutboundReadinessPort } from '../../src/main/communications/outboundPorts';
import type { Capability, HandoffResult, OutboundRequest } from '../../src/shared/contracts/outboundContract';
import type { SourcingPoller } from '../../src/main/sourcing/sourcingPoller';
import type { SourcingPollHealth } from '../../src/shared/contracts/sourcingContract';
import { createIpcClient } from '../../src/preload/ipcClient';
import { createLeadDetailApi } from '../../src/preload/apis/leadDetailApi';
import { createTodayApi } from '../../src/preload/apis/todayApi';
import { createLeadsApi } from '../../src/preload/apis/leadsApi';
import { LeadInspectorProvider } from '../../src/renderer/features/leadInspector/LeadInspectorProvider';
import { useLeadInspector } from '../../src/renderer/features/leadInspector/useLeadInspector';
import { createTempDatabase, createTestWorkspaceKey, type TempDatabase } from '../fixtures/tempDatabase';
import { seedProspect } from '../fixtures/domainRows';
import type { RegisteredIpcHandler } from '../fixtures/registeredIpcHandler';

const ipc = vi.hoisted(() => ({ handlers: new Map<string, RegisteredIpcHandler>() }));
vi.mock('electron', () => ({ safeStorage: {}, dialog: {}, ipcMain: {
  handle: (channel: string, handler: RegisteredIpcHandler) => {
    if (ipc.handlers.has(channel)) throw new Error(`Duplicate fixture channel: ${channel}`);
    ipc.handlers.set(channel, handler);
  },
  removeHandler: (channel: string) => { ipc.handlers.delete(channel); },
} }));

const NOW = '2026-08-31T15:00:00.000Z';
const available: Capability = { state: 'available', reasonCode: null };
const accepted: HandoffResult = { status: 'handoff_accepted', reasonCode: null };
const trustedUrl = 'callie://app/index.html';
const sourcingHealth: SourcingPollHealth = {
  status: 'healthy', reasons: [], lastSuccessAgeMs: null,
  state: { state: 'idle', pollId: null, startedAt: null, lastCompletedAt: null,
    consecutiveFailures: 0, lastFailureAt: null, lastFailureCode: null, backlogCount: null },
};
const held = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
};
const unexpected = (): never => { throw new Error('External operation forbidden in source fixture'); };
const cleanups: (() => Promise<void>)[] = [];
const temps: TempDatabase[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(async () => {
  cleanup();
  for (const stop of cleanups.splice(0).reverse()) await stop();
  expect(ipc.handlers.size).toBe(0);
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const temp of temps.splice(0)) temp.cleanup();
});

// Real startup owns the service, encrypted runtime, all production registrars and
// shutdown. Only process/OS/backup/recovery/network ports are inert. In particular,
// no production inbound checkpoint or communication-quarantine adapter is enabled.
async function fixture(input: {
  temp?: TempDatabase;
  readiness?: OutboundReadinessPort;
  dispatch?: (phone: string) => Promise<HandoffResult>;
} = {}) {
  const temp = input.temp ?? createTempDatabase();
  if (!input.temp) temps.push(temp);
  let runtime!: FoundationRuntime;
  let service!: OutboundCommandServiceApi;
  let worker!: DiscoveryWorker;
  const scheduled = new Set<{ run(): void; at: number }>();
  // Run the REAL worker to quiescence before baselines, then hold its timer callbacks
  // while asserting outbound isolation. No assessment, projection or revision is faked.
  const drainDiscovery = async () => {
    for (let pass = 0; pass < 10; pass++) {
      await worker.idle();
      const due = [...scheduled].filter(job => job.at <= Date.now());
      if (due.length === 0) return;
      for (const job of due) { scheduled.delete(job); job.run(); }
    }
    throw new Error('Synthetic discovery work did not quiesce within ten bounded pumps');
  };
  const dispatch = vi.fn(input.dispatch ?? (async () => accepted));
  const factory = vi.fn<typeof createOutboundCommandService>((options) => {
    service = createOutboundCommandService({ ...options,
      phone: { inspectCapability: async () => available, dispatch },
      readiness: input.readiness ?? { getCapability: () => available, check: async () => ({ kind: 'ready' }) },
    });
    return service;
  });
  const dependencies: ApplicationStartupDependencies = {
    loadWorkspaceKey: async () => createTestWorkspaceKey(),
    prepareEncryptedDatabase: async () => undefined,
    openDatabase, closeDatabase, migrateToLatest,
    createDomainRuntime: (database) => new DomainRuntime({ database, clock: { now: () => NOW }, ids: new UuidGenerator() }),
    createHealthService: (options) => {
      expect(options.domainStartupReport.violations).toEqual([]);
      return new HealthService(options);
    },
    createOutboundCommandService: factory,
    createDiscoveryWorker: input => {
      worker = createDiscoveryWorker({ ...input, schedule: (run, delayMs) => {
        const job = { run, at: Date.now() + delayMs };
        scheduled.add(job);
        return () => { scheduled.delete(job); };
      } });
      return worker;
    },
    createBackupService: () => ({ start: async () => undefined, shutdown: async () => undefined,
      createBackup: unexpected, listAvailableBackups: async () => [] }),
    createRecoveryService: () => ({ status: unexpected, beginSetup: unexpected, saveSetupMaterial: unexpected,
      completeSetup: unexpected, selectAndRunRestoreDrill: unexpected, shutdown: async () => undefined }),
    createSourcingPoller: () => ({ getHealth: () => sourcingHealth, stop: (): void => undefined,
      idle: async (): Promise<void> => undefined }) as unknown as SourcingPoller,
    createAppleBridgeSupervisor: unexpected,
    registerApplicationIpc: (bound, trust, registrars, sourcing, recovery, shell, enrichment, logs, outbound) => {
      runtime = bound;
      expect(outbound).toBe(service);
      expect(factory).toHaveBeenCalledTimes(1);
      return registerApplicationIpc(bound, trust, registrars, sourcing, recovery, shell, enrichment, logs, outbound);
    },
  };
  const app = await startApplication({ appVersion: '1.0.0', userDataPath: dirname(temp.path),
    isTrustedRendererUrl: (url) => url === trustedUrl, createWindow: () => undefined }, dependencies);
  cleanups.push(async () => {
    await app.shutdown();
    expect(scheduled.size).toBe(0); // Startup still owns real worker cancellation and drain.
  });
  const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    const handler = ipc.handlers.get(channel);
    if (!handler) throw new Error(`Missing fixture channel: ${channel}`);
    return handler({ senderFrame: { url: trustedUrl } }, ...args);
  });
  const client = createIpcClient({ invoke });
  const api = createLeadDetailApi(client);
  const outbound = vi.spyOn(api, 'beginOutbound'); // Observation only, real preload still executes.
  expect(await runtime.getHealth()).toMatchObject({ databaseEncrypted: true });
  return { temp, runtime, app, service, dispatch, invoke, api, outbound, drainDiscovery,
    today: createTodayApi(client), leads: createLeadsApi(client) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function seed(f: Fixture, prefix = 'workflow'): Promise<OutboundRequest> {
  const identity = await f.runtime.withDatabase((database) => {
    const prospect = seedProspect(database.raw, prefix);
    database.raw.prepare("UPDATE prospects SET qualification_state = 'unreviewed' WHERE id = ?").run(prospect.prospectId);
    const services = createDomainServices({ database, clock: { now: () => NOW }, ids: new UuidGenerator() });
    const salesCycleId = services.lifecycle.createUnreviewedCycle({ personId: prospect.personId, prospectId: prospect.prospectId,
      entrySourceEventId: prospect.sourceEventId, effectiveAt: NOW }).id;
    database.raw.prepare(`INSERT INTO person_contact_methods
      (id, person_id, kind, normalized_value, validation_state, reachability, created_at, updated_at,
       federal_status, compliance_tcpa_flag, covered_area_code, compliance_source, scrubbed_at, compliance_expires_at)
      VALUES (?, ?, 'phone', '+14015550100', 'valid', 'direct', ?, ?, 'verified_clear', 0, '401',
        'ftc_download', '2026-08-15T00:00:00.000Z', '2026-09-15T00:00:00.000Z')`)
      .run(`${prefix}-phone`, prospect.personId, NOW, NOW);
    services.unitOfWork.immediate(() => services.identities.addContactMethod({ personId: prospect.personId,
      kind: 'email', normalizedValue: `${prefix}@example.test`, validationState: 'valid', reachability: 'direct' }));
    database.raw.prepare(`INSERT INTO person_outbound_jurisdictions
      (person_id, region_code, timezone, source, effective_at, updated_at)
      VALUES (?, 'RI', 'America/New_York', 'manual_review', ?, ?)`).run(prospect.personId, NOW, NOW);
    for (const channel of ['call', 'text']) database.raw.prepare(`INSERT OR REPLACE INTO outbound_jurisdiction_clearances
      (region_code, channel, decision, registration_confirmed, state_dnc_subscription_confirmed,
       consent_rule_confirmed, source, effective_at, expires_at, updated_at)
      VALUES ('RI', ?, 'allowed', 1, 1, 1, 'test', '2026-08-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', ?)`)
      .run(channel, NOW);
    return { personId: prospect.personId, salesCycleId };
  });
  await f.api.confirmTransition({ transition: 'review_to_ready', salesCycleId: identity.salesCycleId, expectedRevision: 0 });
  await f.drainDiscovery();
  const detail = await f.api.get({ personId: identity.personId });
  expect(detail.priorityContext).not.toBeNull(); // Real queued priority refresh completed before invariance baselines.
  return { ...identity, commandId: randomUUID(), channel: 'call', contactMethodId: `${prefix}-phone`,
    expectedContactSnapshot: detail.phones[0].contactSnapshot };
}

const businessRows = (f: Fixture) => f.runtime.withDatabase((database) => Object.fromEntries(
  ['sales_cycles', 'stage_events', 'next_actions', 'cadence_enrollments', 'cadence_action_components'].map((table) =>
    [table, database.raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
));
const communications = (f: Fixture) => f.runtime.withDatabase((database) => database.raw.prepare(
  "SELECT * FROM activities WHERE kind IN ('call','voicemail','text','email') ORDER BY rowid",
).all() as { id: string; kind: string; observed_outcome: string; adapter: string; provider_idempotency_key: string; metadata_json: string }[]);
const facts = (f: Fixture) => f.runtime.withDatabase((database) => database.raw.prepare(
  "SELECT provider_idempotency_key AS key, kind, direction, channel, observed_outcome FROM activities WHERE adapter = 'callie_outbound_v1' ORDER BY rowid",
).all());
const revision = (f: Fixture) => f.runtime.withDatabase((database) =>
  (database.raw.prepare('SELECT total_changes() AS n').get() as { n: number }).n);
async function projections(f: Fixture, personId: string) {
  const detail = await f.api.get({ personId });
  const list = await f.leads.list({ query: '', stages: [], priorities: [], sort: 'last_contact', cursor: null, limit: 200 });
  const today = Object.fromEntries(Object.entries(await f.today.get()).filter(([key]) => key !== 'revision'));
  return { row: list.rows.find((row) => row.personId === personId), today,
    timeline: detail.activities, history: detail.history, cadence: detail.cadence, nextAction: detail.nextAction };
}
function OpenLead({ personId }: { personId: string }) {
  const inspector = useLeadInspector();
  return createElement('button', { onClick: () => inspector.openLead(personId) }, `Inspect ${personId}`);
}
async function showInspector(f: Fixture, personId: string) {
  render(createElement(LeadInspectorProvider, { api: f.api, children: createElement(OpenLead, { personId }) }));
  fireEvent.click(screen.getByRole('button', { name: `Inspect ${personId}` }));
  await screen.findByRole('button', { name: 'Call +14015550100' });
}

// Catches phantom communication writes on handoff, missing manual persistence,
// and command-linked manual replay that appends another touch or alters cadence.
describe('assembled truthful outbound workflow (encrypted source fixtures, not live capability proof)', () => {
  it('requires explicit confirmation, then one explicit canonical manual outcome despite replay', async () => {
    const f = await fixture();
    const identity = await seed(f);
    const before = await projections(f, identity.personId);
    const rows = await businessRows(f);
    const beforeCommunications = await communications(f);
    expect(beforeCommunications).toEqual([]);
    expect(before.row).toMatchObject({ stage: 'ready', lastActivityAt: null });
    expect(before.nextAction).not.toBeNull();
    expect(rows.cadence_enrollments).toHaveLength(1);
    expect(rows.cadence_action_components.length).toBeGreaterThan(0);
    await showInspector(f, identity.personId);
    fireEvent.click(screen.getByRole('button', { name: 'Call +14015550100' }));
    const confirmation = screen.getByRole('region', { name: 'Confirm Phone handoff' });
    expect(f.outbound).not.toHaveBeenCalled();
    expect(await facts(f)).toEqual([]);
    fireEvent.click(await within(confirmation).findByRole('button', { name: 'Open Phone' }));
    await screen.findByText('Phone handoff accepted. Call outcome unverified.');
    expect(f.outbound).toHaveBeenCalledTimes(1);
    const request = f.outbound.mock.calls[0][0];
    const receipt = await f.outbound.mock.results[0].value;
    expect(request).toEqual({ ...identity, commandId: expect.any(String) });
    expect(receipt).toEqual({ commandId: request.commandId, channel: 'call', status: 'handoff_accepted', reasonCode: null,
      mutation: { revision: await revision(f), affectedPersonIds: [identity.personId], affectedSalesCycleIds: [identity.salesCycleId] } });
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    expect(f.dispatch).toHaveBeenCalledWith('+14015550100');
    expect(await facts(f)).toEqual(['requested', 'dispatching', 'handoff_accepted'].map((phase) => ({
      key: `${request.commandId}:${phase}`, kind: 'system', direction: 'internal', channel: 'outbound_command', observed_outcome: null as null,
    })));
    expect(await communications(f)).toEqual(beforeCommunications);
    expect(await businessRows(f)).toEqual(rows);
    expect(await projections(f, identity.personId)).toEqual(before);
    await expect(f.api.beginOutbound(request)).resolves.toEqual(receipt);
    const commandFacts = await facts(f);

    const manual = { personId: identity.personId, salesCycleId: identity.salesCycleId, outboundCommandId: request.commandId,
      outcome: 'no_answer' as const, callbackAt: null as string | null, occurredAt: NOW };
    await f.today.logCallOutcome(manual);
    const written = await communications(f);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ kind: 'call', observed_outcome: 'no_answer', adapter: 'callie_manual_outbound_v1',
      provider_idempotency_key: request.commandId });
    expect(JSON.parse(written[0].metadata_json)).toMatchObject({ loggedManually: true, loggedVia: 'call_outcome', outboundCommandId: request.commandId });
    const after = await projections(f, identity.personId);
    expect(after.row).toEqual({ ...before.row, lastActivityAt: NOW });
    expect(after.timeline).toHaveLength(before.timeline.length + 1);
    expect(after.timeline[0]).toMatchObject({ id: written[0].id, outcome: 'no_answer' });
    expect(after.today).toEqual(before.today);
    expect(await businessRows(f)).toEqual(rows); // A reported no-answer is not Contacted or cadence completion.
    const savedRevision = await revision(f);
    await f.today.logCallOutcome({ ...manual });
    await expect(f.today.logCallOutcome({ ...manual, outcome: 'spoke' })).rejects.toMatchObject({ code: 'ACTION_NOT_SUPPORTED' });
    expect(await revision(f)).toBe(savedRevision);
    expect(await communications(f)).toEqual(written);
    expect(await facts(f)).toEqual(commandFacts);
    expect(await projections(f, identity.personId)).toEqual(after);
    expect((await f.api.get({ personId: identity.personId })).outboundAttempts).toEqual([{
      commandId: request.commandId, channel: 'call', contactMethodId: request.contactMethodId,
      requestedAt: NOW, manualActivityId: written[0].id, status: 'handoff_accepted', reasonCode: null,
    }]);
    expect(f.dispatch).toHaveBeenCalledTimes(1);
  });

  it('edits and discards real memory-only email/text composers without outbound, storage or autosave', async () => {
    const f = await fixture();
    const request = await seed(f);
    const before = await projections(f, request.personId);
    const rows = await businessRows(f);
    const beforeCommunications = await communications(f);
    const savedRevision = await revision(f);
    await showInspector(f, request.personId);
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    const clipboard = vi.fn();
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: clipboard } });
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Email workflow@example.test' }));
      const email = screen.getByRole('region', { name: 'Unsent email draft' });
      fireEvent.change(within(email).getByLabelText('Subject'), { target: { value: 'Fixture subject' } });
      fireEvent.change(within(email).getByLabelText('Message'), { target: { value: 'Unsent fixture email' } });
      expect((within(email).getByLabelText('Subject') as HTMLInputElement).value).toBe('Fixture subject');
      expect((within(email).getByLabelText('Message') as HTMLTextAreaElement).value).toBe('Unsent fixture email');
      expect((within(email).getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(within(email).getByRole('button', { name: 'Send' }));
      fireEvent.click(within(email).getByRole('button', { name: 'Close draft' }));
      expect(screen.queryByRole('region', { name: 'Unsent email draft' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Email workflow@example.test' }));
      expect((screen.getByLabelText('Subject') as HTMLInputElement).value).toBe('');
      expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('');
      fireEvent.click(screen.getByRole('button', { name: 'Close draft' }));
      fireEvent.click(screen.getByRole('button', { name: 'Text +14015550100' }));
      const text = screen.getByRole('region', { name: 'Unsent text draft' });
      fireEvent.change(within(text).getByLabelText('Message'), { target: { value: 'Unsent fixture text' } });
      expect((within(text).getByLabelText('Message') as HTMLTextAreaElement).value).toBe('Unsent fixture text');
      expect((within(text).getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      fireEvent.click(within(text).getByRole('button', { name: 'Close draft' }));
      fireEvent.click(screen.getByRole('button', { name: 'Text +14015550100' }));
      expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('');
      fireEvent.click(screen.getByRole('button', { name: 'Close draft' }));
      expect(vi.getTimerCount()).toBe(0);
      expect(storage).not.toHaveBeenCalled();
      expect(clipboard).not.toHaveBeenCalled();
    } finally {
      if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor);
      else Reflect.deleteProperty(navigator, 'clipboard');
    }
    expect(f.outbound).not.toHaveBeenCalled();
    expect(f.invoke.mock.calls.some(([channel]) => channel === 'lead-detail:begin-outbound' || channel.startsWith('today:log-'))).toBe(false);
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(await revision(f)).toBe(savedRevision);
    expect(await facts(f)).toEqual([]);
    expect(await communications(f)).toEqual(beforeCommunications);
    expect(await businessRows(f)).toEqual(rows);
    expect(await projections(f, request.personId)).toEqual(before);
  });

  it('rechecks a real current tombstone after held readiness instead of trusting stale display permission', async () => {
    const ready = held<{ kind: 'ready' }>();
    const entered = held<string>();
    const f = await fixture({ readiness: { getCapability: () => available,
      check: (personId) => { entered.resolve(personId); return ready.promise; } } });
    const request = await seed(f);
    const displayed = await f.api.get({ personId: request.personId });
    expect(displayed.optedOut).toBe(false);
    expect(displayed.phones[0].compliance.callRefusalReason).toBeNull();
    const pending = f.api.beginOutbound(request);
    expect(await entered.promise).toBe(request.personId);
    expect(await facts(f)).toEqual([]);
    // The accepted manual opt-out action creates its own evidence and real
    // tombstone. Only subsequent handoff effects must add no communication.
    await f.today.logCallOutcome({ personId: request.personId, salesCycleId: request.salesCycleId,
      outcome: 'opted_out', occurredAt: NOW, callbackAt: null });
    expect(await f.runtime.withDatabase((database) => database.raw.prepare(
      'SELECT person_id, requested_at FROM opt_out_tombstones',
    ).all())).toEqual([{ person_id: request.personId, requested_at: NOW }]);
    const afterOptOut = await communications(f);
    const rows = await businessRows(f);
    expect(afterOptOut).toHaveLength(1);
    expect(afterOptOut[0].observed_outcome).toBe('opted_out');
    ready.resolve({ kind: 'ready' });
    const receipt = await pending;
    expect(receipt).toEqual({ commandId: request.commandId, channel: 'call', status: 'refused', reasonCode: 'cycle_not_executable',
      mutation: { revision: await revision(f), affectedPersonIds: [request.personId], affectedSalesCycleIds: [request.salesCycleId] } });
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(await communications(f)).toEqual(afterOptOut);
    expect(await businessRows(f)).toEqual(rows);
    expect((await f.api.get({ personId: request.personId })).optedOut).toBe(true);
    expect(await facts(f)).toEqual(['requested', 'refused'].map((phase) => ({
      key: `${request.commandId}:${phase}`, kind: 'system', direction: 'internal', channel: 'outbound_command', observed_outcome: null as null,
    })));
  });

  it('closes a committed held dispatch and reopens the same encrypted workspace as unknown without redispatch', async () => {
    const reply = held<HandoffResult>();
    const entered = held<void>();
    const f = await fixture({ dispatch: () => { entered.resolve(); return reply.promise; } });
    const request = await seed(f);
    const before = await projections(f, request.personId);
    const rows = await businessRows(f);
    const pending = f.api.beginOutbound(request);
    await entered.promise;
    const unresolved = await facts(f);
    expect(unresolved).toEqual(['requested', 'dispatching'].map((phase) => ({
      key: `${request.commandId}:${phase}`, kind: 'system', direction: 'internal', channel: 'outbound_command', observed_outcome: null as null,
    })));
    const savedRevision = await revision(f);
    await f.app.shutdown(); // The real Task7 owner cancels, without a test repair write.
    expect(await pending).toEqual({ commandId: request.commandId, channel: 'call', status: 'unknown', reasonCode: 'result_not_persisted',
      mutation: { revision: savedRevision, affectedPersonIds: [request.personId], affectedSalesCycleIds: [request.salesCycleId] } });
    expect(ipc.handlers.size).toBe(0);
    expect(readFileSync(f.temp.path).subarray(0, 16).toString()).not.toBe('SQLite format 3\0');
    const reopened = await fixture({ temp: f.temp });
    expect(reopened.app.databasePath).toBe(f.app.databasePath);
    expect(reopened.runtime).not.toBe(f.runtime);
    expect(reopened.service).not.toBe(f.service);
    reply.resolve(accepted); // Late acknowledgement cannot persist into the reopened owner.
    await Promise.resolve();
    await reopened.drainDiscovery();
    const reopenedRevision = await revision(reopened);
    const recovered = await reopened.api.beginOutbound({ ...request });
    expect(recovered).toEqual({ commandId: request.commandId, channel: 'call', status: 'unknown', reasonCode: 'handoff_uncertain',
      mutation: { revision: reopenedRevision, affectedPersonIds: [request.personId], affectedSalesCycleIds: [request.salesCycleId] } });
    await expect(reopened.api.beginOutbound({ ...request })).resolves.toEqual(recovered);
    await expect(reopened.api.beginOutbound({ ...request, channel: 'text' })).rejects.toThrow('conflict');
    expect(await revision(reopened)).toBe(reopenedRevision);
    expect(await facts(reopened)).toEqual(unresolved);
    expect(await communications(reopened)).toEqual([]);
    expect(await businessRows(reopened)).toEqual(rows);
    expect(await projections(reopened, request.personId)).toEqual(before);
    await showInspector(reopened, request.personId);
    expect(await screen.findByText('Phone handoff unknown. Do not retry.')).toBeTruthy();
    expect(screen.getByText(request.commandId)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Call +14015550100' }));
    expect(screen.queryByRole('button', { name: 'Open Phone' })).toBeNull();
    expect(reopened.outbound).toHaveBeenCalledTimes(3); // Only the three explicit requests above.
    expect(reopened.dispatch).not.toHaveBeenCalled();
    expect(f.dispatch).toHaveBeenCalledTimes(1);
  });
});
