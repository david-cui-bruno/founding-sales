import { lstat, mkdir } from 'node:fs/promises';

import {
  AppleBridgeClient,
  type AppleBridgeClientApi,
} from './appleBridgeClient';
import {
  AppleBridgeProcess,
  spawnAppleBridge,
  type AppleBridgeProcessEvent,
  type AppleBridgeTransport,
} from './appleBridgeProcess';
import {
  SupervisedAppleBridgeService,
  type AppleBridgeService,
  type AppleBridgeStatus,
} from './appleBridgeService';
import {
  resolveAppleBridgeExecutable,
  type AppleBridgeExecutableOptions,
} from './helperPath';
import {
  verifyHelperSignature,
  type HelperSignature,
  type VerifyHelperSignatureOptions,
} from './verifyHelperSignature';
import type {
  BridgeEvent,
  BridgeRequest,
  BridgeResponse,
} from '../../shared/appleBridgeContract';

export type { AppleBridgeStatus } from './appleBridgeService';

export const CALLIE_APPLE_BRIDGE_IDENTIFIER =
  'com.callie.foundersales.applebridge';

type StagingStat = {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  mode: number;
  uid: number;
};

export type AppleBridgeSupervisorOptions = {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  resourcesPath: string;
  developmentExecutablePath?: string;
  allowDevelopmentOverride?: boolean;
  allowUnsignedDevelopment?: boolean;
  environment: Readonly<Record<string, string | undefined>>;
  stagingRoot: string;
  expectedIdentifier: string;
  parentExecutablePath: string;
};

export type AppleBridgeSupervisorDependencies = {
  mkdir(
    path: string,
    options: { recursive: true; mode: number },
  ): Promise<unknown>;
  lstat(path: string): Promise<StagingStat>;
  getEffectiveUserId(): number | undefined;
  resolveExecutable(options: AppleBridgeExecutableOptions): string;
  verifySignature(
    options: VerifyHelperSignatureOptions,
  ): Promise<HelperSignature>;
  spawnTransport(executablePath: string, stagingRoot: string): AppleBridgeTransport;
  createClient(transport: AppleBridgeTransport): AppleBridgeClientApi;
};

export interface AppleBridgeSupervisorApi extends AppleBridgeService {
  start(): Promise<void>;
  stop(): Promise<void>;
}

const defaultDependencies: AppleBridgeSupervisorDependencies = {
  mkdir,
  lstat,
  getEffectiveUserId: () => process.getuid?.(),
  resolveExecutable: resolveAppleBridgeExecutable,
  verifySignature: verifyHelperSignature,
  spawnTransport: (executablePath, stagingRoot) => new AppleBridgeProcess(
    spawnAppleBridge(executablePath, stagingRoot),
  ),
  createClient: (transport) => new AppleBridgeClient(transport),
};

const DEGRADED = {
  staging: {
    state: 'degraded',
    code: 'staging_unavailable',
    message: 'Apple integration staging is unavailable.',
  },
  resolution: {
    state: 'degraded',
    code: 'helper_resolution_failed',
    message: 'Apple integration helper could not be located.',
  },
  verification: {
    state: 'degraded',
    code: 'helper_verification_failed',
    message: 'Apple integration helper failed verification.',
  },
  launch: {
    state: 'degraded',
    code: 'helper_launch_failed',
    message: 'Apple integration helper could not be launched.',
  },
  handshake: {
    state: 'degraded',
    code: 'handshake_failed',
    message: 'Apple integration helper did not complete its handshake.',
  },
  exit: {
    state: 'degraded',
    code: 'helper_exited',
    message: 'Apple integration helper stopped unexpectedly.',
  },
  transport: {
    state: 'degraded',
    code: 'helper_transport_failed',
    message: 'Apple integration helper connection failed.',
  },
  shutdown: {
    state: 'degraded',
    code: 'helper_shutdown_failed',
    message: 'Apple integration helper cleanup failed.',
  },
} as const satisfies Record<string, AppleBridgeStatus>;

export class AppleBridgeSupervisor implements AppleBridgeSupervisorApi {
  readonly #service: SupervisedAppleBridgeService;
  #status: AppleBridgeStatus;
  #startPromise: Promise<void> | undefined;
  #stopPromise: Promise<void> | undefined;
  #stopRequested = false;
  #generation = 0;
  #client: AppleBridgeClientApi | undefined;
  #transport: AppleBridgeTransport | undefined;
  #unsubscribeTransport: (() => void) | undefined;
  #terminalDuringStart: AppleBridgeStatus | undefined;
  #readyPublished = false;

