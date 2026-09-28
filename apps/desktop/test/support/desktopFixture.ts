import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClientVersionRange, DeviceList, DeviceSession, SessionGrant } from '@fss/contracts';
import { createApiClient, type ApiClient, type HttpAnswer, type HttpSend } from '../../src/main/apiClient.ts';
import { createDeviceStore } from '../../src/main/deviceStore.ts';
import { createMemoryVault, type SecretVault } from '../../src/main/keychain.ts';
import { createOfflineCache } from '../../src/main/offlineCache.ts';
import { createSessionManager, type SessionManager } from '../../src/main/sessionManager.ts';
import type { CachedToday } from '../../src/shared/contract.ts';

/**
 * A whole Mac, in memory: a temporary directory for the files, an in-memory vault in
 * place of the Keychain, and a stub of the API that answers from a script the test
 * writes. Every credential is generated when the fixture starts.
 */

export const CLIENT_VERSION = '1.4.0';
export const SUPPORTED: ClientVersionRange = { minimum: '1.2.0', maximum: '1.4.0' };

const secret = (): string => randomBytes(32).toString('base64url');
const token = (workspaceId: string): string => `fssa1.${workspaceId}.${secret()}`;
const credential = (workspaceId: string, deviceId: string, generation: number): string =>
  `fssr1.${workspaceId}.${deviceId}.${String(generation)}.${secret()}`;

export interface ApiScript {
  /** Refuse the next call to this path with this code. One use each. */
  refuse(path: string, reason: string): void;
  /** Make every call throw, as an unreachable server does. */
  offline(value: boolean): void;
  /** Stop the next call to this path inside the server, until `release`. */
  hold(path: string): void;
  /** Let one held call finish. */
  release(path: string): void;
  /** Whether a call to this path is waiting inside the server now. */
  holding(path: string): boolean;
  /** How many times each path was called. */
  readonly calls: Map<string, number>;
  /** Every call in the order it was made: what came before what. */
  readonly order: string[];
  /** Hand out a session grant for a claim. */
  grantFor(workspaceId: string): SessionGrant;
  today(value: CachedToday): void;
  /** Claims answer `handoff_unknown` until this is set. */
  browserFinished(value: boolean): void;
  /** The device secret the last grant handed out: what an open must present. */
  grantedSecret(): string | null;
  /**
   * Whether the claim's answer carries a rotating refresh credential (lane W3-C1).
   * True — today's server. False is the server after lane W3-C2 stops minting it.
   */
  mintsRefreshCredential(value: boolean): void;
  /** The rotating credential the last grant carried, or null when it carried none. */
  grantedRefreshCredential(): string | null;
  /** Whether the server still has this device. A sign-out sets it false. */
  deviceActive(): boolean;
  /** The other Macs `GET /devices` lists beside this one. */
  otherDevices(value: DeviceList): void;
  /**
   * The membership's role as the server holds it now. Every later claim and open
   * answers with it; `salesperson` until a test says otherwise (lane g69: an admin
   * promoting a salesperson is the case the renewal used to lose).
   */
  role(value: 'admin' | 'salesperson'): void;
}

export interface DesktopFixture {
  readonly directory: string;
  readonly vault: SecretVault & { readonly entries: Map<string, string> };
  readonly api: ApiClient;
  readonly script: ApiScript;
  readonly manager: SessionManager;
  readonly openedUrls: string[];
  /** Let a held cache wipe finish. Null until one is waiting. */
  releaseCacheWipe(): void;
  /** Whether a held cache wipe is waiting now. */
  wipeHeld(): boolean;
  /** How many times the encrypted cache has been wiped. */
  cacheWipes(): number;
  readonly workspaceId: string;
  advance(ms: number): void;
  stop(): Promise<void>;
}

export function sampleToday(workspaceId: string): CachedToday {
  return {
    workspaceId,
    snapshotDate: '2026-09-21',
    businessTimeZone: 'America/New_York',
    cards: [
      {
        firmId: randomUUID(),
        firmName: 'Ash & Partners',
        lane: 'reply',
        dueAt: '2026-09-21T13:00:00.000Z',
        counts: { replies: 1, emailsDue: 0, callsDue: 0 },
      },
      {
        firmId: randomUUID(),
        firmName: 'Birch Advisory',
        lane: 'due_work',
        dueAt: '2026-09-21T14:00:00.000Z',
        counts: { replies: 0, emailsDue: 2, callsDue: 1 },
      },
    ],
  };
}

