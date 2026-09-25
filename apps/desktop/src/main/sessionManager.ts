import { clientCompatibility, mayMutate, type ClientVersionRange } from '@fss/contracts';
import {
  desktopStateSchema,
  type CachedToday,
  type DesktopState,
  type StoredDevice,
  type StoredSession,
} from '../shared/contract.ts';
import type { ApiClient, ApiOutcome } from './apiClient.ts';
import type { DeviceStore } from './deviceStore.ts';
import type { OfflineCache } from './offlineCache.ts';

/**
 * Everything the Mac knows about being signed in (specification 5.3, 14.2,
 * Appendix G 24 and 40).
 *
 * Three rules live here and nowhere else in the app.
 *
 * **Renewal is serialised.** "The client serializes renewal to avoid accidental
 * concurrent reuse." Two views noticing an expired session at the same moment must
 * not both present the same refresh credential, because the second presentation is
 * reuse and reuse revokes the device. One promise is in flight at a time and every
 * caller awaits the same one.
 *
 * **Revocation wipes.** The moment the API says this device or membership is gone,
 * the cache and the stored credentials go with it. That is the "wiped on the next
 * successful revocation check" half of Appendix G 24; the other half — the 24-hour
 * expiry — belongs to the cache itself.
 *
 * **Below the minimum version, nothing mutates.** The gate is checked here as well as
 * at the API, not instead of it: the API is the authority, and this is what stops the
 * app offering a person a button that cannot work.
 */

export type MutationRefusal = 'offline' | 'client_upgrade_required' | 'not_signed_in';

export interface SessionManagerOptions {
  readonly api: ApiClient;
  readonly store: DeviceStore;
  readonly cache: OfflineCache;
  readonly clientVersion: string;
  readonly now: () => Date;
  /** Opens a URL in the system browser. Never an in-app window (specification 5.1). */
  readonly openInBrowser: (url: string) => Promise<void>;
  /** How long to wait for the browser half of the sign-in, and how often to ask. */
  readonly claimTimeoutMs?: number;
  readonly claimIntervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Renew this long before the access session actually expires. */
  readonly renewMarginMs?: number;
}

export interface SessionManager {
  state(): Promise<DesktopState>;
  signIn(input: { readonly workspaceId: string; readonly deviceLabel: string }): Promise<DesktopState>;
  signOut(): Promise<DesktopState>;
  refreshToday(): Promise<DesktopState>;
  /** The gate every mutating action passes. Never bypassed by a view. */
  mayMutateNow(): Promise<{ readonly allowed: true } | { readonly allowed: false; readonly refusal: MutationRefusal }>;
  /**
   * The live access token, or null.
   *
   * The Today and CRM windows call endpoints `apiClient` does not know about, and they
   * have to present the same session this manager owns. It goes through `liveSession`
   * like every other caller, so the renewal stays serialised — which is the whole
   * point of this file, and the reason a second holder of the refresh credential is
   * not an option (5.3: "Reuse revokes the device").
   *
   * It is deliberately not on the renderer's bridge. A token that crossed the
   * preload boundary would be a token in a page's memory.
   */
  accessToken(): Promise<string | null>;
  /** How many renewals actually reached the API. The serialisation test reads this. */
  renewalCount(): number;
}

/** Refusals that mean this Mac's registration is over and its cache must go. */
const REVOCATIONS = new Set([
  'device_revoked',
  'membership_inactive',
  'credential_reuse',
  'credential_unknown',
  'credential_expired',
  'reauthentication_required',
  'session_ended',
]);

