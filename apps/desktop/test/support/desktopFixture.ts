import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClientVersionRange, SessionGrant, SessionRenewal } from '@fss/contracts';
import {
  createApiClient,
  createDeviceStore,
  createMemoryVault,
  createOfflineCache,
  createSessionManager,
  type ApiClient,
  type HttpAnswer,
  type HttpSend,
  type SecretVault,
  type SessionManager,
} from '../../src/main/index.ts';
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
  /** How many times each path was called. */
  readonly calls: Map<string, number>;
  /** Hand out a session grant for a claim. */
  grantFor(workspaceId: string): SessionGrant;
  today(value: CachedToday): void;
  /** Claims answer `handoff_unknown` until this is set. */
  browserFinished(value: boolean): void;
  latestCredential(): string | null;
  /**
   * The membership's role as the server holds it now. Every later claim and renewal
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
  options: { readonly clientVersion?: string; readonly supported?: ClientVersionRange } = {},
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
  let generation = 1;
  let latest: string | null = null;
  let role: 'admin' | 'salesperson' = 'salesperson';
  let todayValue: CachedToday = sampleToday(workspaceId);
  const refusals = new Map<string, string[]>();
  const calls = new Map<string, number>();
  const openedUrls: string[] = [];

  const grantFor = (forWorkspace: string): SessionGrant => {
    latest = credential(forWorkspace, deviceId, generation);
    return {
      workspaceId: forWorkspace,
      userId,
      role,
      deviceId,
      deviceSecret: secret(),
      accessToken: token(forWorkspace),
      accessTokenExpiresAt: new Date(current + 3_600_000).toISOString(),
      refreshCredential: latest,
      reauthenticateAfter: new Date(current + 30 * 24 * 3_600_000).toISOString(),
      supportedClientVersions: supported,
    };
  };

  const send: HttpSend = async (url, _init) => {
    const path = new URL(url).pathname;
    calls.set(path, (calls.get(path) ?? 0) + 1);
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
      case '/auth/session/renew': {
        generation += 1;
        latest = credential(workspaceId, deviceId, generation);
        const renewal: SessionRenewal = {
          workspaceId,
          userId,
          role,
          deviceId,
          accessToken: token(workspaceId),
          accessTokenExpiresAt: new Date(current + 3_600_000).toISOString(),
          refreshCredential: latest,
          reauthenticateAfter: new Date(current + 30 * 24 * 3_600_000).toISOString(),
          supportedClientVersions: supported,
        };
        return await Promise.resolve(answer(renewal));
      }
      case '/auth/sign-out':
        return await Promise.resolve(answer({ signedOut: true }));
      case '/today':
        return await Promise.resolve(answer(todayValue));
      default:
        return await Promise.resolve({ status: 404, body: { error: 'not_found' } });
    }
  };

  const clientVersion = options.clientVersion ?? CLIENT_VERSION;
  const api = createApiClient({ baseUrl: 'https://api.fss.test', clientVersion, send });
  const cache = createOfflineCache({ directory, vault, now: () => new Date(current) });
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
  });

  return {
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
      refuse: (path, reason) => {
        const queue = refusals.get(path) ?? [];
        queue.push(reason);
        refusals.set(path, queue);
      },
      offline: value => {
        offline = value;
      },
      grantFor,
      today: value => {
        todayValue = value;
      },
      browserFinished: value => {
        browserFinished = value;
      },
      latestCredential: () => latest,
      role: value => {
        role = value;
      },
    },
    stop: async () => {
      await rm(directory, { recursive: true, force: true });
    },
  };
}
