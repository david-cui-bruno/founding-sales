import { DomainRuntimeBlockedError } from './domain/startup/domainStartupTypes';
import { validateCompanyResearchConfiguration, isLocalKnownCompanyConfiguration, type EffectiveCompanyResearchConfiguration, type CompanyResearchStartupConfiguration } from './research/companyResearchConfiguration';
import {accountFingerprint} from './domain/accounts/accountEvidence';
import {constants as fsConstants} from 'node:fs';
import {open as openNativeFile} from 'node:fs/promises';
import {registerLinkedInIpc} from './linkedin/registerLinkedInIpc';
import {createLinkedInDraftProvider} from './linkedin/linkedInDraftProvider';
import {CredentialStore} from './outreach/providers/credentialStore';
import { PairingStore, type StoredPairing } from './delegation/pairingStore';
import { ResearchSetupRequestStore } from './delegation/researchSetupRequestStore';
import { createDelegationRuntime, type DelegationRuntime } from './delegation/delegationRuntime';
import { SqlDelegationConfiguration } from './delegation/delegationSync';
import type { AppDatabase } from './db/database';
import { AccountRepository } from './domain/accounts/accountRepository';
import { selectedResearchSchema, type SelectedResearch, type LocalCompanyResearchStatus } from '../shared/contracts/localWorkspaceContract';
import type { SelectedCompanyResearchPort, CompanyResearchSettingsLifecycle } from './workspace/localWorkspaceProvider';
import { SqlDiscoveryReservationStore } from './delegation/discoveryReservationStore';
import { createCompanyDiscoveryProvider } from './research/companyDiscoveryProvider';
import { createCompanyPageProvider, type PageHttp } from './research/companyPageProvider';
import { createFetchedReceiptPolicy } from './research/companySourcePolicy';
import { createCompanyPreparation, createCompanyResearchWorker } from './research/companyResearchWorker';
import type { AccountResearchStore, DiscoveryReservationStore } from './research/companyResearchTypes';
import { createEmailService } from './outreach/emailService';
import { createOutreachProviders } from './outreach/providers/outreachProviders';
import { registerOutreachIpc } from './ipc/registerOutreachIpc';
import { createDiscoveryWorker, type DiscoveryWorker } from './discovery/discoveryWorker';
import { unavailableDiscoveryResearch } from './discovery/discoveryResearchPort';
import { resolveApplicationPaths } from './applicationPaths';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { RecoveryService, type RecoveryServiceOptions, type RecoveryDialogs } from './recovery/recoveryService';
import type { RecoveryProvider } from '../shared/contracts/recoveryContract';

import {
  AppleBridgeSupervisor,
  type AppleBridgeSupervisorApi,
  type AppleBridgeSupervisorOptions,
} from './appleBridge/appleBridgeSupervisor';
import {
  AppleSpikeService,
  type AppleSpikeServiceApi,
} from './appleBridge/appleSpikeService';
import { registerAppleSpikeIpc } from './appleBridge/registerAppleSpikeIpc';
import { BackupService, type BackupServiceOptions } from './backup/backupService';
import type { VerifiedBackup } from './backup/verifiedBackup';
import { closeDatabase, openDatabase } from './db/database';
import { migrateToLatest } from './db/migrate';
import { DomainRuntime } from './domain/domainRuntime';
import { SystemClock } from './domain/support/clock';
import { UuidGenerator } from './domain/support/idGenerator';
import {
  encryptedWorkspaceExists,
  prepareEncryptedDatabase,
} from './db/plaintextDatabaseUpgrade';
import {
  FoundationRuntime,
  type FoundationRuntimeDependencies,
} from './foundation/foundationRuntime';
import { HealthService } from './health/healthService';
import { registerApplicationIpc } from './ipc/registerApplicationIpc';
import type { SourcingProvider } from './sourcing/registerSourcingIpc';
import { EnrichmentRequestWriter } from './sourcing/enrichmentRequestWriter';
import { createFileSystemEnrichmentRequestStore } from './sourcing/enrichmentFixtureStore';
import type { EnrichmentRequester } from './leads/leadDetailService';
import {
  createFileSystemInboxObjectStore,
  createS3InboxObjectStore,
  InboxClient,
} from './sourcing/inboxClient';
import { SourcingCredentialStore } from './sourcing/sourcingCredentialStore';
import { SourcingHmacSaltStore } from './sourcing/sourcingHmacSaltStore';
import { SourcingPoller, type PollTimer } from './sourcing/sourcingPoller';
import {
  createS3UpstreamObjectStore,
  UpstreamSync,
  type UpstreamObjectStore,
} from './sourcing/upstreamSync';
import { safeStorage, dialog, shell, clipboard } from 'electron';
import { SafeStorageKeyProtector } from './security/safeStorageKeyProtector';
import { WorkspaceKeyStore } from './security/workspaceKeyStore';
import type { SafeLogger } from './logging/safeLogger';
import { createOutboundCommandService } from './communications/outboundCommandService';
import { createPhoneHandoffLauncher, unavailablePhoneHandoff, unavailableOutboundReadiness } from './communications/phoneHandoffLauncher';
import type { OutboundCommandServiceApi, OutboundDomainGate, PhoneHandoffPort, OutboundReadinessPort } from './communications/outboundPorts';

import { createInboundReadiness, type InboundRegistry, type InboundAdapter } from './communications/inboundReadiness';
import { createNativePhoneLaunchDriver, inspectNativePhoneRouteCandidate, resolveVerifiedNativePhoneHelper,
  type NativePhoneDriverOptions, type NativePhoneProcessRequest } from './communications/phoneLaunchDriver';
import { PhoneRouteSettings, createPhoneSetupService, type PhoneSetupService } from './communications/phoneRouteSettings';
import { registerPhoneSetupIpc } from './communications/registerPhoneSetupIpc';

export type PhoneInboundRegistry = InboundRegistry & {
  initialize(adapters: readonly InboundAdapter[]): void;
  replace(adapters: readonly InboundAdapter[]): void;
  register(adapter: InboundAdapter): () => void;
  reset(): void;
};
/** Startup must explicitly finish adapter discovery, including an empty result.
 * Future inbound owners register here before exposing their sending paths. */
export function createPhoneInboundRegistry(): PhoneInboundRegistry {
  let initialized = false;
  let revision = 0;
  let adapters: readonly InboundAdapter[] = Object.freeze([]);
  const replace = (next: readonly InboundAdapter[]) => {
    if (new Set(next.map(adapter => adapter.id)).size !== next.length) throw new Error('Duplicate inbound adapter');
    adapters = Object.freeze([...next]); initialized = true; ++revision;
  };
  return {
    snapshot: () => ({ initialized, revision, adapters }),
    initialize: replace,
    replace,
    register(adapter) {
      if (!initialized) throw new Error('Inbound registry is uninitialized');
      replace([...adapters, adapter]);
      let removed = false;
      return () => {
        if (removed) return;
        removed = true;
        if (adapters.includes(adapter)) replace(adapters.filter(current => current !== adapter));
      };
    },
    reset() { initialized = false; adapters = Object.freeze([]); ++revision; },
  };
}

