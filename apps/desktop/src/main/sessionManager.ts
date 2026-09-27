import { clientCompatibility, mayMutate, type ClientVersionRange, type DeviceList } from '@fss/contracts';
import {
  desktopStateSchema,
  type CachedToday,
  type DesktopState,
  type RememberedWorkspace,
  type SessionChange,
  type StoredDevice,
  type StoredSession,
} from '../shared/contract.ts';
import type { ApiClient, ApiOutcome } from './apiClient.ts';
import type { AccessSession } from './authedClient.ts';
import type { DeviceStore } from './deviceStore.ts';
import type { OfflineCache } from './offlineCache.ts';

/**
 * Everything the Mac knows about being signed in (specification 5.3, 14.2,
 * Appendix G 24 and 40).
 *
 * Four rules live here and nowhere else in the app.
 *
 * **The device secret is the credential.** Since wave 3b (audit item S7) this Mac
 * opens a session with the secret it was given once at the claim and has kept in the
 * Keychain ever since: `POST /auth/session/open`, no rotation, opening twice is not
 * reuse. `/auth/session/renew` has no caller here. The opens are still serialised —
 * one promise in flight, every caller awaiting it — but now to save calls rather than
 * to avoid spending a credential twice.
 *
 * **A missing device secret is a signed-out Mac.** If `device.json` names a
 * registration the Keychain has no secret for, there is nothing this Mac can present
 * and no amount of retrying will find one. The registration is wiped and the window is
 * told, at startup and at any open; it is not a state to sit in silently.
 *
 * **A sign-out tells the server first.** The Keychain secret is forgotten only once
 * the server has confirmed, because a Mac that forgot its secret and never reached the
 * server would leave a device the workspace still counts as active and nothing left to
 * revoke it with. Offline, the window shows the signed-out screen at once and the
 * secret is kept for the retry, which runs at launch and when the Mac is back online.
 *
 * **Revocation wipes.** The moment the API says this device or membership is gone,
 * the cache and the stored credentials go with it. That is the "wiped on the next
 * successful revocation check" half of Appendix G 24; the other half — the 24-hour
 * expiry — belongs to the cache itself.
 *
 * **Below the minimum version, nothing mutates.** The gate is checked here as well as
 * at the API, not instead of it: the API is the authority, and this is what stops the
 * app offering a person a button that cannot work.
 *
 * **Offline is a fact, not a gate (wave 1).** `online` says whether the last call reached
 * the server, and every call says so — the bridges' own calls report through
 * `noteConnection` — so one failed renewal after the Mac wakes no longer greys out every
 * view until Home refreshes. It is not part of `mayMutate`: a command sent offline fails
 * with its own notice, and nothing is disabled for it.
 */

export type MutationRefusal = 'client_upgrade_required' | 'not_signed_in';

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
  /** Either field left out is the remembered one; with neither remembered, `workspace_required`. */
  signIn(input: { readonly workspaceId?: string | undefined; readonly deviceLabel?: string | undefined }): Promise<DesktopState>;
  signOut(): Promise<DesktopState>;
  /** The workspace's Macs, read now (wave 3b, A4). */
  listDevices(): Promise<DesktopState>;
  /** Sign one of them out. This Mac's own id is a sign-out and goes the same way. */
  revokeDevice(input: { readonly deviceId: string }): Promise<DesktopState>;
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
  accessToken(): Promise<AccessSession | null>;
  /** How many renewals actually reached the API. The serialisation test reads this. */
  renewalCount(): number;
  /**
   * What a bridge's own call found (wave 1): true when the server answered anything at
   * all, false only when it could not be reached. `authedClient` reports every call here.
   */
  noteConnection(reachable: boolean): void;
  /**
   * What an authenticated bridge call was refused with (1.0.12). The sign-in and
   * renewal paths have always come through `noteRefusal`; the six bridges' own calls
   * did not, so a device revoked while the window was open kept answering from a
   * session the server had already ended. A refusal in `REVOCATIONS` wipes here exactly
   * as it does there, and the window is told.
   */
  noteAuthRefusal(reason: string, sessionGeneration: number): Promise<void>;
  /** The number of session transitions so far. A read made under an older one is stale. */
  sessionGeneration(): number;
  /** Told on every transition: sign-out, another workspace, a changed role, a wipe. */
  onSessionChange(listener: (change: SessionChange) => void): void;
}