  constructor(
    readonly options: AppleBridgeSupervisorOptions,
    private readonly dependencies: AppleBridgeSupervisorDependencies =
      defaultDependencies,
  ) {
    this.#status = this.#disabledStatus();
    this.#service = new SupervisedAppleBridgeService({
      getStatus: () => this.getStatus(),
      getClient: () => this.#client,
    });
  }

  start(): Promise<void> {
    if (this.#startPromise === undefined) {
      const generation = ++this.#generation;
      this.#startPromise = this.#startOnce(generation);
    }
    return this.#startPromise;
  }

  getStatus(): AppleBridgeStatus {
    return Object.freeze({ ...this.#status }) as AppleBridgeStatus;
  }

  request<T extends BridgeRequest>(
    request: T,
    timeoutMs?: number,
  ): Promise<BridgeResponse> {
    return this.#service.request(request, timeoutMs);
  }

  subscribe(listener: (event: BridgeEvent) => void): () => void {
    return this.#service.subscribe(listener);
  }

  stop(): Promise<void> {
    if (this.#stopPromise === undefined) {
      this.#stopRequested = true;
      this.#generation += 1;
      this.#stopPromise = this.#stopOnce();
    }
    return this.#stopPromise;
  }

  async #startOnce(generation: number): Promise<void> {
    if (!this.#isActive(generation) || this.options.platform !== 'darwin') {
      return;
    }

    const developmentExecutablePath = this.#developmentExecutablePath();
    if (!this.options.isPackaged && developmentExecutablePath === undefined) {
      return;
    }
    this.#status = { state: 'starting' };
    this.#terminalDuringStart = undefined;
    this.#readyPublished = false;

    try {
      await prepareStagingRoot(
        this.options.stagingRoot,
        this.dependencies,
      );
    } catch {
      if (this.#isActive(generation)) this.#status = DEGRADED.staging;
      return;
    }
    if (!this.#isActive(generation)) return;

    let executablePath: string;
    try {
      executablePath = this.dependencies.resolveExecutable({
        isPackaged: this.options.isPackaged,
        resourcesPath: this.options.resourcesPath,
        developmentExecutablePath: developmentExecutablePath ?? '',
        allowDevelopmentOverride: false,
        environment: {},
      });
    } catch {
      if (this.#isActive(generation)) this.#status = DEGRADED.resolution;
      return;
    }
    if (!this.#isActive(generation)) return;

    try {
      await this.dependencies.verifySignature({
        executablePath,
        parentExecutablePath: this.options.parentExecutablePath,
        isPackaged: this.options.isPackaged,
        expectedIdentifier: this.options.expectedIdentifier,
        allowUnsignedDevelopment: this.options.allowUnsignedDevelopment,
      });
    } catch {
      if (this.#isActive(generation)) this.#status = DEGRADED.verification;
      return;
    }
    if (!this.#isActive(generation)) return;

    let transport: AppleBridgeTransport;
    try {
      transport = this.dependencies.spawnTransport(
        executablePath,
        this.options.stagingRoot,
      );
    } catch {
      if (this.#isActive(generation)) this.#status = DEGRADED.launch;
      return;
    }
    if (!this.#isActive(generation)) {
      terminateTransport(transport);
      return;
    }

    this.#transport = transport;
    try {
      this.#unsubscribeTransport = transport.subscribe((event) => {
        this.#handleTransportEvent(event);
      });
    } catch {
      this.#releaseOwnedAfterStartFailure(transport);
      if (this.#isActive(generation)) this.#status = DEGRADED.launch;
      return;
    }
    if (!this.#isActive(generation)) {
      this.#releaseOwnedAfterStartFailure(transport);
      return;
    }

    let client: AppleBridgeClientApi;
    try {
      client = this.dependencies.createClient(transport);
      this.#client = client;
    } catch {
      this.#releaseOwnedAfterStartFailure(transport);
      if (this.#isActive(generation)) this.#status = DEGRADED.handshake;
      return;
    }

    try {
      const ready = await client.ready();
      if (!this.#isActive(generation)) return;
      if (this.#terminalDuringStart !== undefined) {
        this.#status = this.#terminalDuringStart;
        this.#releaseOwnedAfterStartFailure(transport);
        return;
      }
      this.#status = {
        state: 'ready',
        helperVersion: ready.helperVersion,
        protocolVersion: ready.protocolVersion,
      };
      this.#readyPublished = true;
    } catch {
      if (this.#isActive(generation)) {
        this.#status = this.#terminalDuringStart ?? DEGRADED.handshake;
      }
      this.#releaseOwnedAfterStartFailure(transport);
    }
  }

  async #stopOnce(): Promise<void> {
    const readyWasPublished = this.#readyPublished;
    this.#readyPublished = false;
    const { client, transport } = this.#takeOwnedResources();
    this.#status = this.#disabledStatus();

    if (!readyWasPublished) {
      if (client !== undefined) {
        beginClientShutdown(client);
      }
      terminateTransport(transport);
      return;
    }

    try {
      if (client !== undefined) {
        await client.shutdown();
      }
    } catch {
      terminateTransport(transport);
      this.#status = DEGRADED.shutdown;
      throw new Error('Apple integration helper cleanup failed.');
    }
  }

  #handleTransportEvent(event: AppleBridgeProcessEvent): void {
    if (this.#stopRequested) return;
    const terminalStatus = event.type === 'exit'
      ? DEGRADED.exit
      : event.type === 'failure'
        ? DEGRADED.transport
        : undefined;
    if (terminalStatus === undefined) return;
    if (this.#status.state === 'starting') {
      this.#terminalDuringStart ??= terminalStatus;
      this.#status = this.#terminalDuringStart;
    } else if (this.#status.state === 'ready') {
      this.#status = terminalStatus;
    }
  }

  #releaseOwnedAfterStartFailure(transport: AppleBridgeTransport): void {
    if (this.#transport !== transport) return;
    const { client, transport: ownedTransport } = this.#takeOwnedResources();
    if (client !== undefined) {
      beginClientShutdown(client);
    }
    terminateTransport(ownedTransport);
  }

  #takeOwnedResources(): {
    client: AppleBridgeClientApi | undefined;
    transport: AppleBridgeTransport | undefined;
  } {
    const unsubscribeTransport = this.#unsubscribeTransport;
    this.#unsubscribeTransport = undefined;
    try {
      unsubscribeTransport?.();
    } catch {
      // Resource ownership is still cleared and the transport is still cleaned.
    }
    const client = this.#client;
    const transport = this.#transport;
    this.#client = undefined;
    this.#transport = undefined;
    return { client, transport };
  }

  #isActive(generation: number): boolean {
    return !this.#stopRequested && this.#generation === generation;
  }

  #developmentExecutablePath(): string | undefined {
    if (this.options.developmentExecutablePath !== undefined) {
      return this.options.developmentExecutablePath;
    }
    if (this.options.allowDevelopmentOverride === true) {
      return this.options.environment.CALLIE_APPLE_BRIDGE_PATH;
    }
    return undefined;
  }

  #disabledStatus(): AppleBridgeStatus {
    return this.options.platform === 'darwin'
      ? { state: 'disabled', reason: 'not_packaged_or_configured' }
      : { state: 'disabled', reason: 'unsupported_platform' };
  }
}

function terminateTransport(transport: AppleBridgeTransport | undefined): void {
  try {
    transport?.terminate();
  } catch {
    // The fixed lifecycle state remains authoritative when termination races.
  }
}

function beginClientShutdown(client: AppleBridgeClientApi): void {
  try {
    void client.shutdown().catch((): undefined => undefined);
  } catch {
    // Forced transport termination below remains the fail-closed cleanup path.
  }
}

async function prepareStagingRoot(
  stagingRoot: string,
  dependencies: Pick<
    AppleBridgeSupervisorDependencies,
    'mkdir' | 'lstat' | 'getEffectiveUserId'
  >,
): Promise<void> {
  await dependencies.mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  const [stat, effectiveUserId] = await Promise.all([
    dependencies.lstat(stagingRoot),
    Promise.resolve(dependencies.getEffectiveUserId()),
  ]);
  if (
    effectiveUserId === undefined
    || stat.isSymbolicLink()
    || !stat.isDirectory()
    || (stat.mode & 0o7777) !== 0o700
    || stat.uid !== effectiveUserId
  ) {
    throw new Error('Apple bridge staging root failed private-directory checks.');
  }
}