export type PhoneBindings = {
  phone: PhoneHandoffPort;
  readiness: OutboundReadinessPort;
  setup?: PhoneSetupService;
  onSetupChanged?(callback: () => void): void;
  invalidate?(locked?: boolean): void;
  dispose?(): void;
  /** Fictional process capture only. Never exposed over IPC. */
  fixtureInvocations?: readonly NativePhoneProcessRequest[];
};
export type ProductionPhoneBindingsOptions = {
  settings: PhoneRouteSettings;
  registry: InboundRegistry;
  helper: Parameters<typeof resolveVerifiedNativePhoneHelper>[0];
  native?: Pick<NativePhoneDriverOptions, 'platform' | 'runAsync' | 'runSync'>;
  now?: () => string;
};

/** No helper/OS work at construction. The first explicit inspection verifies the
 * packaged same-team helper, shared by candidate inspection and proof-gated dispatch. */
export function createProductionPhoneBindings(input: ProductionPhoneBindingsOptions): PhoneBindings {
  let closed = false;
  const supported = (input.native?.platform ?? process.platform) === 'darwin';
  let locked = false;
  let epoch = 0;
  let inspectedEpoch: number | undefined;
  let onChange = (): void => undefined;
  let helper: Promise<string> | undefined;
  let launcher: PhoneHandoffPort | undefined;
  const unavailable = unavailablePhoneHandoff();
  const resolveHelper = () => helper ??= resolveVerifiedNativePhoneHelper(input.helper);
  const proof = () => !supported || closed || locked ? null : input.settings.read()?.fingerprint ?? null;
  const setup = createPhoneSetupService({ settings: input.settings, now: input.now ?? (() => new Date().toISOString()),
    inspectCandidate: async () => {
      if (!supported || closed || locked) return null;
      try {
        const verifiedHelperPath = await resolveHelper();
        if (!supported || closed || locked) return null;
        return inspectNativePhoneRouteCandidate({ ...input.native, verifiedHelperPath });
      } catch { return null; }
    },
    onChange: () => { ++epoch; inspectedEpoch = undefined; onChange(); },
  });
  return {
    setup,
    readiness: createInboundReadiness(input.registry),
    onSetupChanged(callback) { onChange = callback; },
    invalidate(suspended) { ++epoch; inspectedEpoch = undefined; if (suspended !== undefined) locked = suspended; setup.invalidate(suspended); },
    dispose() { closed = true; ++epoch; inspectedEpoch = undefined; setup.dispose(); },
    phone: {
      async inspectCapability() {
        const version = epoch;
        inspectedEpoch = undefined;
        if (!proof()) return unavailable.inspectCapability();
        try {
          const verifiedHelperPath = await resolveHelper();
          if (version !== epoch || !proof()) return unavailable.inspectCapability();
          launcher ??= createPhoneHandoffLauncher({
            driver: createNativePhoneLaunchDriver({ ...input.native, verifiedHelperPath, setupFingerprint: proof }),
            // Domain authorization checks DNC, jurisdiction and exact contact. The
            // launcher independently rejects short or malformed targets.
            isExcludedNumber: () => false,
          });
          const capability = await launcher.inspectCapability();
          if (version !== epoch || !proof()) return unavailable.inspectCapability();
          if (capability.state === 'available') inspectedEpoch = version;
          return capability;
        } catch { return unavailable.inspectCapability(); }
      },
      dispatch(phone) {
        const authorized = inspectedEpoch === epoch && !closed && !locked;
        inspectedEpoch = undefined;
        return authorized && launcher ? launcher.dispatch(phone) : unavailable.dispatch(phone);
      },
    },
  };
}

export function createStartupPhoneBindings(options: ApplicationStartupOptions, registry: InboundRegistry): PhoneBindings {
  const settings = new PhoneRouteSettings(join(options.userDataPath,
    options.phoneRouteMode === 'fixture' ? 'phone-route-fixture.json' : 'phone-route.json'));
  if (options.phoneRouteMode === 'fixture') {
    const invocations: NativePhoneProcessRequest[] = [];
    const reply = JSON.stringify({ version: 1, status: 'available', fingerprint: 'fictional-phone-route-v1' });
    const bindings = createProductionPhoneBindings({ settings, registry,
      helper: { path: { isPackaged: true, resourcesPath: '/Fictional/Callie.app/Contents/Resources',
        developmentExecutablePath: '/forbidden', environment: {} },
      signature: { parentExecutablePath: '/Fictional/Callie', expectedIdentifier: 'fictional.helper',
        run: async () => ({ signed: true, identifier: 'fictional.helper', teamIdentifier: 'FICTIONAL' }) } },
      native: { platform: 'darwin', runSync: () => reply, runAsync: async request => {
        if (request.args[0] === '--phone-route-open') invocations.push(request);
        return reply;
      } },
    });
    return { ...bindings, fixtureInvocations: invocations };
  }
  const bridge = options.appleBridge;
  return createProductionPhoneBindings({ settings, registry,
    helper: { path: { isPackaged: bridge?.isPackaged ?? false, resourcesPath: bridge?.resourcesPath ?? '',
      developmentExecutablePath: '/unavailable', environment: {} },
    signature: { expectedIdentifier: bridge?.expectedIdentifier ?? '', parentExecutablePath: bridge?.parentExecutablePath ?? '' } },
    native: { platform: bridge?.platform ?? process.platform },
  });
}

export type { CompanyResearchStartupConfiguration } from './research/companyResearchConfiguration';
export type StartupCompanyResearch = SelectedCompanyResearchPort & {
  prepare(commandId: string, signal: AbortSignal): Promise<{ status: 'prepared' | 'blocked'; accountIds: string[] }>;
  runNext(signal: AbortSignal): Promise<'completed' | 'parked' | 'idle'>;
};
/** Main-only composition over the actual runtime gate and C1 SQL ledger. No
 * account, grant, timer, credential read or HTTP operation occurs at construction. */
