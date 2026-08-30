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
export const CALLIE_APPLE_BRIDGE_UNCONFIGURED_TEAM = 'UNCONFIGURED';

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
  expectedTeamIdentifier: string;
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
  #client: AppleBridgeClientApi | undefined;
  #transport: AppleBridgeTransport | undefined;
  #unsubscribeTransport: (() => void) | undefined;

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
      this.#startPromise = this.#startOnce();
    }
    return this.#startPromise;
  }

  getStatus(): AppleBridgeStatus {
    return this.#status;
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
      this.#stopPromise = this.#stopOnce();
    }
    return this.#stopPromise;
  }

  async #startOnce(): Promise<void> {
    if (this.#stopRequested || this.options.platform !== 'darwin') {
      return;
    }

    const developmentExecutablePath = this.#developmentExecutablePath();
    if (!this.options.isPackaged && developmentExecutablePath === undefined) {
      return;
    }
    this.#status = { state: 'starting' };

    try {
      await prepareStagingRoot(
        this.options.stagingRoot,
        this.dependencies,
      );
    } catch {
      this.#status = DEGRADED.staging;
      return;
    }
    if (this.#stopRequested) return;

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
      this.#status = DEGRADED.resolution;
      return;
    }

    try {
      await this.dependencies.verifySignature({
        executablePath,
        isPackaged: this.options.isPackaged,
        expectedIdentifier: this.options.expectedIdentifier,
        expectedTeamIdentifier: this.options.expectedTeamIdentifier,
        allowUnsignedDevelopment: this.options.allowUnsignedDevelopment,
      });
    } catch {
      this.#status = DEGRADED.verification;
      return;
    }
    if (this.#stopRequested) return;

    try {
      this.#transport = this.dependencies.spawnTransport(
        executablePath,
        this.options.stagingRoot,
      );
      this.#unsubscribeTransport = this.#transport.subscribe((event) => {
        this.#handleTransportEvent(event);
      });
    } catch {
      this.#status = DEGRADED.launch;
      return;
    }

    try {
      this.#client = this.dependencies.createClient(this.#transport);
      const ready = await this.#client.ready();
      if (this.#stopRequested) return;
      this.#status = {
        state: 'ready',
        helperVersion: ready.helperVersion,
        protocolVersion: ready.protocolVersion,
      };
    } catch {
      if (!this.#stopRequested) this.#status = DEGRADED.handshake;
      this.#releaseFailedLaunch();
    }
  }

  async #stopOnce(): Promise<void> {
    await this.#startPromise?.catch((): undefined => undefined);
    this.#unsubscribeTransport?.();
    this.#unsubscribeTransport = undefined;

    const client = this.#client;
    const transport = this.#transport;
    this.#client = undefined;
    this.#transport = undefined;

    try {
      await client?.shutdown();
      this.#status = this.#disabledStatus();
    } catch {
      try {
        transport?.terminate();
      } catch {
        // The fixed cleanup failure remains authoritative.
      }
      this.#status = DEGRADED.shutdown;
      throw new Error('Apple integration helper cleanup failed.');
    }
  }

  #handleTransportEvent(event: AppleBridgeProcessEvent): void {
    if (this.#stopRequested || this.#status.state !== 'ready') return;
    if (event.type === 'exit') {
      this.#status = DEGRADED.exit;
    } else if (event.type === 'failure') {
      this.#status = DEGRADED.transport;
    }
  }

  #releaseFailedLaunch(): void {
    this.#unsubscribeTransport?.();
    this.#unsubscribeTransport = undefined;
    try {
      this.#transport?.terminate();
    } catch {
      // Startup remains degraded even when process teardown races.
    }
    this.#client = undefined;
    this.#transport = undefined;
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