/** The name a Mac signs in under when nobody has named it. */
export const DEFAULT_DEVICE_LABEL = 'This Mac';

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
  let remembered: RememberedWorkspace | null = null;
  let renewals = 0;
  /** `GET /devices`' last answer, or null before anybody asked (wave 3b, A4). */
  let devices: DeviceList | null = null;
  // The one in-flight renewal. Every caller awaits this same promise.
  let renewal: Promise<ApiOutcome<StoredSession>> | null = null;

  /*
   * Session transitions (1.0.12). `generation` counts them and `announced` is the
   * identity the window was last told about; `undefined` means it has not been told
   * anything yet, which is the state this process starts in and is not a transition.
   *
   * The identity is the workspace, the device and the role, because all three change
   * what a person may see: a promoted salesperson is shown a Domain row and a sending
   * section, and everything read under the old role has to go.
   */
  let generation = 0;
  let announced: string | null | undefined;
  const listeners: ((change: SessionChange) => void)[] = [];

  /**
   * Whether this Mac is signed in *for the person looking at it*.
   *
   * A registration kept only so the server can be told about a sign-out is not one:
   * the window shows the sign-in form, nothing reads and nothing mutates.
   */
  const signedIn = (): boolean => device !== null && device.signOutPending !== true;

  const identityOf = (): string | null =>
    device === null || !signedIn() ? null : `${device.workspaceId}/${device.deviceId}/${device.role}`;

  const announce = (reason: string): void => {
    const identity = identityOf();
    const first = announced === undefined;
    if (!first && identity === announced) return;
    announced = identity;
    if (first) return;
    generation += 1;
    const change: SessionChange = { generation, identity, reason };
    for (const listener of listeners) listener(change);
  };

  const forget = async (reason: string): Promise<void> => {
    await options.cache.wipe();
    await options.store.forget();
    device = null;
    session = null;
    today = null;
    asOf = null;
    stale = false;
    devices = null;
    notice = reason;
    announce(reason);
  };

  const noteRefusal = async (reason: string): Promise<void> => {
    notice = reason;
    if (REVOCATIONS.has(reason)) await forget(reason);
  };

  /** A refusal to one of this file's own authenticated calls. Wipes on a revocation. */
  const noteAuthRefusalOf = async (reason: string): Promise<void> => {
    if (REVOCATIONS.has(reason)) await forget(reason);
  };

  /**
   * Tell the server about a sign-out this Mac has already shown (wave 3b, A2).
   *
   * Open, sign out, and only then forget: the sign-out call needs a token, and the
   * device secret is the only credential that gets one. A refusal that means the
   * registration is already over is a finished sign-out — the server has no device
   * left to end — so the secret goes then too. Anything else leaves the flag where it
   * is for the next attempt.
   */
  const finishSignOut = async (): Promise<boolean> => {
    if (device === null || device.signOutPending !== true) return true;
    const secret = await options.store.deviceSecret();
    if (secret === null) {
      await forget('signed_out');
      return true;
    }
    const opened = await options.api.openSession({
      workspaceId: device.workspaceId,
      deviceId: device.deviceId,
      deviceSecret: secret,
    });
    if (!opened.ok) {
      online = !opened.offline;
      if (opened.offline || !REVOCATIONS.has(opened.reason)) {
        notice = 'sign_out_pending';
        return false;
      }
      await forget('signed_out');
      return true;
    }
    online = true;
    const told = await options.api.signOut(opened.value.accessToken);
    if (!told.ok && (told.offline || !REVOCATIONS.has(told.reason))) {
      online = !told.offline;
      notice = 'sign_out_pending';
      return false;
    }
    await forget('signed_out');
    return true;
  };

  /**
   * Keep the workspace for the next sign-in. A file that cannot be written costs the next
   * sign-in its shortcut, not this one: the failure is not allowed to undo a sign-in that
   * worked, or to stop the app loading.
   */
  const remember = async (value: RememberedWorkspace): Promise<void> => {
    remembered = value;
    await options.store.rememberWorkspace(value).catch(() => undefined);
  };

  const ensureLoaded = async (): Promise<void> => {
    if (loaded) return;
    loaded = true;
    device = await options.store.load();
    remembered = await options.store.rememberedWorkspace();
    // A Mac registered before wave 1 has `device.json` and no remembered workspace yet;
    // it is remembered now, so its first sign-out does not ask for the UUID either.
    if (remembered === null && device !== null) {
      await remember({ workspaceId: device.workspaceId, deviceLabel: device.deviceLabel });
    }
    const cached = await options.cache.read();
    if (cached.state === 'fresh') {
      today = cached.today;
      asOf = cached.asOf;
      stale = true;
    }
    /*
     * A registration with no secret behind it (wave 3b, A3).
     *
     * `device.json` says this Mac is paired and the Keychain has no `device-secret`:
     * a Mac restored without its Keychain, or one whose item somebody removed. There
     * is nothing to present and nothing to wait for, so the registration goes here,
     * before anything reads with it — including a leftover `refresh-credential`, which
     * `forget()` removes with the rest and which nothing has asked for since wave 3b.
     */
    if (device !== null && (await options.store.deviceSecret()) === null) {
      await options.cache.wipe();
      await options.store.forget();
      device = null;
      session = null;
      today = null;
      asOf = null;
      stale = false;
      notice = 'not_signed_in';
    }
    // Records who this Mac is without announcing it: starting up is not a transition.
    announce('loaded');
    // A sign-out this Mac showed but never told the server about (A2). Not awaited by
    // the caller: the window is already the sign-in form, and this only decides whether
    // the line under it goes away.
    if (device !== null && device.signOutPending === true) void finishSignOut();
  };

  /**
   * Open a session with the device secret, at most once at a time (wave 3b, S7).
   *
   * A Keychain with no `device-secret` under a `device.json` that names a registration
   * is not a temporary state: nothing here can invent the secret, and every call this
   * Mac makes would be refused. The registration is wiped and the window is told
   * `not_signed_in`, which is what the person has to act on.
   */
  const open = async (): Promise<ApiOutcome<StoredSession>> => {
    if (renewal !== null) return await renewal;
    renewal = (async (): Promise<ApiOutcome<StoredSession>> => {
      const registration = device;
      if (registration === null) return { ok: false, reason: 'not_signed_in', offline: false };
      const secret = await options.store.deviceSecret();
      if (secret === null) {
        await forget('not_signed_in');
        return { ok: false, reason: 'not_signed_in', offline: false };
      }
      renewals += 1;
      const outcome = await options.api.openSession({
        workspaceId: registration.workspaceId,
        deviceId: registration.deviceId,
        deviceSecret: secret,
      });
      if (!outcome.ok) {
        online = !outcome.offline;
        await noteRefusal(outcome.reason);
        return outcome;
      }
      online = true;
      supported = outcome.value.supportedClientVersions;
      const opened: StoredSession = {
        accessToken: outcome.value.accessToken,
        accessTokenExpiresAt: outcome.value.accessTokenExpiresAt,
        reauthenticateAfter: outcome.value.reauthenticateAfter,
      };
      session = opened;
      // The answer names the membership's role as it is now (`openSession` in
      // `apps/api/src/auth/sessions.ts`). Until lane g69 only the credentials were kept,
      // so a Mac that signed in as a salesperson stayed one after an admin promoted it —
      // no Domain row, no sending section — until it signed in again. The role is public
      // metadata and goes to `device.json` with the rest; no secret moves.
      if (device !== null && device.role !== outcome.value.role) {
        const current: StoredDevice = { ...device, role: outcome.value.role };
        device = current;
        await options.store.saveDevice(current);
        // The window is holding a page drawn for the old role. It goes now, not at the
        // next read: 8.2's difference between the two roles is what is on the screen.
        announce('role_changed');
      }
      return { ok: true, value: opened };
    })();
    try {
      return await renewal;
    } finally {
      renewal = null;
    }
  };

  /**
   * The live access token for ordinary work.
   *
   * A sign-out waiting to be told to the server is not ordinary work: the credential is
   * kept for the retry and for nothing else, so every other caller is answered null and
   * sees the signed-out screen.
   */
  const liveSession = async (): Promise<StoredSession | null> => {
    await ensureLoaded();
    if (device === null || device.signOutPending === true) return null;
    const soon = options.now().getTime() + renewMarginMs;
    if (session !== null && Date.parse(session.accessTokenExpiresAt) > soon) return session;
    const outcome = await open();
    return outcome.ok ? outcome.value : null;
  };

  const screenOf = (): DesktopState['screen'] => {
    if (supported !== null && clientCompatibility(supported, options.clientVersion).kind === 'upgrade_required') {
      return 'upgrade_required';
    }
    return signedIn() ? 'today' : 'sign_in';
  };

  const snapshot = (): DesktopState =>
    desktopStateSchema.parse({
      screen: screenOf(),
      clientVersion: options.clientVersion,
      supportedClientVersions: supported,
      device:
        device === null || !signedIn()
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
      mayMutate: signedIn() && (supported === null || mayMutate(supported, options.clientVersion)),
      notice,
      today,
      rememberedWorkspace: remembered,
      devices,
    });

  return {
    renewalCount: () => renewals,

    noteConnection(reachable) {
      const returned = reachable && !online;
      online = reachable;
      // Back online with a sign-out still owed to the server (A2). One attempt, not a
      // loop: every later call that reaches the server comes through here too.
      if (returned && device !== null && device.signOutPending === true) void finishSignOut();
    },

    async noteAuthRefusal(reason, sessionGeneration) {
      // Only the refusals that mean the registration is over. Everything else a bridge
      // is refused with is the bridge's own notice to show, not a reason to wipe.
      if (!REVOCATIONS.has(reason)) return;
      /*
       * And only for the session that asked. A call made before a sign-out can be
       * answered `device_revoked` after somebody has signed in again; wiping then would
       * end a perfectly good session on the strength of the old one's answer.
       *
       * The check is repeated after **every** await, not only at the start: loading the
       * device file and wiping the cache are asynchronous, and a sign-in can land while
       * either is in flight. The one that matters most is the last — `store.forget()`
       * deletes `device.json` and both secrets — and it is not reached at all once the
       * number has moved.
       */
      if (sessionGeneration !== generation) return;
      await ensureLoaded();
      if (sessionGeneration !== generation) return;
      notice = reason;
      await options.cache.wipe();
      if (sessionGeneration !== generation) return;
      await options.store.forget();
      if (sessionGeneration !== generation) return;
      device = null;
      session = null;
      today = null;
      asOf = null;
      stale = false;
      announce(reason);
    },

    sessionGeneration: () => generation,

    onSessionChange(listener) {
      listeners.push(listener);
    },

    async accessToken() {
      const live = await liveSession();
      // The generation is read here, with the token, and not by the caller afterwards:
      // `liveSession` may have renewed, and a renewal that changed the role has already
      // moved the number by the time this line runs. The pair is what the caller needs.
      return live === null ? null : { token: live.accessToken, generation };
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
      const workspaceId = input.workspaceId ?? remembered?.workspaceId ?? null;
      const deviceLabel = input.deviceLabel ?? remembered?.deviceLabel ?? DEFAULT_DEVICE_LABEL;
      if (workspaceId === null) {
        notice = 'workspace_required';
        return snapshot();
      }
      const started = await options.api.startSignIn({ workspaceId, deviceLabel });
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
            deviceLabel,
            apiBaseUrl: new URL('/', started.value.authorizationUrl).toString(),
            registeredAt: options.now().toISOString(),
          };
          // The grant still carries a rotating credential, for desktop 1.0.12. This
          // build never stores it and never presents it: the device secret is what
          // `POST /auth/session/open` takes, and it is the only one kept.
          await options.store.save(registered, { deviceSecret: grant.deviceSecret });
          device = registered;
          session = {
            accessToken: grant.accessToken,
            accessTokenExpiresAt: grant.accessTokenExpiresAt,
            reauthenticateAfter: grant.reauthenticateAfter,
          };
          supported = grant.supportedClientVersions;
          notice = null;
          await remember({ workspaceId: grant.workspaceId, deviceLabel });
          // Somebody else may have been here a moment ago; the window empties what it
          // was holding before it draws anything of this person's.
          announce('signed_in');
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

    /**
     * Sign out (wave 3b, A2).
     *
     * The server is told first and the Keychain secret is forgotten only once it has
     * confirmed. The other order is the one that goes wrong: a Mac that dropped its
     * secret and never reached the server leaves a device the workspace still counts
     * as active, and this Mac no longer holds the credential that would revoke it.
     *
     * Offline, the person is signed out here and now — the flag is written before the
     * call, so a crash in the middle still retries — and one line says the server has
     * yet to be told. `retrySignOut` finishes it at the next launch, or the moment the
     * Mac is back online.
     */
    async signOut() {
      await ensureLoaded();
      if (device === null) return snapshot();
      if (device.signOutPending !== true) {
        const pending: StoredDevice = { ...device, signOutPending: true };
        device = pending;
        await options.store.saveDevice(pending);
        // The window empties now: what is on screen is the last person's.
        notice = 'signed_out';
        announce('signed_out');
      }
      await finishSignOut();
      return snapshot();
    },

    async listDevices() {
      const live = await liveSession();
      if (live === null) return snapshot();
      const outcome = await options.api.devices(live.accessToken);
      if (!outcome.ok) {
        online = !outcome.offline;
        await noteAuthRefusalOf(outcome.reason);
        notice = outcome.reason;
        return snapshot();
      }
      online = true;
      devices = outcome.value;
      notice = null;
      return snapshot();
    },

    async revokeDevice(input) {
      const live = await liveSession();
      if (live === null) return snapshot();
      const outcome = await options.api.revokeDevice(live.accessToken, input.deviceId);
      if (!outcome.ok) {
        online = !outcome.offline;
        await noteAuthRefusalOf(outcome.reason);
        notice = outcome.reason;
        return snapshot();
      }
      online = true;
      // Revoking the device this Mac is presenting is this Mac signing out, and the
      // server has already been told — so there is nothing to keep and nothing to retry.
      if (outcome.value.thisDevice) {
        await forget('signed_out');
        return snapshot();
      }
      notice = 'device_revoked_elsewhere';
      const listed = await options.api.devices(live.accessToken);
      if (listed.ok) devices = listed.value;
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
      // A sign-out waiting to be told to the server is a signed-out Mac: the credential
      // it is keeping is for the retry and nothing else (A2).
      if (!signedIn()) return { allowed: false, refusal: 'not_signed_in' };
      if (supported !== null && !mayMutate(supported, options.clientVersion)) {
        return { allowed: false, refusal: 'client_upgrade_required' };
      }
      return { allowed: true };
    },
  };
}