function createStartupCompanyResearch(input: { runtime: FoundationRuntime; providers: ReturnType<typeof createOutreachProviders>;
  configuration: EffectiveCompanyResearchConfiguration; assertAuthority?: (database: AppDatabase) => void; http?: PageHttp; resolve?: (hostname: string) => Promise<string[]> }) {
  const config = structuredClone(input.configuration);
  validateCompanyResearchConfiguration(config);
  const permitted = new Set(config.permittedSources);
  const receipts = createFetchedReceiptPolicy();
  let locked = false; let closed = false; let lifetime = new AbortController();
  const flights = new Set<Promise<unknown>>();
  const invalidate = (suspended?: boolean) => {
    if (suspended !== undefined) locked = suspended;
    lifetime.abort(); lifetime = new AbortController();
  };
  const stores = (signal: AbortSignal, selected?: SelectedResearch) => {
    const account = <T,>(operation: (repo: AccountRepository) => T, settlement = false) => input.runtime.withDatabase(database => {
      if (!settlement) { signal.throwIfAborted(); input.assertAuthority?.(database); }
      return operation(new AccountRepository({ database, clock: domainClock, ids: domainIds, sourcePolicy: receipts,
        research: { maxBudgetMicros: config.maxAccountBudgetMicros, knownCompanyExtraction: config.researchLimits.knownCompanyExtraction } }));
    });
    const store: AccountResearchStore = {
      create: value => account(repo => repo.create(value)), snapshot: (id, at) => account(repo => repo.snapshot(id, at)),
      admitEvidence: (batch, claim) => account(repo => repo.admitEvidence(batch, claim)), enqueue: value => account(repo => repo.enqueue(value)),
      claimNext: at => account(repo => selected ? repo.claimSelected(at, selected) : repo.claimNext(at)),
      settle: value => account(repo => repo.settle(value), true),
    };
    const discovery = <T,>(operation: (repo: SqlDiscoveryReservationStore) => T) => input.runtime.withDatabase(database => {
      signal.throwIfAborted();
      if (isLocalKnownCompanyConfiguration(config)) throw new Error('Known-company discovery unavailable');
      return operation(new SqlDiscoveryReservationStore({ database, workspaceId: config.workspaceId, clock: domainClock }));
    });
    const reservations: DiscoveryReservationStore = { reserveOnce: value => discovery(repo => repo.reserveOnce(value)), complete: value => discovery(repo => repo.complete(value)) };
    return { store, reservations };
  };
  const invoke = <T,>(signal: AbortSignal, inactive: T, operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    if (closed || locked || signal.aborted) return Promise.resolve(inactive);
    if (flights.size) return Promise.reject(new Error('Company research operation already in progress'));
    const combined = AbortSignal.any([signal, lifetime.signal]);
    const pending = operation(combined);
    flights.add(pending);
    void pending.then(() => flights.delete(pending), () => flights.delete(pending));
    return pending;
  };
  const readSelected = (selected: SelectedResearch, signal?: AbortSignal) => input.runtime.withDatabase(database => {
    signal?.throwIfAborted();
    return new AccountRepository({ database, clock: domainClock, ids: domainIds }).readSelectedResearch(selected);
  });
  const api: StartupCompanyResearch = {
    researchCompany: value => {
      // Capture identity before any await, including readiness/status acquisition.
      const selected = Object.freeze(selectedResearchSchema.parse(value));
      const held: LocalCompanyResearchStatus = { ...selected, state: 'held', receipt: null, reason: 'research_unavailable' };
      const unavailable = (saved: LocalCompanyResearchStatus, reason: string): LocalCompanyResearchStatus =>
        saved.state === 'not_recorded' ? { ...held, reason } : saved;
      // Inactive execution still reports real persisted outcomes, without claiming.
      if (closed || locked) return readSelected(selected).then(saved => unavailable(saved, 'research_inactive'));
      // The existing owner guards even the pre-enqueue read against a late original
      // invocation or double Resume. No second flight set or scheduler is created.
      return invoke<LocalCompanyResearchStatus>(lifetime.signal, held, async active => {
        const saved = await readSelected(selected, active);
        if (!permitted.size) return unavailable(saved, 'source_allowlist_unavailable');
        try { await input.runtime.withDomain((): void => undefined); }
        catch { return unavailable(saved, 'domain_unavailable'); }
        active.throwIfAborted();
        const { store } = stores(active, selected);
        if (saved.state === 'not_recorded' && config.researchLimits.knownCompanyExtraction && !input.providers.researchCompanyFacts) return unavailable(saved, 'research_unavailable');
        if (saved.state === 'not_recorded') await store.enqueue({ ...selected, limits: config.researchLimits });
        const pages = createCompanyPageProvider({ receipts, clock: domainClock, permitted: url => permitted.has(url), http: input.http, resolve: input.resolve,
          sourceUrls: [...permitted], extractFacts: config.researchLimits.knownCompanyExtraction ? input.providers.researchCompanyFacts : undefined });
        // A completed read projection can still be a running job with a committed
        // receipt. Let exact selected claiming reconcile it through the real worker.
        await createCompanyResearchWorker({ store, pages, clock: domainClock }).runNext(active);
        return readSelected(selected);
      });
    },
    prepare: (commandId, signal) => invoke(signal, { status: 'blocked', accountIds: [] }, async active => {
      // Known-account mode cannot accidentally enter paid company discovery.
      if (isLocalKnownCompanyConfiguration(config) || config.researchLimits.knownCompanyExtraction) return { status: 'blocked' as const, accountIds: [] };
      const { store, reservations } = stores(active);
      const discovery = createCompanyDiscoveryProvider({ capability: config.capability,
        request: (query, limits, requestSignal) => input.providers.researchCompanies({ query, limits, capability: config.capability }, requestSignal) });
      return createCompanyPreparation({ store, reservations, discovery, configuration: config }).prepare(commandId, active);
    }),
    runNext: signal => invoke(signal, 'idle', async active => {
      if (isLocalKnownCompanyConfiguration(config) || config.researchLimits.knownCompanyExtraction) return 'idle';
      const { store } = stores(active);
      const pages = createCompanyPageProvider({ receipts, clock: domainClock, permitted: url => permitted.has(url), http: input.http, resolve: input.resolve });
      return createCompanyResearchWorker({ store, pages, clock: domainClock }).runNext(active);
    }),
  };
  return { api, invalidate, dispose: async () => { closed = true; invalidate(true); await Promise.allSettled([...flights]); } };
}

export type ApplicationStartupDependencies = FoundationRuntimeDependencies & {
  createEmailService?(runtime:FoundationRuntime,userDataPath:string,providers?:ReturnType<typeof createOutreachProviders>,expectedWorkspaceId?:string):ReturnType<typeof createEmailService>;
  openGoogleConsent?(url:string):Promise<void>;
  createPairingStore?(userDataPath:string):Pick<PairingStore,'load'|'redeem'>;
  createResearchSetupStore?(userDataPath:string):ResearchSetupRequestStore;
  createResearchProviders?(userDataPath:string):ReturnType<typeof createOutreachProviders>;
  companyResearchHttp?: PageHttp;
  companyResearchResolve?: (hostname: string) => Promise<string[]>;
  registerOutreachIpc?:typeof registerOutreachIpc;
  registerLinkedInIpc?:typeof registerLinkedInIpc;
  createPolicyImportNative?():NonNullable<Parameters<typeof createDelegationRuntime>[0]['policyImportNative']>;
  createRequestedFollowupModel?(userDataPath:string):NonNullable<Parameters<typeof createDelegationRuntime>[0]['requestedModel']>;
  createLinkedInAdapters?(userDataPath:string):NonNullable<Parameters<typeof createDelegationRuntime>[0]['linkedIn']>;
  createDiscoveryWorker?: typeof createDiscoveryWorker;
  createOutboundCommandService?: typeof createOutboundCommandService;
  createPhoneBindings?(runtime: FoundationRuntime): PhoneBindings;
  registerPhoneSetupIpc?: typeof registerPhoneSetupIpc;
  createBackupService?(options: BackupServiceOptions): Pick<BackupService, 'start' | 'shutdown' | 'createBackup' | 'listAvailableBackups'>;
  createRecoveryService?(options: RecoveryServiceOptions): RecoveryProvider & { shutdown(): Promise<void> };
  registerApplicationIpc(
    runtime: FoundationRuntime,
    isTrustedRendererUrl: ((url: string) => boolean) | undefined,
    registrars: undefined,
    sourcingProvider: SourcingProvider,
    recoveryProvider: RecoveryProvider,
    shellProvider?: undefined,
    enrichmentRequester?: EnrichmentRequester,
    logDirectoryPath?: string,
    outbound?: OutboundCommandServiceApi,
    options?: { selectedCompanyResearch?: { current(): SelectedCompanyResearchPort | null }; companyResearchSettings?: CompanyResearchSettingsLifecycle },
  ): () => void;
  createEnrichmentRequester?(
    runtime: FoundationRuntime,
    userDataPath: string,
    logger?: SafeLogger,
  ): EnrichmentRequester;
  createSourcingPoller(
    runtime: FoundationRuntime,
    userDataPath: string,
    logger?: SafeLogger,
  ): SourcingPoller;
  createAppleBridgeSupervisor(
    options: AppleBridgeSupervisorOptions,
  ): AppleBridgeSupervisorApi;
  registerAppleSpikeIpc?(
    service: AppleSpikeServiceApi,
    isTrustedRendererUrl?: (url: string) => boolean,
  ): () => void;
};

