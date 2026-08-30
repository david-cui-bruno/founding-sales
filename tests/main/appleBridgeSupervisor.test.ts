import { describe, expect, it } from 'vitest';

import {
  AppleBridgeSupervisor,
  type AppleBridgeStatus,
  type AppleBridgeSupervisorDependencies,
  type AppleBridgeSupervisorOptions,
} from '../../src/main/appleBridge/appleBridgeSupervisor';
import type { AppleBridgeClientApi } from '../../src/main/appleBridge/appleBridgeClient';
import type {
  AppleBridgeProcessEvent,
  AppleBridgeTransport,
} from '../../src/main/appleBridge/appleBridgeProcess';
import type { AppleBridgeExecutableOptions } from '../../src/main/appleBridge/helperPath';
import type { VerifyHelperSignatureOptions } from '../../src/main/appleBridge/verifyHelperSignature';
import type {
  BridgeRequest,
  BridgeResponse,
} from '../../src/shared/appleBridgeContract';

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const READY = { helperVersion: '1.4.0-test', protocolVersion: 1 } as const;

class FakeTransport implements AppleBridgeTransport {
  readonly listeners = new Set<(event: AppleBridgeProcessEvent) => void>();
  terminateCalls = 0;

  subscribe(listener: (event: AppleBridgeProcessEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  writeFrame(): void {}

  closeInput(): void {}

  terminate(): void {
    this.terminateCalls += 1;
  }

  emit(event: AppleBridgeProcessEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}

type ClientHarness = AppleBridgeClientApi & {
  requestCalls: BridgeRequest[];
  shutdownCalls: number;
};

function createClient(
  options: {
    ready?: () => Promise<typeof READY>;
    request?: (request: BridgeRequest) => Promise<BridgeResponse>;
    shutdown?: () => Promise<void>;
  } = {},
): ClientHarness {
  const requestCalls: BridgeRequest[] = [];
  let shutdownCalls = 0;
  return {
    ready: options.ready ?? (async () => READY),
    request: async (request) => {
      requestCalls.push(request);
      return options.request?.(request) ?? {
        v: 1,
        kind: 'response',
        id: request.id,
        ok: true,
        result: {},
      };
    },
    subscribe: () => () => undefined,
    shutdown: async () => {
      shutdownCalls += 1;
      await options.shutdown?.();
    },
    requestCalls,
    get shutdownCalls() {
      return shutdownCalls;
    },
  };
}

const baseOptions = (
  overrides: Partial<AppleBridgeSupervisorOptions> = {},
): AppleBridgeSupervisorOptions => ({
  platform: 'darwin',
  isPackaged: true,
  resourcesPath: '/Applications/Callie.app/Contents/Resources',
  environment: {},
  stagingRoot: '/Users/founder/Library/Application Support/Callie/apple-bridge-staging',
  expectedIdentifier: 'com.callie.foundersales.applebridge',
  expectedTeamIdentifier: 'TEAM123456',
  ...overrides,
});

function createHarness(overrides: {
  client?: ClientHarness;
  dependencies?: Partial<AppleBridgeSupervisorDependencies>;
} = {}): {
  calls: string[];
  captured: {
    lstatPath?: string;
    resolvedOptions?: AppleBridgeExecutableOptions;
    signatureOptions?: VerifyHelperSignatureOptions;
    spawn?: readonly [string, string];
  };
  client: ClientHarness;
  dependencies: AppleBridgeSupervisorDependencies;
  transport: FakeTransport;
} {
  const calls: string[] = [];
  const captured: {
    lstatPath?: string;
    resolvedOptions?: AppleBridgeExecutableOptions;
    signatureOptions?: VerifyHelperSignatureOptions;
    spawn?: readonly [string, string];
  } = {};
  const client = overrides.client ?? createClient();
  const transport = new FakeTransport();
  const dependencies: AppleBridgeSupervisorDependencies = {
    mkdir: async (_path, options) => {
      calls.push(`mkdir:${options.mode.toString(8)}`);
    },
    lstat: async (path) => {
      captured.lstatPath = path;
      return {
        isDirectory: () => true,
        isSymbolicLink: () => false,
        mode: 0o40700,
        uid: 501,
      };
    },
    getEffectiveUserId: () => 501,
    resolveExecutable: (options) => {
      calls.push('resolve');
      captured.resolvedOptions = options;
      return '/Applications/Callie.app/Contents/Helpers/Callie Apple Bridge.app/Contents/MacOS/CallieAppleBridge';
    },
    verifySignature: async (options) => {
      calls.push('verify');
      captured.signatureOptions = options;
      return {
        signed: true,
        identifier: 'com.callie.foundersales.applebridge',
        teamIdentifier: 'TEAM123456',
      };
    },
    spawnTransport: (executablePath, stagingRoot) => {
      calls.push('spawn');
      captured.spawn = [executablePath, stagingRoot];
      return transport;
    },
    createClient: () => {
      calls.push('client');
      return client;
    },
    ...overrides.dependencies,
  };
  return { calls, captured, client, dependencies, transport };
}

function expectNoPrivateDiagnostics(status: AppleBridgeStatus): void {
  const encoded = JSON.stringify(status);
  expect(encoded).not.toContain('/Users/founder/private');
  expect(encoded).not.toContain('+15555550100');
  expect(encoded).not.toContain('founder@example.com');
  expect(encoded).not.toContain('raw stderr');
}

describe('AppleBridgeSupervisor', () => {
  it('disables unsupported platforms without touching files, signature, or process boundaries', async () => {
    const harness = createHarness();
    const supervisor = new AppleBridgeSupervisor(
      baseOptions({ platform: 'linux' }),
      harness.dependencies,
    );

    await Promise.all([supervisor.start(), supervisor.start()]);
    await Promise.all([supervisor.stop(), supervisor.stop()]);

    expect(supervisor.getStatus()).toEqual({
      state: 'disabled',
      reason: 'unsupported_platform',
    });
    expect(harness.calls).toEqual([]);
  });

  it('disables an unpackaged macOS build without an explicitly configured helper', async () => {
    const harness = createHarness();
    const supervisor = new AppleBridgeSupervisor(
      baseOptions({ isPackaged: false, resourcesPath: '/unused' }),
      harness.dependencies,
    );

    await supervisor.start();

    expect(supervisor.getStatus()).toEqual({
      state: 'disabled',
      reason: 'not_packaged_or_configured',
    });
    expect(harness.calls).toEqual([]);
  });

  it('verifies private staging and signature before spawning, then exposes exact hello metadata', async () => {
    const harness = createHarness();
    const supervisor = new AppleBridgeSupervisor(baseOptions(), harness.dependencies);

    await Promise.all([supervisor.start(), supervisor.start()]);

    expect(harness.calls).toEqual([
      'mkdir:700',
      'resolve',
      'verify',
      'spawn',
      'client',
    ]);
    expect(harness.captured).toEqual({
      lstatPath: '/Users/founder/Library/Application Support/Callie/apple-bridge-staging',
      resolvedOptions: {
        isPackaged: true,
        resourcesPath: '/Applications/Callie.app/Contents/Resources',
        developmentExecutablePath: '',
        allowDevelopmentOverride: false,
        environment: {},
      },
      signatureOptions: {
        executablePath: '/Applications/Callie.app/Contents/Helpers/Callie Apple Bridge.app/Contents/MacOS/CallieAppleBridge',
        isPackaged: true,
        expectedIdentifier: 'com.callie.foundersales.applebridge',
        expectedTeamIdentifier: 'TEAM123456',
        allowUnsignedDevelopment: undefined,
      },
      spawn: [
        '/Applications/Callie.app/Contents/Helpers/Callie Apple Bridge.app/Contents/MacOS/CallieAppleBridge',
        '/Users/founder/Library/Application Support/Callie/apple-bridge-staging',
      ],
    });
    expect(supervisor.getStatus()).toEqual({
      state: 'ready',
      helperVersion: '1.4.0-test',
      protocolVersion: 1,
    });
    expect(harness.client.requestCalls).toEqual([]);
  });

  it.each([
    ['symbolic link', { isDirectory: () => true, isSymbolicLink: () => true, mode: 0o40700, uid: 501 }],
    ['non-directory', { isDirectory: () => false, isSymbolicLink: () => false, mode: 0o100700, uid: 501 }],
    ['wrong mode', { isDirectory: () => true, isSymbolicLink: () => false, mode: 0o40755, uid: 501 }],
    ['special mode bits', { isDirectory: () => true, isSymbolicLink: () => false, mode: 0o44700, uid: 501 }],
    ['wrong owner', { isDirectory: () => true, isSymbolicLink: () => false, mode: 0o40700, uid: 502 }],
  ])('fails closed before helper resolution when staging is a %s', async (_label, stat) => {
    const harness = createHarness({
      dependencies: { lstat: async () => stat },
    });
    const supervisor = new AppleBridgeSupervisor(baseOptions(), harness.dependencies);

    await supervisor.start();

    expect(supervisor.getStatus()).toEqual({
      state: 'degraded',
      code: 'staging_unavailable',
      message: 'Apple integration staging is unavailable.',
    });
    expect(harness.calls).toEqual(['mkdir:700']);
  });

  it.each([
    [
      'helper_resolution_failed',
      'Apple integration helper could not be located.',
      'resolveExecutable',
      ['mkdir:700'],
    ],
    [
      'helper_verification_failed',
      'Apple integration helper failed verification.',
      'verifySignature',
      ['mkdir:700', 'resolve'],
    ],
    [
      'helper_launch_failed',
      'Apple integration helper could not be launched.',
      'spawnTransport',
      ['mkdir:700', 'resolve', 'verify'],
    ],
    [
      'handshake_failed',
      'Apple integration helper did not complete its handshake.',
      'createClient',
      ['mkdir:700', 'resolve', 'verify', 'spawn', 'client'],
    ],
  ] as const)(
    'maps private %s diagnostics to a fixed degraded status',
    async (code, message, failingBoundary, expectedCalls) => {
      const secret = new Error(
        '/Users/founder/private +15555550100 founder@example.com raw stderr',
      );
      const client = createClient({ ready: async () => { throw secret; } });
      const boundaryFailure = (): never => { throw secret; };
      const harness = createHarness({
        client,
        dependencies: failingBoundary === 'createClient'
          ? undefined
          : { [failingBoundary]: boundaryFailure },
      });
      const supervisor = new AppleBridgeSupervisor(baseOptions(), harness.dependencies);

      await supervisor.start();

      expect(supervisor.getStatus()).toEqual({ state: 'degraded', code, message });
      expectNoPrivateDiagnostics(supervisor.getStatus());
      expect(harness.calls).toEqual(expectedCalls);
    },
  );

  it('moves a ready helper to sanitized degraded state after an unexpected process exit', async () => {
    const harness = createHarness();
    const supervisor = new AppleBridgeSupervisor(baseOptions(), harness.dependencies);
    await supervisor.start();

    harness.transport.emit({ type: 'exit', code: 73, signal: null });

    expect(supervisor.getStatus()).toEqual({
      state: 'degraded',
      code: 'helper_exited',
      message: 'Apple integration helper stopped unexpectedly.',
    });
    expect(JSON.stringify(supervisor.getStatus())).not.toContain('73');
  });

  it('moves a ready helper to sanitized degraded state after a transport failure', async () => {
    const harness = createHarness();
    const supervisor = new AppleBridgeSupervisor(baseOptions(), harness.dependencies);
    await supervisor.start();

    harness.transport.emit({
      type: 'failure',
      error: new Error('/Users/founder/private raw stderr'),
    });

    expect(supervisor.getStatus()).toEqual({
      state: 'degraded',
      code: 'helper_transport_failed',
      message: 'Apple integration helper connection failed.',
    });
    expectNoPrivateDiagnostics(supervisor.getStatus());
  });

  it.each([
    [
      'exit',
      { type: 'exit', code: 73, signal: null } as const,
      {
        state: 'degraded',
        code: 'helper_exited',
        message: 'Apple integration helper stopped unexpectedly.',
      } as const,
    ],
    [
      'failure',
      {
        type: 'failure',
        error: new Error('/Users/founder/private raw stderr'),
      } as const,
      {
        state: 'degraded',
        code: 'helper_transport_failed',
        message: 'Apple integration helper connection failed.',
      } as const,
    ],
  ])('does not publish ready when hello is immediately followed by %s', async (
    _label,
    terminalEvent,
    expectedStatus,
  ) => {
    const harness = createHarness();
    const client = createClient({
      ready: async () => {
        harness.transport.emit(terminalEvent);
        return READY;
      },
    });
    harness.dependencies.createClient = () => client;
    const supervisor = new AppleBridgeSupervisor(baseOptions(), harness.dependencies);

    await supervisor.start();

    expect(supervisor.getStatus()).toEqual(expectedStatus);
    expect(harness.transport.terminateCalls).toBe(1);
  });

  it('terminates the exact spawned transport when lifecycle subscription throws', async () => {
    const harness = createHarness();
    harness.transport.subscribe = () => {
      throw new Error('/Users/founder/private subscribe failed');
    };
    const supervisor = new AppleBridgeSupervisor(baseOptions(), harness.dependencies);

    await supervisor.start();

    expect(supervisor.getStatus()).toEqual({
      state: 'degraded',
      code: 'helper_launch_failed',
      message: 'Apple integration helper could not be launched.',
    });
    expect(harness.transport.terminateCalls).toBe(1);
  });

  it('stops promptly during staging and prevents the continuation from resolving the helper', async () => {
    const staging = deferred<void>();
    const harness = createHarness({
      dependencies: {
        mkdir: () => staging.promise,
      },
    });
    const supervisor = new AppleBridgeSupervisor(baseOptions(), harness.dependencies);
    const starting = supervisor.start();

    await expect(supervisor.stop()).resolves.toBeUndefined();
    expect(supervisor.getStatus()).toEqual({
      state: 'disabled',
      reason: 'not_packaged_or_configured',
    });

    staging.resolve();
    await starting;
    expect(harness.calls).toEqual([]);
  });

  it('stops promptly during signature verification and never spawns afterward', async () => {
    const signature = deferred<{
      signed: true;
      identifier: string;
      teamIdentifier: string;
    }>();
    const signatureStarted = deferred<void>();
    const harness = createHarness({
      dependencies: {
        verifySignature: () => {
          signatureStarted.resolve();
          return signature.promise;
        },
      },
    });
    const supervisor = new AppleBridgeSupervisor(baseOptions(), harness.dependencies);
    const starting = supervisor.start();
    await signatureStarted.promise;

    await expect(supervisor.stop()).resolves.toBeUndefined();
    signature.resolve({
      signed: true,
      identifier: 'com.callie.foundersales.applebridge',
      teamIdentifier: 'TEAM123456',
    });
    await starting;

    expect(harness.calls).toEqual(['mkdir:700', 'resolve']);
    expect(supervisor.getStatus()).toEqual({
      state: 'disabled',
      reason: 'not_packaged_or_configured',
    });
  });

  it('stops promptly during handshake and shuts and terminates owned resources once', async () => {
    const readiness = deferred<typeof READY>();
    const handshakeStarted = deferred<void>();
    const client = createClient({
      ready: () => {
        handshakeStarted.resolve();
        return readiness.promise;
      },
    });
    const harness = createHarness({ client });
    const supervisor = new AppleBridgeSupervisor(baseOptions(), harness.dependencies);
    const starting = supervisor.start();
    await handshakeStarted.promise;

    await Promise.all([supervisor.stop(), supervisor.stop()]);
    expect(client.shutdownCalls).toBe(1);
    expect(harness.transport.terminateCalls).toBe(1);

    readiness.resolve(READY);
    await starting;
    expect(supervisor.getStatus()).toEqual({
      state: 'disabled',
      reason: 'not_packaged_or_configured',
    });
    expect(client.shutdownCalls).toBe(1);
    expect(harness.transport.terminateCalls).toBe(1);
  });

  it('returns isolated frozen status snapshots that cannot mutate future state', async () => {
    const harness = createHarness();
    const supervisor = new AppleBridgeSupervisor(baseOptions(), harness.dependencies);
    await supervisor.start();

    const first = supervisor.getStatus();
    expect(Reflect.set(first, 'state', 'degraded')).toBe(false);
    const second = supervisor.getStatus();

    expect(second).toEqual({
      state: 'ready',
      helperVersion: '1.4.0-test',
      protocolVersion: 1,
    });
    expect(second).not.toBe(first);
    expect(Object.isFrozen(second)).toBe(true);
  });

  it('forwards a request once and never retries an ambiguous failure', async () => {
    const attempted: BridgeRequest[] = [];
    const client = createClient({
      request: async (request) => {
        attempted.push(request);
        throw new Error('ambiguous process exit');
      },
    });
    const harness = createHarness({ client });
    const supervisor = new AppleBridgeSupervisor(baseOptions(), harness.dependencies);
    await supervisor.start();
    const request: BridgeRequest = {
      v: 1,
      kind: 'request',
      id: '22222222-2222-4222-8222-222222222222',
      method: 'capabilities.probe',
      params: {},
    };

    await expect(supervisor.request(request)).rejects.toThrow('unavailable');

    expect(attempted).toEqual([request]);
  });

  it('stops a ready client exactly once and detaches process observation', async () => {
    const harness = createHarness();
    const supervisor = new AppleBridgeSupervisor(baseOptions(), harness.dependencies);
    await supervisor.start();

    await Promise.all([supervisor.stop(), supervisor.stop()]);
    harness.transport.emit({ type: 'exit', code: 1, signal: null });

    expect(harness.client.shutdownCalls).toBe(1);
    expect(harness.transport.listeners.size).toBe(0);
    expect(supervisor.getStatus()).toEqual({
      state: 'disabled',
      reason: 'not_packaged_or_configured',
    });
  });

  it('terminates the transport if graceful shutdown fails and reports no raw shutdown error', async () => {
    const client = createClient({
      shutdown: async () => {
        throw new Error('/Users/founder/private shutdown failed');
      },
    });
    const harness = createHarness({ client });
    const supervisor = new AppleBridgeSupervisor(baseOptions(), harness.dependencies);
    await supervisor.start();

    await expect(supervisor.stop()).rejects.toThrow('cleanup failed');

    expect(harness.transport.terminateCalls).toBe(1);
    expectNoPrivateDiagnostics(supervisor.getStatus());
  });
});