export function createSessionManager(options: SessionManagerOptions): SessionManager {
  const claimTimeoutMs = options.claimTimeoutMs ?? 300_000;
  const claimIntervalMs = options.claimIntervalMs ?? 1000;
  const renewMarginMs = options.renewMarginMs ?? 60_000;
  const sleep = options.sleep ?? (async (ms: number) => { await new Promise(resolve => setTimeout(resolve, ms)); });

  let device: StoredDevice | null = null;
  let session: StoredSession | null = null;
  let supported: ClientVersionRange | null = null;
  let online = true;
  let notice: string | null = null;
  let today: CachedToday | null = null;
  let asOf: string | null = null;
  let stale = false;
  let loaded = false;
  let renewals = 0;
  // The one in-flight renewal. Every caller awaits this same promise.
  let renewal: Promise<ApiOutcome<StoredSession>> | null = null;

  const forget = async (reason: string): Promise<void> => {
    await options.cache.wipe();
    await options.store.forget();
    device = null;
    session = null;
    today = null;
    asOf = null;
    stale = false;
    notice = reason;
  };

  const noteRefusal = async (reason: string): Promise<void> => {
    notice = reason;
    if (REVOCATIONS.has(reason)) await forget(reason);
  };

  const ensureLoaded = async (): Promise<void> => {
    if (loaded) return;
    loaded = true;
    device = await options.store.load();
    const cached = await options.cache.read();
    if (cached.state === 'fresh') {
      today = cached.today;
      asOf = cached.asOf;
      stale = true;
    }
  };

  /** Renew, at most once at a time. Concurrent callers share the one attempt. */
  const renew = async (): Promise<ApiOutcome<StoredSession>> => {
    if (renewal !== null) return await renewal;
    renewal = (async (): Promise<ApiOutcome<StoredSession>> => {
      const credential = await options.store.refreshCredential();
      if (credential === null) return { ok: false, reason: 'not_signed_in', offline: false };
      renewals += 1;
      const outcome = await options.api.renewSession(credential);
      if (!outcome.ok) {
        online = !outcome.offline;
        await noteRefusal(outcome.reason);
        return outcome;
      }
      online = true;
      supported = outcome.value.supportedClientVersions;
      const renewed: StoredSession = {
        accessToken: outcome.value.accessToken,
        accessTokenExpiresAt: outcome.value.accessTokenExpiresAt,
        refreshCredential: outcome.value.refreshCredential,
        reauthenticateAfter: outcome.value.reauthenticateAfter,
      };
      session = renewed;
      await options.store.saveRefreshCredential(renewed.refreshCredential);
      // The renewal names the membership's role as it is now (`renewSession` in
      // `apps/api/src/auth/sessions.ts`). Until lane g69 only the credentials were kept,
      // so a Mac that signed in as a salesperson stayed one after an admin promoted it —
      // no Domain row, no sending section — until it signed in again. The role is public
      // metadata and goes to `device.json` with the rest; no secret moves.
      if (device !== null && device.role !== outcome.value.role) {
        const current: StoredDevice = { ...device, role: outcome.value.role };
        device = current;
        await options.store.saveDevice(current);
      }
      return { ok: true, value: renewed };
    })();
    try {
      return await renewal;
    } finally {
      renewal = null;
    }
  };

  const liveSession = async (): Promise<StoredSession | null> => {
    await ensureLoaded();
    if (device === null) return null;
    const soon = options.now().getTime() + renewMarginMs;
    if (session !== null && Date.parse(session.accessTokenExpiresAt) > soon) return session;
    const outcome = await renew();
    return outcome.ok ? outcome.value : null;
  };

  const screenOf = (): DesktopState['screen'] => {
    if (supported !== null && clientCompatibility(supported, options.clientVersion).kind === 'upgrade_required') {
      return 'upgrade_required';
    }
    return device === null ? 'sign_in' : 'today';
  };

  const snapshot = (): DesktopState =>
    desktopStateSchema.parse({
      screen: screenOf(),
      clientVersion: options.clientVersion,
      supportedClientVersions: supported,
      device:
        device === null
          ? null
          : {
              deviceId: device.deviceId,
              deviceLabel: device.deviceLabel,
              workspaceId: device.workspaceId,
              role: device.role,
              registeredAt: device.registeredAt,
            },
      online,
      stale,
      asOf,
      mayMutate: device !== null && online && (supported === null || mayMutate(supported, options.clientVersion)),
      notice,
      today,
    });

  return {
    renewalCount: () => renewals,

    async accessToken() {
      const live = await liveSession();
      return live === null ? null : live.accessToken;
    },

    async state() {
      await ensureLoaded();
      if (supported === null) {
        // The version notice is readable without a session, and an outdated client is
        // allowed to read exactly this and nothing else (Appendix G 40).
        const outcome = await options.api.clientVersionNotice();
        if (outcome.ok) {
          supported = outcome.value.supported;
          online = true;
        } else {
          online = !outcome.offline;
        }
      }
      return snapshot();
    },

    async signIn(input) {
      await ensureLoaded();
      notice = null;
      const started = await options.api.startSignIn(input);
      if (!started.ok) {
        online = !started.offline;
        await noteRefusal(started.reason);
        return snapshot();
      }
      online = true;

      // The system browser, never a window inside the app: a person must be able to
      // see the address bar that says accounts.google.com (specification 5.1).
      await options.openInBrowser(started.value.authorizationUrl);

      const deadline = options.now().getTime() + claimTimeoutMs;
      for (;;) {
        const claimed = await options.api.claimSignIn(started.value.handoffSecret);
        if (claimed.ok) {
          const grant = claimed.value;
          const registered: StoredDevice = {
            workspaceId: grant.workspaceId,
            userId: grant.userId,
            deviceId: grant.deviceId,
            role: grant.role,
            deviceLabel: input.deviceLabel,
            apiBaseUrl: new URL('/', started.value.authorizationUrl).toString(),
            registeredAt: options.now().toISOString(),
          };
          await options.store.save(registered, {
            deviceSecret: grant.deviceSecret,
            refreshCredential: grant.refreshCredential,
          });
          device = registered;
          session = {
            accessToken: grant.accessToken,
            accessTokenExpiresAt: grant.accessTokenExpiresAt,
            refreshCredential: grant.refreshCredential,
            reauthenticateAfter: grant.reauthenticateAfter,
          };
          supported = grant.supportedClientVersions;
          notice = null;
          return snapshot();
        }
        // `handoff_unknown` means the browser has not finished; anything else is over.
        if (claimed.offline || claimed.reason !== 'handoff_unknown') {
          online = !claimed.offline;
          await noteRefusal(claimed.reason);
          return snapshot();
        }
        if (options.now().getTime() >= deadline) {
          notice = 'sign_in_timed_out';
          return snapshot();
        }
        await sleep(claimIntervalMs);
      }
    },

    async signOut() {
      await ensureLoaded();
      const live = await liveSession();
      if (live !== null) await options.api.signOut(live.accessToken);
      await forget('signed_out');
      return snapshot();
    },

    async refreshToday() {
      // Show the unexpired cache, marked stale. An expired one shows nothing: an old
      // list presented as current is worse than no list (specification 5.3, 4.2).
      const fallBackToCache = async (): Promise<DesktopState> => {
        if (device === null) return snapshot();
        const cached = await options.cache.read();
        if (cached.state === 'fresh') {
          today = cached.today;
          asOf = cached.asOf;
          stale = true;
        } else {
          today = null;
          asOf = null;
          stale = false;
        }
        return snapshot();
      };

      // No live session — expired and unrenewable, most often because the server did
      // not answer. That is the outage case, and it reads from the cache too.
      const live = await liveSession();
      if (live === null) return await fallBackToCache();

      const outcome = await options.api.today(live.accessToken);
      if (!outcome.ok) {
        online = !outcome.offline;
        await noteRefusal(outcome.reason);
        return await fallBackToCache();
      }
      online = true;
      today = outcome.value;
      asOf = options.now().toISOString();
      stale = false;
      await options.cache.write(outcome.value);
      return snapshot();
    },

    async mayMutateNow() {
      await ensureLoaded();
      if (device === null) return { allowed: false, refusal: 'not_signed_in' };
      if (supported !== null && !mayMutate(supported, options.clientVersion)) {
        return { allowed: false, refusal: 'client_upgrade_required' };
      }
      if (!online) return { allowed: false, refusal: 'offline' };
      return { allowed: true };
    },
  };
}