export type ApplicationStartupOptions = {
  appVersion: string;
  userDataPath: string;
  signal?: AbortSignal;
  isTrustedRendererUrl?: (url: string) => boolean;
  appleBridge?: AppleBridgeSupervisorOptions;
  appleSpikeEnabled?: boolean;
  phoneRouteMode?: 'native' | 'fixture';
  /** Trusted paired workspace identity. Absence leaves account dispatch unavailable. */
  expectedWorkspaceId?: string;
  /** Main-only explicit configuration. C6/D3 own persisted user/campaign activation. */
  companyResearch?: CompanyResearchStartupConfiguration;
  /**
   * Auto-polls the sourcing inbox on startup plus every 15 minutes. Off by
   * default so tests and packaged E2E runs never touch the network; main.ts
   * enables it for real launches.
   */
  sourcingPollingEnabled?: boolean;
  logger?: SafeLogger;
  logDirectoryPath?: string;
  registerOutboundLifecycle?(callbacks: {
    onWake(): void;
    onLock(): void;
    onUnlock(): void;
  }): () => void;
  createWindow(): void | Promise<void>;
};

export type RunningApplication = {
  databasePath: string;
  companyResearch?: StartupCompanyResearch;
  createPreReleaseBackup(): Promise<VerifiedBackup>;
  shutdown(): Promise<void>;
};

export class ApplicationStartupCancelledError extends Error {
  constructor() {
    super('Application startup was cancelled.');
    this.name = 'ApplicationStartupCancelledError';
  }
}

const workspaceKeyStore = new WorkspaceKeyStore({
  keyProtector: new SafeStorageKeyProtector(safeStorage),
});

// Exactly one Clock and one ID generator for the application; the production
// factory closes over these same objects.
const domainClock = new SystemClock();
const domainIds = new UuidGenerator();

const SOURCING_POLL_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Production enrichment requester over the same scoped key as the poller:
 * the founder's "Find contact info" click writes exactly one request line
 * to upstream/enrichment-requests/. Missing credentials surface as a
 * validated 'credentials_unavailable' refusal, never a throw.
 */
export function createProductionEnrichmentRequester(
  runtime: FoundationRuntime,
  userDataPath: string,
  logger?: SafeLogger,
): EnrichmentRequester {
  // TEST-ONLY: exercise the real writer/gates while substituting only its external
  // transport. An invalid fixture path must fail, never fall back to host credentials.
  const fixtureDirectory = process.env.CALLIE_SOURCING_FIXTURE_DIR;
  if (fixtureDirectory !== undefined) {
    const writer = new EnrichmentRequestWriter({
      domainGate: runtime,
      createStore: async () => createFileSystemEnrichmentRequestStore(fixtureDirectory),
      clock: domainClock,
    });
    return { request: input => writer.request(input) };
  }
  const credentialStore = new SourcingCredentialStore({
    safeStorage,
    envelopePath: join(userDataPath, 'callie.sourcing-inbox-credentials.json'),
    fallbackKeyFilePath: join(homedir(), '.callie-sourcing-app-inbox-key.json'),
    clock: domainClock,
    logger,
  });
  const writer = new EnrichmentRequestWriter({
    domainGate: runtime,
    createStore: () => createS3UpstreamObjectStore({
      credentialProvider: async () => (await credentialStore.load())?.credentials ?? null,
    }),
    clock: domainClock,
  });
  return { request: (input) => writer.request(input) };
}

function createProductionSourcingPoller(
  runtime: FoundationRuntime,
  userDataPath: string,
  logger?: SafeLogger,
): SourcingPoller {
  const credentialStore = new SourcingCredentialStore({
    safeStorage,
    envelopePath: join(userDataPath, 'callie.sourcing-inbox-credentials.json'),
    fallbackKeyFilePath: join(homedir(), '.callie-sourcing-app-inbox-key.json'),
    clock: domainClock,
    logger,
  });
  const hmacSaltStore = new SourcingHmacSaltStore({
    safeStorage,
    envelopePath: join(userDataPath, 'callie.sourcing-hmac-salt.json'),
    clock: domainClock,
  });
  const upstreamSync = new UpstreamSync({
    domainGate: runtime,
    loadHmacSalt: () => hmacSaltStore.load(),
    clock: domainClock,
    batchIds: domainIds,
  });
  // TEST-ONLY escape hatch for the packaged E2E: when
  // CALLIE_SOURCING_FIXTURE_DIR points at a local directory, the poller
  // reads `events/**.ndjson` fixture files from that directory instead of
  // S3 and discards upstream uploads. Real launches never set this variable;
  // it exists so the fixture-driven spec can exercise the full poll ->
  // intake -> score pipeline without credentials or network.
  const fixtureDirectory = process.env.CALLIE_SOURCING_FIXTURE_DIR ?? null;
  const fixtureEvidence = fixtureDirectory !== null
    && process.env.CALLIE_SOURCING_FIXTURE_HANG_ONCE === '1'
    ? {
      cleanupStarted: false,
      cleanupCompleted: false,
      replacementStartedAfterCleanup: false,
      maxConcurrentExecutions: 0,
    }
    : undefined;
  let fixtureHangOnce = fixtureEvidence !== undefined;
  let fixtureActiveExecutions = 0;
  let fixtureClockAdvanced = false;
  const pollClock = fixtureEvidence === undefined ? domainClock : {
    now: () => new Date(
      Date.now() + (fixtureClockAdvanced ? 15 * 60_000 : 0),
    ).toISOString(),
  };
  return new SourcingPoller({
    domainGate: runtime,
    loadCredentials: fixtureDirectory === null
      ? () => credentialStore.load()
      : async () => ({
        credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' },
        source: 'file',
      }),
    createInboxClient: async (loaded) => {
      const store = fixtureDirectory !== null
        ? createFileSystemInboxObjectStore(fixtureDirectory)
        : await createS3InboxObjectStore({
          credentialProvider: async () => loaded.credentials,
        });
      const client = new InboxClient({ store, clock: domainClock });
      if (fixtureEvidence === undefined) return client;
      return {
        listNewObjects: async (sinceKey, signal) => {
          fixtureActiveExecutions += 1;
          fixtureEvidence.maxConcurrentExecutions = Math.max(
            fixtureEvidence.maxConcurrentExecutions,
            fixtureActiveExecutions,
          );
          if (fixtureHangOnce) {
            fixtureHangOnce = false;
            fixtureClockAdvanced = true;
            return new Promise<string[]>((_resolve, reject) => {
              signal.addEventListener('abort', () => {
                fixtureEvidence.cleanupStarted = true;
                setTimeout(() => {
                  fixtureActiveExecutions -= 1;
                  fixtureEvidence.cleanupCompleted = true;
                  reject(signal.reason);
                }, 100);
              }, { once: true });
            });
          }
          fixtureEvidence.replacementStartedAfterCleanup = fixtureEvidence.cleanupCompleted;
          try {
            return await client.listNewObjects(sinceKey, signal);
          } finally {
            fixtureActiveExecutions -= 1;
          }
        },
        fetchNdjson: (key, signal) => client.fetchNdjson(key, signal),
      };
    },
    upstream: {
      sync: upstreamSync,
      createStore: async (loaded): Promise<UpstreamObjectStore> => (
        fixtureDirectory !== null
          ? { putObjectText: async () => undefined }
          : createS3UpstreamObjectStore({
            credentialProvider: async () => loaded.credentials,
          })
      ),
      saltState: () => hmacSaltStore.state(),
      setSalt: (salt) => hmacSaltStore.set(salt),
    },
    clock: pollClock,
    fixtureExecutionEvidence: fixtureEvidence === undefined
      ? undefined
      : () => ({ ...fixtureEvidence }),
    logger,
  });
}

