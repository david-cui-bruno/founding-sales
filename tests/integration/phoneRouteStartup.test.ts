import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dirname, join } from 'node:path';
import { readFileSync, statSync, writeFileSync, symlinkSync, chmodSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { openDatabase, closeDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { DomainRuntime } from '../../src/main/domain/domainRuntime';
import { createDomainServices } from '../../src/main/domain/createDomainServices';
import { UuidGenerator } from '../../src/main/domain/support/idGenerator';
import type { FoundationRuntime } from '../../src/main/foundation/foundationRuntime';
import { HealthService } from '../../src/main/health/healthService';
import { startApplication, createProductionPhoneBindings, createStartupPhoneBindings, createPhoneInboundRegistry, type ApplicationStartupDependencies, type ApplicationStartupOptions } from '../../src/main/startApplication';
import { registerApplicationIpc } from '../../src/main/ipc/registerApplicationIpc';
import { createOutboundCommandService } from '../../src/main/communications/outboundCommandService';
import { PhoneRouteSettings } from '../../src/main/communications/phoneRouteSettings';
import { registerPhoneSetupIpc } from '../../src/main/communications/registerPhoneSetupIpc';
import type { NativePhoneProcessRequest } from '../../src/main/communications/phoneLaunchDriver';
import type { OutboundCommandServiceApi } from '../../src/main/communications/outboundPorts';
import { phoneSetupSchema } from '../../src/shared/contracts/phoneSetupContract';
import type { AppDatabase } from '../../src/main/db/database';
import type { OutboundRequest } from '../../src/shared/contracts/outboundContract';
import { createIpcClient } from '../../src/preload/ipcClient';
import { createCallieApi } from '../../src/preload/createCallieApi';
import { createPhoneSetupApi } from '../../src/preload/apis/phoneSetupApi';
import { createLeadDetailApi } from '../../src/preload/apis/leadDetailApi';
import { createLeadsApi } from '../../src/preload/apis/leadsApi';
import { createTempDatabase, createTestWorkspaceKey, type TempDatabase } from '../fixtures/tempDatabase';
import { seedProspect } from '../fixtures/domainRows';
import type { RegisteredIpcHandler } from '../fixtures/registeredIpcHandler';
const ipc = vi.hoisted(() => ({ handlers: new Map<string, RegisteredIpcHandler>() }));
vi.mock('electron', () => ({ safeStorage: {}, dialog: {}, ipcMain: {
  handle: (channel: string, handler: RegisteredIpcHandler) => {
    if (ipc.handlers.has(channel)) throw new Error('Duplicate fixture channel');
    ipc.handlers.set(channel, handler);
  },
  removeHandler: (channel: string) => { ipc.handlers.delete(channel); },
} }));
const NOW = '2026-08-31T15:00:00.000Z';
const trustedUrl = 'callie://app/index.html';
const held =<T,>() => {
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
  initialized?: boolean;
  inspect?: () => Promise<string>;
} = {}) {
  const temp = input.temp ?? createTempDatabase();
  if (!input.temp) temps.push(temp);
  let runtime!: FoundationRuntime;
  let database!: AppDatabase;
  const atOpen: { inTransaction: boolean; keys: string[] }[] = [];
  let service!: OutboundCommandServiceApi;
  const opens: NativePhoneProcessRequest[] = [];
  const settings = new PhoneRouteSettings(join(dirname(temp.path), 'phone-setup.json'));
  const reply = JSON.stringify({version: 1, status: 'available', fingerprint: 'fictional-route'});
  const bindings = createProductionPhoneBindings({ settings,
    registry: { snapshot: () => ({ initialized: input.initialized ?? true, revision: 1, adapters: [] }) },
    helper: { path: { isPackaged: true, resourcesPath: '/Fictional/Callie.app/Contents/Resources',
      developmentExecutablePath: '/forbidden', environment: {} },
      signature: { parentExecutablePath: '/Fictional/Callie.app/Contents/MacOS/Callie', expectedIdentifier: 'fixture.helper',
        run: async () => ({ signed: true, identifier: 'fixture.helper', teamIdentifier: 'FICTIONAL' }) } },
    native: { platform: 'darwin', runAsync: async request => {
      if (request.args[0] === '--phone-route-open') {
        atOpen.push({ inTransaction: database.raw.inTransaction,
          keys: (database.raw.prepare("SELECT provider_idempotency_key AS key FROM activities WHERE adapter = 'callie_outbound_v1' ORDER BY rowid").all() as { key: string }[]).map(row => row.key) });
        opens.push(request); return reply;
      }
      return input.inspect ? input.inspect() : reply;
    }, runSync: () => reply },
    now: () => NOW,
  });
  const factory = vi.fn<typeof createOutboundCommandService>((options) => {
    service = createOutboundCommandService(options);
    return service;
  });
  let lifecycle!: Parameters<NonNullable<ApplicationStartupOptions['registerOutboundLifecycle']>>[0];
  const dependencies: ApplicationStartupDependencies = {
    loadWorkspaceKey: async () => createTestWorkspaceKey(),
    prepareEncryptedDatabase: async () => undefined,
    openDatabase, closeDatabase, migrateToLatest,
    createDomainRuntime: (opened) => { database = opened; return new DomainRuntime({ database, clock: { now: () => NOW }, ids: new UuidGenerator() }); },
    createHealthService: (options) => {
      expect(options.domainStartupReport.violations).toEqual([]);
      return new HealthService(options);
    },
    createOutboundCommandService: factory,
    createPhoneBindings: () => bindings,
    registerPhoneSetupIpc,
    createBackupService: () => ({ start: async () => undefined, shutdown: async () => undefined,
      createBackup: unexpected, listAvailableBackups: async () => [] }),
    createRecoveryService: () => ({ status: unexpected, beginSetup: unexpected, saveSetupMaterial: unexpected,
      completeSetup: unexpected, selectAndRunRestoreDrill: unexpected, shutdown: async () => undefined }),
    createAppleBridgeSupervisor: unexpected,
    registerApplicationIpc: (...args) => {
      runtime = args[0];
      expect(factory).toHaveBeenCalledTimes(1);
      return registerApplicationIpc(...args);
    },
  };
  const app = await startApplication({ appVersion: '1.0.0', userDataPath: dirname(temp.path),
    isTrustedRendererUrl: (url) => url === trustedUrl,
    registerOutboundLifecycle: callbacks => { lifecycle = callbacks; return () => undefined; }, createWindow: () => undefined }, dependencies);
  cleanups.push(async () => { await app.shutdown(); });
  const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    const handler = ipc.handlers.get(channel);
    if (!handler) throw new Error(`Missing fixture channel: ${channel}`);
    return handler({ senderFrame: { url: trustedUrl } }, ...args);
  });
  const client = createIpcClient({ invoke });
  const api = createLeadDetailApi(client);
  expect(await runtime.getHealth()).toMatchObject({ databaseEncrypted: true });
  // Person outbound no longer crosses IPC; the route is driven through the startup-owned service.
  return { temp, runtime, app, service, opens, atOpen, settings, bindings, lifecycle, invoke, api,
    setup: createPhoneSetupApi(client), leads: createLeadsApi(client) };
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
      VALUES (?, ?, 'phone', '+14015550200', 'valid', 'direct', ?, ?, 'verified_clear', 0, '401',
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
  // Person commands no longer cross IPC; the seeded cycle is confirmed through the domain facade.
  await f.runtime.withDomain(domain => domain.confirmTransition({ transition: 'review_to_ready', salesCycleId: identity.salesCycleId, expectedRevision: 0 }));
  const detail = await f.api.get({ personId: identity.personId });
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

async function confirm(f: Fixture) {
  expect(await f.setup.status()).toEqual({ state: 'needs_confirmation', candidateFingerprint: 'fictional-route', confirmedAt: null });
  expect(f.settings.read()).toBeNull();
  expect(f.opens).toEqual([]);
  expect(await f.setup.confirm({ expectedFingerprint: 'fictional-route' })).toEqual({
    state: 'configured', candidateFingerprint: 'fictional-route', confirmedAt: NOW,
  });
}

describe('A3 real assembled production phone route with fictional process boundaries', () => {
  it('requires explicit setup then invokes once after durable preparation without inventing conversation or meeting', async () => {
    const f = await fixture();
    const request = await seed(f);
    expect((await f.service.getCapabilities()).phoneHandoff.state).toBe('unavailable');
    await confirm(f);
    const before = await businessRows(f);
    const [first, duplicate] = await Promise.all([f.service.beginOutbound(request), f.service.beginOutbound(request)]);
    expect(first.status).toBe('handoff_accepted');
    expect(duplicate).toEqual(first);
    expect(f.opens).toHaveLength(1);
    expect(f.atOpen).toEqual([{ inTransaction: false, keys: [
      `${request.commandId}:requested`, `${request.commandId}:dispatching`,
    ] }]);
    expect(JSON.parse(f.opens[0].stdin!)).toEqual({ version: 1, target: '+14015550200', expectedFingerprint: 'fictional-route' });
    expect(await businessRows(f)).toEqual(before);
    expect(await communications(f)).toEqual([]);
    expect(await facts(f)).toHaveLength(3);
    await f.app.shutdown();
    const restarted = await fixture({ temp: f.temp });
    expect(await restarted.service.beginOutbound(request)).toMatchObject({ status: 'handoff_accepted', reasonCode: null, commandId: request.commandId });
    expect(restarted.opens).toEqual([]);
  });

  it.each(['wake', 'lock', 'shutdown'] as const)('invalidates pending route inspection on %s with zero dispatch', async reason => {
    let pending = false;
    const started = held<void>(); const inspection = held<string>();
    const f = await fixture({ inspect: () => {
      if (pending) { started.resolve(); return inspection.promise; }
      return Promise.resolve(JSON.stringify({ version: 1, status: 'available', fingerprint: 'fictional-route' }));
    } });
    const request = await seed(f); await confirm(f); pending = true;
    const attempt = f.service.beginOutbound(request); void attempt.catch((): undefined => undefined);
    await started.promise;
    if (reason === 'wake') f.lifecycle.onWake();
    else if (reason === 'lock') f.lifecycle.onLock();
    else await f.app.shutdown();
    inspection.resolve(JSON.stringify({ version: 1, status: 'available', fingerprint: 'fictional-route' }));
    await expect(attempt).rejects.toThrow();
    expect(f.opens).toEqual([]);
  });

  it('keeps uninitialized registry blocked even with explicitly confirmed route', async () => {
    const f = await fixture({ initialized: false }); const request = await seed(f); await confirm(f);
    expect((await f.service.beginOutbound(request)).reasonCode).toBe('inbound_safety_unwired');
    expect(f.opens).toEqual([]);
  });

  it('clear revokes proof and pending explicit confirmation cannot restore it', async () => {
    const waiting = held<string>(); const entered = held<void>(); let pending = false;
    const f = await fixture({ inspect: () => {
      if (pending) { entered.resolve(); return waiting.promise; }
      return Promise.resolve(JSON.stringify({ version: 1, status: 'available', fingerprint: 'fictional-route' }));
    } });
    await confirm(f); pending = true;
    const confirmation = f.setup.confirm({ expectedFingerprint: 'fictional-route' });
    await entered.promise;
    expect(await f.setup.clear()).toEqual({ state: 'unconfigured', candidateFingerprint: null, confirmedAt: null });
    waiting.resolve(JSON.stringify({ version: 1, status: 'available', fingerprint: 'fictional-route' }));
    await expect(confirmation).rejects.toThrow('PHONE_SETUP_FAILED');
    expect(f.settings.read()).toBeNull(); expect(f.opens).toEqual([]);
  });

  it('rejects stale fingerprints, arbitrary timestamps, credentials, extra arguments and untrusted senders', async () => {
    const f = await fixture();
    await expect(f.setup.confirm({ expectedFingerprint: 'different-route' })).rejects.toThrow('PHONE_SETUP_FAILED');
    for (const extra of [{ confirmedAt: NOW }, { password: 'fictional' }]) {
      await expect(f.invoke('phone-setup:confirm', { expectedFingerprint: 'fictional-route', ...extra })).rejects.toThrow('PHONE_SETUP_FAILED');
    }
    await expect(f.invoke('phone-setup:status', {})).rejects.toThrow('PHONE_SETUP_FAILED');
    await expect(ipc.handlers.get('phone-setup:confirm')!({ senderFrame: { url: 'https://untrusted.invalid' } }, { expectedFingerprint: 'fictional-route' })).rejects.toThrow('PHONE_SETUP_FAILED');
    expect(f.settings.read()).toBeNull(); expect(f.opens).toEqual([]);
  });
});

describe('private bounded phone setup record', () => {
  it('round trips only strict setup fields atomically with private mode and refuses corrupt or symlink records', () => {
    const temp = createTempDatabase(); temps.push(temp);
    const path = join(dirname(dirname(temp.path)), 'setup.json'); const settings = new PhoneRouteSettings(path);
    expect(settings.read()).toBeNull();
    settings.confirm({ version: 1, fingerprint: 'fictional-route', confirmedAt: NOW });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ version: 1, fingerprint: 'fictional-route', confirmedAt: NOW });
    const reopened = new PhoneRouteSettings(path); expect(reopened.read()).toEqual(settings.read());
    writeFileSync(path, 'x'.repeat(5000)); expect(reopened.read()).toBeNull();
    writeFileSync(path, JSON.stringify({ version: 1, fingerprint: 'fictional-route', confirmedAt: NOW, secret: 'no' }));
    expect(reopened.read()).toBeNull();
    settings.clear(); expect(settings.read()).toBeNull();
    const target = join(dirname(path), 'target.json'); writeFileSync(target, '{}'); symlinkSync(target, path);
    expect(settings.read()).toBeNull();
    expect(() => settings.confirm({ version: 1, fingerprint: 'fictional-route', confirmedAt: NOW })).toThrow();
    expect(readFileSync(target, 'utf8')).toBe('{}');
  });
});