export async function createDesktopFixture(
  options: {
    readonly clientVersion?: string;
    readonly supported?: ClientVersionRange;
    /**
     * Hold the cache wipe open (1.0.12). A revocation wipes asynchronously, and a
     * sign-in can land while it is in flight; a test that wants to drive that moment
     * needs the wipe to stop where it can reach it.
     */
    readonly holdCacheWipe?: boolean;
    /**
     * The sign-out retry's clock (A2, P1-1). A pending sign-out tries again on an
     * interval; a test that wants to drive that tick needs the interval in its hand
     * rather than a real 60-second wait.
     */
    readonly setInterval?: (run: () => void, ms: number) => ReturnType<typeof setInterval>;
    readonly clearInterval?: (handle: ReturnType<typeof setInterval>) => void;
  } = {},
): Promise<DesktopFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'fss-desktop-'));
  const vault = createMemoryVault();
  const workspaceId = randomUUID();
  const deviceId = randomUUID();
  const userId = randomUUID();
  const supported = options.supported ?? SUPPORTED;

  let current = Date.parse('2026-09-21T09:00:00.000Z');
  let offline = false;
  let browserFinished = false;
  /*
   * The rotating credential the grant still carries, for desktop 1.0.12 (wave 3b).
   * Nothing on this Mac stores it and nothing presents it: one generation, never
   * advanced, because there is no route left that would advance it.
   */
  const generation = 1;
  /*
   * Whether the claim's answer carries that credential at all (lane W3-C1). It is
   * optional on the wire from desktop 1.0.14 so that lane W3-C2 can stop minting it;
   * a test sets this false to be the server after C2.
   */
  let mintsRefreshCredential = true;
  let granted: string | null = null;
  let grantedCredential: string | null = null;
  let deviceActive = true;
  let others: DeviceList = [];
  let role: 'admin' | 'salesperson' = 'salesperson';
  let todayValue: CachedToday = sampleToday(workspaceId);
  const refusals = new Map<string, string[]>();
  const calls = new Map<string, number>();
  const order: string[] = [];
  /*
   * Calls a test wants to catch in flight (P0-B). A sign-out retry can be on the wire
   * for as long as the server takes, and the races worth testing all happen in that
   * window; `hold` says "stop the next call to this path inside the server", and
   * `release` lets it finish.
   */
  const holds = new Map<string, number>();
  const waiting = new Map<string, (() => void)[]>();
  const openedUrls: string[] = [];

  const grantFor = (forWorkspace: string): SessionGrant => {
    granted = secret();
    grantedCredential = mintsRefreshCredential ? credential(forWorkspace, deviceId, generation) : null;
    deviceActive = true;
    return {
      workspaceId: forWorkspace,
      userId,
      role,
      deviceId,
      deviceSecret: granted,
      accessToken: token(forWorkspace),
      accessTokenExpiresAt: new Date(current + 3_600_000).toISOString(),
      ...(grantedCredential === null ? {} : { refreshCredential: grantedCredential }),
      reauthenticateAfter: new Date(current + 30 * 24 * 3_600_000).toISOString(),
      supportedClientVersions: supported,
    };
  };

  const send: HttpSend = async (url, init) => {
    const path = new URL(url).pathname;
    const body: Record<string, unknown> = init.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>);
    calls.set(path, (calls.get(path) ?? 0) + 1);
    order.push(path);
    const heldCount = holds.get(path) ?? 0;
    if (heldCount > 0) {
      holds.set(path, heldCount - 1);
      await new Promise<void>(resolve => {
        waiting.set(path, [...(waiting.get(path) ?? []), resolve]);
      });
    }
    if (offline) throw new Error('the server did not answer');

    const queued = refusals.get(path)?.shift();
    if (queued !== undefined) return await Promise.resolve({ status: 409, body: { error: queued } });

    const answer = (body: unknown): HttpAnswer => ({ status: 200, body });
    switch (path) {
      case '/auth/client-version':
        return await Promise.resolve(
          answer({
            supported,
            upgradeUrl: 'https://callie.example/downloads/mac',
            instruction: 'Install the current build, then sign in again.',
          }),
        );
      case '/auth/sign-in/start':
        return await Promise.resolve(
          answer({
            authorizationUrl: `https://accounts.google.test/o/oauth2/v2/auth?state=${secret()}`,
            handoffSecret: secret(),
            expiresAt: new Date(current + 600_000).toISOString(),
          }),
        );
      case '/auth/sign-in/claim':
        if (!browserFinished) return await Promise.resolve({ status: 401, body: { error: 'handoff_unknown' } });
        return await Promise.resolve(answer(grantFor(workspaceId)));
      /*
       * Wave 3b, S7. The secret does not rotate, so opening twice is not reuse and the
       * answer carries no credential; a device the server has signed out answers
       * `device_revoked` rather than `credential_unknown`, which is what tells a Mac
       * restored from a backup to sign in with Google again.
       */
      case '/auth/session/open': {
        if (!deviceActive) return await Promise.resolve({ status: 401, body: { error: 'device_revoked' } });
        if (granted === null || body['deviceSecret'] !== granted) {
          return await Promise.resolve({ status: 401, body: { error: 'credential_unknown' } });
        }
        const opened: DeviceSession = {
          workspaceId,
          userId,
          role,
          deviceId,
          accessToken: token(workspaceId),
          accessTokenExpiresAt: new Date(current + 3_600_000).toISOString(),
          reauthenticateAfter: new Date(current + 30 * 24 * 3_600_000).toISOString(),
          supportedClientVersions: supported,
        };
        return await Promise.resolve(answer(opened));
      }
      case '/auth/sign-out':
        deviceActive = false;
        return await Promise.resolve(answer({ signedOut: true }));
      case '/devices':
        return await Promise.resolve(
          answer([
            {
              deviceId,
              deviceLabel: 'This Mac',
              status: deviceActive ? ('active' as const) : ('revoked' as const),
              registeredAt: new Date(current - 86_400_000).toISOString(),
              lastSeenAt: new Date(current).toISOString(),
              clientVersion,
              thisDevice: true,
            },
            ...others,
          ]),
        );
      case '/devices/revoke': {
        const asked = body['deviceId'];
        const mine = asked === deviceId;
        if (mine) deviceActive = false;
        else others = others.map(entry => (entry.deviceId === asked ? { ...entry, status: 'revoked' as const } : entry));
        return await Promise.resolve(answer({ revoked: true, deviceId: String(asked), thisDevice: mine }));
      }
      case '/today':
        return await Promise.resolve(answer(todayValue));
      default:
        return await Promise.resolve({ status: 404, body: { error: 'not_found' } });
    }
  };

  const clientVersion = options.clientVersion ?? CLIENT_VERSION;
  const api = createApiClient({ baseUrl: 'https://api.fss.test', clientVersion, send });
  const realCache = createOfflineCache({ directory, vault, now: () => new Date(current) });
  let releaseWipe: (() => void) | null = null;
  // The *first* wipe only: everything after it runs normally, so a sign-out driven
  // while the held one is waiting does not wait behind it.
  let holdNextWipe = options.holdCacheWipe === true;
  /* How many times this Mac was emptied. A transition that wipes nothing is P0-A. */
  let wipes = 0;
  const cache = {
    ...realCache,
    wipe: async () => {
      wipes += 1;
      if (holdNextWipe) {
        holdNextWipe = false;
        await new Promise<void>(resolve => {
          releaseWipe = resolve;
        });
      }
      await realCache.wipe();
    },
  };
  const manager = createSessionManager({
    api,
    store: createDeviceStore({ directory, vault }),
    cache,
    clientVersion,
    now: () => new Date(current),
    openInBrowser: async url => {
      openedUrls.push(url);
      browserFinished = true;
      await Promise.resolve();
    },
    claimIntervalMs: 0,
    sleep: async () => {
      await Promise.resolve();
    },
    ...(options.setInterval === undefined ? {} : { setInterval: options.setInterval }),
    ...(options.clearInterval === undefined ? {} : { clearInterval: options.clearInterval }),
  });

  return {
    releaseCacheWipe: () => {
      releaseWipe?.();
      releaseWipe = null;
    },
    wipeHeld: () => releaseWipe !== null,
    cacheWipes: () => wipes,
    directory,
    vault,
    api,
    manager,
    openedUrls,
    workspaceId,
    advance: ms => {
      current += ms;
    },
    script: {
      calls,
      order,
      refuse: (path, reason) => {
        const queue = refusals.get(path) ?? [];
        queue.push(reason);
        refusals.set(path, queue);
      },
      offline: value => {
        offline = value;
      },
      hold: path => {
        holds.set(path, (holds.get(path) ?? 0) + 1);
      },
      release: path => {
        const queue = waiting.get(path) ?? [];
        const next = queue.shift();
        waiting.set(path, queue);
        next?.();
      },
      holding: path => (waiting.get(path) ?? []).length > 0,
      grantFor,
      today: value => {
        todayValue = value;
      },
      browserFinished: value => {
        browserFinished = value;
      },
      grantedSecret: () => granted,
      mintsRefreshCredential: value => {
        mintsRefreshCredential = value;
      },
      grantedRefreshCredential: () => grantedCredential,
      deviceActive: () => deviceActive,
      otherDevices: value => {
        others = value;
      },
      role: value => {
        role = value;
      },
    },
    stop: async () => {
      await rm(directory, { recursive: true, force: true });
    },
  };
}