/** Default main-process domain factory, shared with the bounded startup integration test. */
export function createStartupDomainRuntime(database: AppDatabase, expectedWorkspaceId?: string): DomainRuntime {
  return new DomainRuntime({ database, clock: domainClock, ids: domainIds, expectedWorkspaceId });
}

const defaultDependencies: ApplicationStartupDependencies = {
  loadWorkspaceKey: (input) => workspaceKeyStore.loadOrCreate(input),
  prepareEncryptedDatabase,
  openDatabase,
  migrateToLatest,
  createDomainRuntime: createStartupDomainRuntime,
  createHealthService: (options) => new HealthService(options),
  registerApplicationIpc,
  registerOutreachIpc,
  registerLinkedInIpc,
  createPolicyImportNative:()=>createPolicyImportNativeAdapters(dialog),
  createRequestedFollowupModel:userDataPath=>async()=>{const credentials=await new CredentialStore({directory:join(userDataPath,'outreach'),safeStorage}).load();return credentials?.model.apiKey?{credentials:credentials.model,fetch:globalThis.fetch}:undefined;},
  createLinkedInAdapters:userDataPath=>({provider:createLinkedInDraftProvider({credentials:new CredentialStore({directory:join(userDataPath,'outreach'),safeStorage}),fetch:globalThis.fetch}),shell:{openExternal:url=>shell.openExternal(url)},clipboard:{writeText:text=>clipboard.writeText(text)}}),
  createResearchProviders: userDataPath => createOutreachProviders({directory:join(userDataPath,'outreach'),safeStorage,openExternal:url=>shell.openExternal(url)}),
  openGoogleConsent:url=>shell.openExternal(url),
  createPairingStore:userDataPath=>new PairingStore({directory:join(userDataPath,'delegation'),safeStorage}),
  createResearchSetupStore:userDataPath=>new ResearchSetupRequestStore({directory:join(userDataPath,'research-setup'),safeStorage}),
  createEmailService: (runtime,userDataPath,providers,expectedWorkspaceId) => createEmailService({databaseGate:runtime,expectedWorkspaceId,
    providers:providers ?? createOutreachProviders({directory:join(userDataPath,'outreach'),safeStorage,openExternal:url=>shell.openExternal(url)})}),
  createSourcingPoller: createProductionSourcingPoller,
  createEnrichmentRequester: createProductionEnrichmentRequester,
  createAppleBridgeSupervisor: (options) => new AppleBridgeSupervisor(options),
  registerAppleSpikeIpc,
  closeDatabase,
};