describe('composed preload setup boundary', () => {
  it('exposes validated setup status without leaking arbitrary provider fields', async () => {
    const invoke = vi.fn(async () => ({ state: 'unconfigured', candidateFingerprint: null, confirmedAt: null }));
    const api = createCallieApi({ invoke });
    expect(await api.phoneSetup.status()).toEqual({ state: 'unconfigured', candidateFingerprint: null, confirmedAt: null });
    invoke.mockResolvedValueOnce({ state: 'configured', candidateFingerprint: null, confirmedAt: null });
    await expect(api.phoneSetup.status()).rejects.toThrow('PHONE_SETUP_FAILED');
  });
});

describe('setup safety beyond the assembled send path', () => {
  it('rejects trailing-newline fingerprints rather than saving ambiguous route proof', () => {
    expect(phoneSetupSchema.safeParse({ version: 1, fingerprint: 'fictional-route\n', confirmedAt: NOW }).success).toBe(false);
  });

  it('fixture startup captures only explicit dispatch and never enables an uninitialized registry', async () => {
    const temp = createTempDatabase(); temps.push(temp);
    const registry = createPhoneInboundRegistry();
    const bindings = createStartupPhoneBindings({ appVersion: '1', userDataPath: dirname(temp.path),
      phoneRouteMode: 'fixture', createWindow: () => undefined }, registry);
    expect(bindings.fixtureInvocations).toEqual([]);
    expect(bindings.readiness.getCapability().state).toBe('unavailable');
    expect(await bindings.setup!.status()).toEqual({ state: 'needs_confirmation', candidateFingerprint: 'fictional-phone-route-v1', confirmedAt: null });
    expect((await bindings.phone.dispatch('+14015550200')).status).toBe('unavailable');
    expect(bindings.fixtureInvocations).toEqual([]);
    await bindings.setup!.confirm({ expectedFingerprint: 'fictional-phone-route-v1' });
    registry.initialize([]);
    expect(bindings.readiness.getCapability().state).toBe('available');
    expect((await bindings.phone.inspectCapability()).state).toBe('available');
    expect((await bindings.phone.dispatch('+14015550200')).status).toBe('handoff_accepted');
    expect(bindings.fixtureInvocations).toHaveLength(1);
    expect((await bindings.phone.dispatch('+14015550200')).status).toBe('unavailable');
    bindings.dispose!();
    expect(await bindings.setup!.status()).toEqual({ state: 'unavailable', candidateFingerprint: null, confirmedAt: null });
  });

  it.each(['unsigned', 'wrong-team', 'wrong-identifier', 'development'] as const)('refuses %s helper before candidate or dispatch process work', async kind => {
    const temp = createTempDatabase(); temps.push(temp);
    const native = vi.fn(async () => { throw new Error('process execution forbidden'); });
    const settings = new PhoneRouteSettings(join(dirname(temp.path), 'proof.json'));
    const bindings = createProductionPhoneBindings({ settings, registry: createPhoneInboundRegistry(),
      helper: { path: { isPackaged: kind !== 'development', resourcesPath: '/Fictional/Callie.app/Contents/Resources',
        developmentExecutablePath: '/forbidden', environment: { CALLIE_APPLE_BRIDGE_PATH: '/must-not-use' } },
      signature: { parentExecutablePath: '/parent', expectedIdentifier: 'fixture.helper', run: async path => {
        if (kind === 'unsigned') return { signed: false };
        return { signed: true, identifier: kind === 'wrong-identifier' ? 'other.helper' : 'fixture.helper',
          teamIdentifier: kind === 'wrong-team' && path === '/parent' ? 'OTHER' : 'FICTIONAL' };
      } } }, native: { platform: 'darwin', runAsync: native, runSync: () => { throw new Error('forbidden'); } },
    });
    expect(native).not.toHaveBeenCalled();
    expect((await bindings.setup!.status()).state).toBe('unavailable');
    await expect(bindings.setup!.confirm({ expectedFingerprint: 'fictional-route' })).rejects.toThrow('PHONE_SETUP_FAILED');
    expect(settings.read()).toBeNull(); expect(native).not.toHaveBeenCalled();
    expect((await bindings.phone.inspectCapability()).state).toBe('unavailable');
  });

  it.each(['wake', 'lock', 'shutdown'] as const)('revokes pending setup confirmation on %s while retaining legitimate saved proof', async reason => {
    const waiting = held<string>(); const entered = held<void>(); let pending = false;
    const f = await fixture({ inspect: () => {
      if (pending) { entered.resolve(); return waiting.promise; }
      return Promise.resolve(JSON.stringify({ version: 1, status: 'available', fingerprint: 'fictional-route' }));
    } });
    await confirm(f); const proof = f.settings.read(); pending = true;
    const attempt = f.setup.confirm({ expectedFingerprint: 'fictional-route' });
    await entered.promise;
    if (reason === 'wake') f.lifecycle.onWake();
    else if (reason === 'lock') f.lifecycle.onLock();
    else await f.app.shutdown();
    waiting.resolve(JSON.stringify({ version: 1, status: 'available', fingerprint: 'fictional-route' }));
    await expect(attempt).rejects.toThrow('PHONE_SETUP_FAILED');
    expect(f.settings.read()).toEqual(proof); expect(f.opens).toEqual([]);
    if (reason === 'lock') {
      await expect(f.bindings.setup!.confirm({ expectedFingerprint: 'fictional-route' })).rejects.toThrow('PHONE_SETUP_FAILED');
      f.lifecycle.onUnlock(); pending = false;
      expect((await f.setup.status()).state).toBe('configured');
    }
  });

  it('refuses duplicate fields, public permissions and invalid versions without silently authorizing them', () => {
    const temp = createTempDatabase(); temps.push(temp);
    const path = join(dirname(dirname(temp.path)), 'proof.json'); const settings = new PhoneRouteSettings(path);
    settings.confirm({ version: 1, fingerprint: 'fictional-route', confirmedAt: NOW });
    chmodSync(path, 0o644); expect(settings.read()).toBeNull(); chmodSync(path, 0o600);
    for (const raw of [
      `{"version":1,"fingerprint":"fictional-route","confirmedAt":"${NOW}","version":1}`,
      JSON.stringify({ version: 2, fingerprint: 'fictional-route', confirmedAt: NOW }),
      JSON.stringify({ version: 1, fingerprint: 'fictional-route', confirmedAt: 'not-a-time' }),
    ]) { writeFileSync(path, raw); expect(settings.read()).toBeNull(); }
  });
});