export async function startApplication(
  options: ApplicationStartupOptions,
  dependencies: ApplicationStartupDependencies = defaultDependencies,
): Promise<RunningApplication> {
  const trustedExpectedWorkspaceId = options.expectedWorkspaceId;
  const pairingStore=dependencies.createPairingStore?.(options.userDataPath);
  let loadedPairing:StoredPairing|null=null;
  try{if(pairingStore)loadedPairing=await pairingStore.load();}catch{/* Corrupt/locked configuration is inactive, never a default workspace. */}
  const paired=loadedPairing && (!trustedExpectedWorkspaceId||loadedPairing.workspaceId===trustedExpectedWorkspaceId)?loadedPairing:null;
  const expectedWorkspaceId = trustedExpectedWorkspaceId ?? paired?.workspaceId;
  const { databasePath, keyEnvelopePath, backupDirectory } = resolveApplicationPaths(options.userDataPath);
  const runtime = new FoundationRuntime(
    {
      appVersion: options.appVersion,
      backupDirectory,
      databasePath,
      databaseExists: encryptedWorkspaceExists(databasePath),
      keyEnvelopePath,
    },
    dependencies === defaultDependencies ? { ...dependencies,
      createDomainRuntime: database => createStartupDomainRuntime(database, expectedWorkspaceId),
    } : dependencies,
  );
  let delegation:DelegationRuntime|undefined;
  let delegationCleanup:Promise<void>|undefined;
  let email:ReturnType<typeof createEmailService>|undefined;
  let researchProviders: ReturnType<typeof createOutreachProviders> | undefined;
  let companyResearch: ReturnType<typeof createStartupCompanyResearch> | undefined;
  let researchCleanup: Promise<void> | undefined;
  let unregisterEmail:(()=>void)|undefined;
  let unregisterLinkedIn:(()=>void)|undefined;
  let unregisterApplicationIpc: (() => void) | undefined;
  let unregisterAppleSpikeIpc: (() => void) | undefined;
  let appleBridgeSupervisor: AppleBridgeSupervisorApi | undefined;
  let sourcingPoller: SourcingPoller | undefined;
  let backupService: Pick<BackupService, 'start' | 'shutdown' | 'createBackup' | 'listAvailableBackups'> | undefined;
  let recoveryService: (RecoveryProvider & { shutdown(): Promise<void> }) | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let outbound: OutboundCommandServiceApi | undefined;
  let phoneBindings: PhoneBindings | undefined;
  let startupInboundRegistry: PhoneInboundRegistry | undefined;
  let unregisterPhoneSetup: (() => void) | undefined;
  let unregisterOutboundLifecycle: (() => void) | undefined;
  let removeStartupAbort: (() => void) | undefined;
  let discoveryWorker: DiscoveryWorker | undefined;
  let discoveryClosed = false;
  let outboundClosed = false;
  let outboundLocked = false;
  const cleanupErrors: unknown[] = [];

  const closeDiscovery = (): void => {
    if (discoveryClosed) return;
    discoveryClosed = true;
    try { discoveryWorker?.stop(); } catch (error) { cleanupErrors.push(error); }
  };
  const abortStartup = (): void => { closeDiscovery(); closeOutbound(); };
  const detachOutboundLifecycle = (): void => {
    const unregister = unregisterOutboundLifecycle;
    unregisterOutboundLifecycle = undefined;
    try { unregister?.(); } catch (error) { cleanupErrors.push(error); }
  };
  const detachStartupAbort = (): void => {
    const remove = removeStartupAbort;
    removeStartupAbort = undefined;
    remove?.();
  };
  const closeOutbound = (): void => {
    if (outboundClosed) return;
    // Reserve permanent owner closure before any injected callback can reenter.
    outboundClosed = true;
    delegationCleanup=delegation?.dispose();void delegationCleanup?.catch(():undefined=>undefined);
    // Abort research before touching the single shared credential owner.
    try { researchCleanup = companyResearch?.dispose(); void researchCleanup?.catch((): undefined => undefined); } catch (error) { cleanupErrors.push(error); }
    try { email?.dispose(); } catch (error) { cleanupErrors.push(error); }
    try { researchProviders?.dispose(); } catch (error) { cleanupErrors.push(error); }
    startupInboundRegistry?.reset();
    try { phoneBindings?.dispose?.(); } catch (error) { cleanupErrors.push(error); }
    try { outbound?.dispose(); } catch (error) { cleanupErrors.push(error); }
    detachOutboundLifecycle();
    try { detachStartupAbort(); } catch (error) { cleanupErrors.push(error); }
  };

  const shutdown = (): Promise<void> => {
    if (shutdownPromise !== undefined) {
      return shutdownPromise;
    }

    // Memoize before disposal/listener callbacks, without deferring admission
    // closure to a microtask. Reentrant callers share this exact completion.
    let resolveShutdown!: () => void;
    let rejectShutdown!: (error: unknown) => void;
    shutdownPromise = new Promise<void>((resolve, reject) => {
      resolveShutdown = resolve; rejectShutdown = reject;
    });
    closeDiscovery();
    closeOutbound();
    void (async () => {
      // Preserve recovery, backup, sourcing, IPC, helper and Foundation ownership.
      let recoveryCleanup: Promise<void> | undefined;
      try {
        recoveryCleanup = recoveryService?.shutdown();
        void recoveryCleanup?.catch((): undefined => undefined);
      } catch (error) { cleanupErrors.push(error); }
      // Stop both periodic owners before awaiting either one's asynchronous work.
      let backupCleanup: Promise<void> | undefined;
      try {
        backupCleanup = backupService?.shutdown();
        void backupCleanup?.catch((): undefined => undefined);
      } catch (error) {
        cleanupErrors.push(error);
      }

      try {
        sourcingPoller?.stop();
        await sourcingPoller?.idle();
      } catch (error) {
        cleanupErrors.push(error);
      } finally {
        sourcingPoller = undefined;
      }

      try { await researchCleanup;await delegationCleanup; } catch (error) { cleanupErrors.push(error); }
      try { await discoveryWorker?.idle(); } catch (error) { cleanupErrors.push(error); }
      finally { discoveryWorker = undefined; }

      try {
        await backupCleanup;
      } catch (error) {
        cleanupErrors.push(error);
      } finally {
        backupService = undefined;
      }

      try { await recoveryCleanup; } catch (error) { cleanupErrors.push(error); }
      finally { recoveryService = undefined; }

      try { unregisterPhoneSetup?.(); } catch (error) { cleanupErrors.push(error); } finally { unregisterPhoneSetup = undefined; }
      try { unregisterLinkedIn?.(); } catch(error) { cleanupErrors.push(error); } finally { unregisterLinkedIn=undefined; }
      try { unregisterEmail?.(); } catch(error) { cleanupErrors.push(error); } finally { unregisterEmail=undefined; }
      try {
        unregisterApplicationIpc?.();
      } catch (error) {
        cleanupErrors.push(error);
      } finally {
        unregisterApplicationIpc = undefined;
      }

      try {
        unregisterAppleSpikeIpc?.();
      } catch (error) {
        cleanupErrors.push(error);
      } finally {
        unregisterAppleSpikeIpc = undefined;
      }

      try {
        await appleBridgeSupervisor?.stop();
      } catch (error) {
        cleanupErrors.push(error);
      } finally {
        appleBridgeSupervisor = undefined;
      }

      try {
        await runtime.shutdown();
      } catch (error) {
        cleanupErrors.push(error);
      }

      if (cleanupErrors.length > 1) {
        throw new AggregateError(
          cleanupErrors,
          'Application shutdown failed while releasing IPC and SQLite.',
        );
      }
      if (cleanupErrors.length === 1) {
        throw cleanupErrors[0];
      }
    })().then(resolveShutdown, rejectShutdown);

    return shutdownPromise;
  };

  try {
    throwIfStartupCancelled(options.signal);
    await runtime.initialize();
    throwIfStartupCancelled(options.signal);
    const domain: OutboundDomainGate = {
      withDomain: (operation) => runtime.withDomain((current) => operation({
        inspectOutboundCommand: (request) => current.inspectOutboundCommand(request),
        prepareOutboundDispatch: (request) => current.prepareOutboundDispatch(request),
        recordOutboundResult: (request, result) => current.recordOutboundResult(request, result),
        recordOutboundRefusal: (request, reason) => current.recordOutboundRefusal(request, reason),
      })),
    };
    if (dependencies === defaultDependencies && options.phoneRouteMode !== undefined) {
      startupInboundRegistry = createPhoneInboundRegistry();
    }
    phoneBindings = dependencies.createPhoneBindings?.(runtime)
      ?? (dependencies === defaultDependencies && options.phoneRouteMode !== undefined
        ? createStartupPhoneBindings(options, startupInboundRegistry)
        : { phone: unavailablePhoneHandoff(), readiness: unavailableOutboundReadiness() });
    outbound = (dependencies.createOutboundCommandService ?? createOutboundCommandService)({
      domain, phone: phoneBindings.phone, readiness: phoneBindings.readiness,
    });
    phoneBindings.onSetupChanged?.(() => { if (!outboundClosed) outbound.invalidate('wake'); });
    const readPairedResearch = async () => paired ? runtime.withDatabase(database => new SqlDelegationConfiguration({ database, workspaceId: paired.workspaceId, pairingId: paired.pairingId, clock: domainClock }).read()) : null;
    // One lazy credential manager belongs to startup, including null-start activation.
    researchProviders = dependencies.createResearchProviders?.(options.userDataPath);
    let reloadQueue: Promise<void> = Promise.resolve();
    let researchConfigurationEpoch = 0;
    const reloadCompanyResearch = () => {
      const epoch = ++researchConfigurationEpoch;
      companyResearch?.invalidate(true);
      const pending = reloadQueue.catch((): void => undefined).then(async () => {
        await companyResearch?.dispose(); companyResearch = undefined;
        let local;
        try { local = await runtime.withDomain(domain => domain.getCompanyResearchSettings()); }
        catch (error) {
          // An invariant-blocked domain remains diagnostics-only. Do not fall
          // back to another research policy or hide other configuration errors.
          if (error instanceof DomainRuntimeBlockedError) return;
          throw error;
        }
        const persisted = await readPairedResearch();
        const pairedResearch = persisted?.configuration.research;
        const config = local.configuration
          ? (local.configuration.state === 'active' && !pairedResearch ? local.configuration : null)
          : options.companyResearch ?? (persisted?.configuration.state === 'active' ? pairedResearch : null);
        if (config && researchProviders && !outboundClosed && epoch === researchConfigurationEpoch) {
          const assertAuthority = isLocalKnownCompanyConfiguration(config) ? (database: AppDatabase) => {
            // Recheck in the same synchronous database lease as enqueue/claim/admission.
            // A save's durable CAS can precede delivery of its composition callback.
            const row = database.raw.prepare('SELECT known_company_research_revision AS revision, known_company_research_json AS configuration FROM workspace_settings WHERE singleton=1').get() as { revision: number; configuration: string | null } | undefined;
            if (epoch !== researchConfigurationEpoch || !row || row.revision !== local.revision || row.configuration !== JSON.stringify(local.configuration)
              || (paired && new SqlDelegationConfiguration({ database, workspaceId: paired.workspaceId, pairingId: paired.pairingId, clock: domainClock }).read()?.configuration.research)) throw new Error('Research configuration changed');
          } : undefined;
          companyResearch = createStartupCompanyResearch({ runtime, providers: researchProviders, configuration: config, assertAuthority, http: dependencies.companyResearchHttp, resolve: dependencies.companyResearchResolve });
          companyResearch.invalidate(outboundLocked);
        }
      });
      reloadQueue = pending;
      return pending;
    };
    const companyResearchSettings: CompanyResearchSettingsLifecycle = {
      pairedResearchPresent: async () => !!(await readPairedResearch())?.configuration.research,
      changed: reloadCompanyResearch,
    };
    delegation=createDelegationRuntime({researchSetupStore:dependencies.createResearchSetupStore?.(options.userDataPath),openGoogleConsent:dependencies.openGoogleConsent,databaseGate:runtime,pairing:paired,clock:domainClock,phone:phoneBindings.phone,inboundRegistry:startupInboundRegistry,policyImportNative:dependencies.createPolicyImportNative?.(),requestedModel:dependencies.createRequestedFollowupModel?.(options.userDataPath),linkedIn:paired?dependencies.createLinkedInAdapters?.(options.userDataPath):undefined,configurationChanged:reloadCompanyResearch});
    await reloadCompanyResearch();
    // Email borrows the same manager without owning its disposal in research mode.
    const borrowedProviders = researchProviders ? { ...researchProviders, dispose: (): void => undefined,
      invalidate: () => { companyResearch?.invalidate(); researchProviders!.invalidate(); } } : undefined;
    email = dependencies.createEmailService?.(runtime,options.userDataPath,borrowedProviders,expectedWorkspaceId);
    if(outboundClosed)email?.dispose();
    // The composed v1 email service sends drafts but owns no inbound adapter, and
    // the optional Apple spike is not a synchronization adapter. This explicit
    // discovery result must be extended by future inbound owners before activation.
    startupInboundRegistry?.initialize(delegation?[delegation.adapter]:[]);
    if (options.signal !== undefined) {
      const signal = options.signal;
      removeStartupAbort = () => signal.removeEventListener('abort', abortStartup);
      signal.addEventListener('abort', abortStartup, { once: true });
      if (signal.aborted) abortStartup();
      throwIfStartupCancelled(signal);
    }
    unregisterOutboundLifecycle = options.registerOutboundLifecycle?.({
      onWake: () => { if (!outboundClosed) {delegation?.invalidate();companyResearch?.invalidate();phoneBindings?.invalidate?.();email?.invalidate();outbound.invalidate('wake');} },
      onLock: () => { if (!outboundClosed) {outboundLocked=true;delegation?.invalidate(true);companyResearch?.invalidate(true);phoneBindings?.invalidate?.(true);email?.invalidate(true);outbound.invalidate('lock');} },
      onUnlock: () => {
        if (outboundClosed) return;
        delegation?.invalidate(false);
        outboundLocked=false;companyResearch?.invalidate(false);
        phoneBindings?.invalidate?.(false);
        email?.invalidate(false);
        outbound.invalidate('wake');
        if (!outboundClosed) outbound.resumeAfterUnlock();
      },
    });
    // A registrar can synchronously abort before returning its owned disposer.
    if (outboundClosed) detachOutboundLifecycle();
    throwIfStartupCancelled(options.signal);
    discoveryWorker = (dependencies.createDiscoveryWorker ?? createDiscoveryWorker)({
      domainGate: runtime, clock: domainClock, research: unavailableDiscoveryResearch,
      schedule: (run, delay) => { const timer = setTimeout(run, delay); timer.unref(); return () => clearTimeout(timer); },
    });
    // An injected factory can synchronously abort before handing back ownership.
    if (discoveryClosed) discoveryWorker.stop();
    throwIfStartupCancelled(options.signal);
    discoveryWorker.start();
    throwIfStartupCancelled(options.signal);
    if (typeof dependencies.createSourcingPoller !== 'function') {
      throw new Error('Sourcing poller dependency is required.');
    }
    sourcingPoller = dependencies.createSourcingPoller(
      runtime,
      options.userDataPath,
      options.logger,
    );
    if (sourcingPoller === undefined) {
      throw new Error('Sourcing poller dependency is required.');
    }
    const startedPoller = sourcingPoller;
    runtime.setSourcingHealthProvider(() => startedPoller.getHealth());
    const backupOptions: BackupServiceOptions = {
      databaseGate: runtime,
      backupDirectory: join(options.userDataPath, 'backups'),
      // Initialization has created/migrated the database. A missing envelope
      // must never generate a replacement key for an existing workspace.
      loadWorkspaceKey: () => dependencies.loadWorkspaceKey({ envelopePath: keyEnvelopePath, databaseExists: true }),
      clock: domainClock,
      ids: domainIds,
    };
    backupService = dependencies.createBackupService?.(backupOptions) ?? new BackupService(backupOptions);
    // Key loading must not hold window startup. The service retains a safe
    // failure code and retries at the next hourly due check.
    void backupService.start().catch((): undefined => undefined);
    const recoveryOptions: RecoveryServiceOptions = {
      databaseGate: runtime, backups: backupService, liveDatabasePath: databasePath,
      loadWorkspaceKey: backupOptions.loadWorkspaceKey, clock: domainClock, ids: domainIds,
      dialogs: createRecoveryDialogs(backupOptions.backupDirectory),
    };
    recoveryService = dependencies.createRecoveryService?.(recoveryOptions) ?? new RecoveryService(recoveryOptions);
    unregisterApplicationIpc = dependencies.registerApplicationIpc(
      runtime,
      options.isTrustedRendererUrl,
      undefined,
      {
        pollNow: async () => {
          await startedPoller.pollNow();
          return startedPoller.getStatus();
        },
        status: () => startedPoller.getStatus(),
        retry: async () => {
          await startedPoller.retry();
          return startedPoller.getStatus();
        },
        setHmacSalt: async ({ salt }) => {
          await startedPoller.setHmacSalt(salt);
          return startedPoller.getStatus();
        },
      },
      recoveryService,
      undefined,
      dependencies.createEnrichmentRequester?.(
        runtime,
        options.userDataPath,
        options.logger,
      ),
      options.logDirectoryPath,
      outbound,
      { selectedCompanyResearch: { current: () => companyResearch?.api ?? null }, companyResearchSettings },
    );
    if (phoneBindings.setup) unregisterPhoneSetup = (dependencies.registerPhoneSetupIpc ?? registerPhoneSetupIpc)({
      provider: phoneBindings.setup, isTrustedRendererUrl: options.isTrustedRendererUrl,
    });
    if(delegation.linkedIn)unregisterLinkedIn=(dependencies.registerLinkedInIpc??registerLinkedInIpc)({provider:delegation.linkedIn,isTrustedRendererUrl:options.isTrustedRendererUrl});
    if(email)unregisterEmail=(dependencies.registerOutreachIpc??registerOutreachIpc)({provider:email,delegation,pairingStore,isTrustedRendererUrl:options.isTrustedRendererUrl});
    throwIfStartupCancelled(options.signal);
    if (options.sourcingPollingEnabled === true && sourcingPoller !== undefined) {
      const timer: PollTimer = {
        schedule: (callback) => {
          const interval = setInterval(callback, SOURCING_POLL_INTERVAL_MS);
          interval.unref();
          return () => clearInterval(interval);
        },
      };
      // Startup never blocks on the network: the initial poll runs detached.
      void sourcingPoller.start(timer);
    }
    throwIfStartupCancelled(options.signal);
    if (options.appleBridge !== undefined) {
      appleBridgeSupervisor = dependencies.createAppleBridgeSupervisor(
        options.appleBridge,
      );
      try {
        const helperStartup = appleBridgeSupervisor.start();
        void helperStartup.catch((): undefined => undefined);
      } catch {
        // Apple integration is optional; supervisor status remains the safe diagnostic.
      }
      unregisterAppleSpikeIpc = dependencies.registerAppleSpikeIpc?.(
        new AppleSpikeService({
          enabled: options.appleSpikeEnabled === true,
          bridge: appleBridgeSupervisor,
        }),
        options.isTrustedRendererUrl,
      );
      throwIfStartupCancelled(options.signal);
    }
    await options.createWindow();
    throwIfStartupCancelled(options.signal);
    detachStartupAbort();

    return {
      databasePath,
      get companyResearch(){return companyResearch?.api;},
      createPreReleaseBackup: async () => {
        if (shutdownPromise !== undefined || backupService === undefined) {
          throw new Error('Application backups are unavailable.');
        }
        return backupService.createBackup('pre_release');
      },
      shutdown,
    };
  } catch (startupError) {
    try {
      await shutdown();
    } catch (cleanupError) {
      throw new AggregateError(
        [startupError, cleanupError],
        'Application startup and cleanup both failed.',
        { cause: startupError },
      );
    }

    throw startupError;
  }
}

function throwIfStartupCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new ApplicationStartupCancelledError();
  }
}

function createRecoveryDialogs(backupDirectory: string): RecoveryDialogs {
  return {
    saveMaterial: async () => {
      const result = await dialog.showSaveDialog({ title: 'Save private recovery material', defaultPath: 'callie-recovery.txt', filters: [{ name: 'Recovery material', extensions: ['txt'] }] });
      return result.canceled ? null : result.filePath ?? null;
    },
    selectBackup: async () => {
      const result = await dialog.showOpenDialog({ title: 'Select a verified Callie backup', defaultPath: backupDirectory, properties: ['openFile'], filters: [{ name: 'Encrypted backup', extensions: ['sqlite3'] }] });
      return result.canceled ? null : result.filePaths[0] ?? null;
    },
    selectMaterial: async () => {
      const result = await dialog.showOpenDialog({ title: 'Select your saved private recovery material', properties: ['openFile'], filters: [{ name: 'Recovery material', extensions: ['txt'] }] });
      return result.canceled ? null : result.filePaths[0] ?? null;
    },
  };
}

/** Only native main-process dialogs choose bytes and confirm exact review data.
 * No renderer-provided path, raw artifact or approval boolean crosses this seam. */
export function createPolicyImportNativeAdapters(dialogs:Pick<typeof dialog,'showOpenDialog'|'showMessageBox'>):NonNullable<Parameters<typeof createDelegationRuntime>[0]['policyImportNative']>{
 return {
  async selectArtifact(maxBytes,signal){
   signal.throwIfAborted();const selected=await dialogs.showOpenDialog({title:'Select owner-review evidence interchange',properties:['openFile'],filters:[{name:'FSS evidence JSON',extensions:['json']}]});signal.throwIfAborted();
   if(selected.canceled)return null;if(selected.filePaths.length!==1)throw Error('policy_import_selection_invalid');
   const file=await openNativeFile(selected.filePaths[0],fsConstants.O_RDONLY|fsConstants.O_NOFOLLOW);
   try{const before=await file.stat();if(!before.isFile()||before.size<=0||before.size>maxBytes)throw Error('policy_import_size_invalid');
    const bytes=Buffer.alloc(maxBytes+1);let offset=0;
    while(offset<bytes.length){signal.throwIfAborted();const result=await file.read(bytes,offset,bytes.length-offset,offset);if(result.bytesRead===0)break;offset+=result.bytesRead;}
    const after=await file.stat();signal.throwIfAborted();if(offset!==before.size||offset>maxBytes||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw Error('policy_import_file_changed');
    return bytes.subarray(0,offset);
   }finally{await file.close();}
  },
  async confirmReview({preview,reviewReason},signal){
   signal.throwIfAborted();const result=await dialogs.showMessageBox({type:'warning',title:'Review exact imported evidence',message:preview.notice,
    detail:JSON.stringify({artifactHash:preview.artifactHash,reviewId:preview.reviewId,reviewReason,artifact:preview.artifact,rowHashes:preview.artifact.rows.map(row=>({rowId:row.rowId,sha256:accountFingerprint(row)})),rows:preview.rows},null,2),buttons:['Cancel','Record this exact review'],defaultId:0,cancelId:0,noLink:true});
   signal.throwIfAborted();return result.response===1;
  },
 };
}
