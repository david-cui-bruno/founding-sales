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
 * **Every identity transition empties this Mac.** A sign-out (confirmed *or* waiting to
 * be told to the server), another workspace, a role the server now gives this
 * membership, a revocation: each wipes the encrypted Today cache and the list held in
 * memory before it announces, and `registerWindows` resets every bridge's snapshot on
 * the announcement. Announcing first and wiping later is how a page drawn for the last
 * person stayed on screen, and how a stale answer landed in the next one's window.
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
  /** How often to try a sign-out the server has not been told about (A2, P1-1). */
  readonly signOutRetryMs?: number;
  /** Injected so a test can drive the retry clock; the real ones by default. */
  readonly setInterval?: (run: () => void, ms: number) => ReturnType<typeof setInterval>;
  readonly clearInterval?: (handle: ReturnType<typeof setInterval>) => void;
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

/**
 * Refusals that mean the server has no usable device here any more (wave 3b, A2).
 *
 * The same list as `REVOCATIONS`, used for a different question: not "must this Mac
 * wipe" but "is there anything left to sign out". `reauthentication_required` is in it
 * for the reason written on `finishSignOut`.
 */
const ENDS_THE_REGISTRATION = new Set([
  'device_revoked',
  'membership_inactive',
  'credential_reuse',
  'credential_unknown',
  'credential_expired',
  'reauthentication_required',
  'session_ended',
]);

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
  const signOutRetryMs = options.signOutRetryMs ?? 60_000;
  const startTimer = options.setInterval ?? ((run, ms) => setInterval(run, ms));
  const stopTimer = options.clearInterval ?? ((handle) => { clearInterval(handle); });
  let retrying: ReturnType<typeof setInterval> | null = null;
  const sleep = options.sleep ?? (async (ms: number) => { await new Promise(resolve => setTimeout(resolve, ms)); });

  let device: StoredDevice | null = null;
  let session: StoredSession | null = null;
  let supported: ClientVersionRange | null = null;
  /**
   * The API refused this build by version (P1-2).
   *
   * A refusal says so without saying what the supported range now is, so the range this
   * build last read cannot be trusted to decide the screen: until 1.0.13's review a
   * `client_upgrade_required` from an open was a notice under a Today the person could
   * still press. It is the upgrade screen and no mutation from the refusal onwards, and
   * it clears only when a call is accepted again.
   */
  let refusedForVersion = false;
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

  /**
   * Tell the window a transition happened.
   *
   * Normally the identity changing is what makes it one. `force` is for the transitions
   * whose identity is already null on both sides — a pending sign-out completing — which
   * the window still has to hear about, because the line under the sign-in form says
   * the server has yet to be told and now it has been.
   */
  const announce = (reason: string, force = false): void => {
    const identity = identityOf();
    const first = announced === undefined;
    if (!first && identity === announced && !force) return;
    announced = identity;
    if (first) return;
    generation += 1;
    const change: SessionChange = { generation, identity, reason };
    for (const listener of listeners) listener(change);
  };

  /**
   * Everything this Mac was holding for the person who is leaving it.
   *
   * The encrypted cache on disk and the list in memory, together, before the window is
   * told. Called by every identity transition, not only by a completed sign-out: a
   * sign-out waiting to be told to the server, and a role change, are transitions too,
   * and leaving the last role's list in the cache is leaving it to be read.
   */
  const dropHeldData = async (): Promise<void> => {
    await options.cache.wipe();
    today = null;
    asOf = null;
    stale = false;
    devices = null;
  };

  const forget = async (reason: string): Promise<void> => {
    await dropHeldData();
    await options.store.forget();
    device = null;
    session = null;
    notice = reason;
    announce(reason, true);
  };

  /**
   * The device secret, with "there is none" told apart from "could not ask" (P1-3).
   *
   * A locked Keychain, a killed `security`, a daemon that is not answering: every one
   * of those used to read as "no secret", and the startup check (A3) would then wipe a
   * perfectly good registration. Only `errSecItemNotFound` is absence; anything else is
   * a failure to ask, and nothing is forgotten for it.
   */
  const readDeviceSecret = async (): Promise<
    { readonly kind: 'secret'; readonly value: string } | { readonly kind: 'absent' } | { readonly kind: 'unreadable' }
  > => {
    try {
      const value = await options.store.deviceSecret();
      return value === null ? { kind: 'absent' } : { kind: 'secret', value };
    } catch {
      return { kind: 'unreadable' };
    }
  };

  const noteRefusal = async (reason: string): Promise<void> => {
    notice = reason;
    if (reason === 'client_upgrade_required') refusedForVersion = true;
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
   * device secret is the only credential that gets one. (The *immediate* sign-out does
   * not come through here when this Mac already holds a live session — see `signOut` —
   * because the token in hand is the one the call needs.)
   *
   * **It forgets only the registration it started on** (P0-B). A retry can be on the
   * wire for minutes, and in that time somebody may sign in again: a `forget()` bound
   * to nothing would then delete the *new* registration and the new Keychain secret.
   * The device id and the session generation are captured at entry and checked before
   * anything is deleted; if either has moved, the answer is dropped.
   *
   * **A refusal that ends the registration is a finished sign-out.** `device_revoked`
   * and the rest mean the server has no device left to end. So does
   * `reauthentication_required`, which is the one worth writing down: a device's
   * `reauthenticate_after` is set once at the claim and never moves, so past that
   * instant that device can never mint a session again on any path — open, renew or
   * command — and the row, whatever its status column says, cannot be used by anybody.
   * There is nothing this Mac could do with the secret afterwards, and keeping it to
   * retry for ever would be keeping a secret for a device that is already inert.
   *
   * Anything else — offline, a 500, a Keychain that could not be asked — leaves the
   * flag where it is for the next attempt.
   */
  let signingOut: Promise<boolean> | null = null;

  const finishSignOut = async (): Promise<boolean> => {
    if (signingOut !== null) return await signingOut;
    if (device === null || device.signOutPending !== true) return true;
    const owner = device.deviceId;
    const mine = generation;
    /** The registration this attempt started on is still the one on this Mac. */
    const stillMine = (): boolean =>
      generation === mine && device !== null && device.deviceId === owner && device.signOutPending === true;

    signingOut = (async (): Promise<boolean> => {
      const secret = await readDeviceSecret();
      if (secret.kind === 'unreadable') {
        notice = 'keychain_unreadable';
        return false;
      }
      if (secret.kind === 'absent') {
        if (stillMine()) await forget('signed_out');
        return true;
      }
      const opened = await options.api.openSession({
        workspaceId: device?.workspaceId ?? '',
        deviceId: owner,
        deviceSecret: secret.value,
      });
      if (!opened.ok) {
        if (!stillMine()) return true;
        online = !opened.offline;
        if (opened.offline || !ENDS_THE_REGISTRATION.has(opened.reason)) {
          notice = 'sign_out_pending';
          return false;
        }
        await forget('signed_out');
        return true;
      }
      online = true;
      const told = await options.api.signOut(opened.value.accessToken);
      if (!stillMine()) return true;
      if (!told.ok && (told.offline || !ENDS_THE_REGISTRATION.has(told.reason))) {
        online = !told.offline;
        notice = 'sign_out_pending';
        return false;
      }
      await forget('signed_out');
      return true;
    })();
    try {
      return await signingOut;
    } finally {
      signingOut = null;
    }
  };

  /**
   * Try again, on a clock, while a sign-out is owed to the server (P1-1).
   *
   * `noteConnection` was the whole of the reconnect trigger until the review, and its
   * only production caller is the authenticated client — which a pending Mac never
   * uses, because nothing but the retry may use the credential it is keeping. So the
   * retry never fired, and the line under the sign-in form never went away. A timer is
   * what a Mac with nothing else to say to the server has: it starts when the flag is
   * set and at launch, and stops the moment the sign-out lands.
   */
  const startSignOutRetries = (): void => {
    if (retrying !== null || device === null || device.signOutPending !== true) return;
    retrying = startTimer(() => {
      if (device === null || device.signOutPending !== true) {
        stopSignOutRetries();
        return;
      }
      void finishSignOut().then(done => {
        if (done) stopSignOutRetries();
      });
    }, signOutRetryMs);
  };

  const stopSignOutRetries = (): void => {
    if (retrying === null) return;
    stopTimer(retrying);
    retrying = null;
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
     * before anything reads with it.
     *
     * A Keychain that could not be *asked* is a different thing and is not a reason to
     * forget anything: the notice says so and the registration stays (P1-3).
     */
    if (device !== null) {
      const secret = await readDeviceSecret();
      if (secret.kind === 'absent') {
        await dropHeldData();
        await options.store.forget();
        device = null;
        session = null;
        notice = 'not_signed_in';
      } else if (secret.kind === 'unreadable') {
        notice = 'keychain_unreadable';
      } else {
        // P2-2: 1.0.12's rotating credential has no caller and no reason to sit in the
        // Keychain until the next sign-out. It goes at the first startup that finds it.
        await options.store.forgetRefreshCredential();
      }
    }
    // Records who this Mac is without announcing it: starting up is not a transition.
    announce('loaded');
    // A sign-out this Mac showed but never told the server about (A2). Not awaited by
    // the caller: the window is already the sign-in form, and this only decides whether
    // the line under it goes away.
    if (device !== null && device.signOutPending === true) {
      void finishSignOut().then(done => {
        if (!done) startSignOutRetries();
      });
    }
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
      const secret = await readDeviceSecret();
      if (secret.kind === 'absent') {
        await forget('not_signed_in');
        return { ok: false, reason: 'not_signed_in', offline: false };
      }
      if (secret.kind === 'unreadable') {
        // The Keychain could not answer. Nothing is forgotten for that (P1-3).
        notice = 'keychain_unreadable';
        return { ok: false, reason: 'keychain_unreadable', offline: false };
      }
      renewals += 1;
      const outcome = await options.api.openSession({
        workspaceId: registration.workspaceId,
        deviceId: registration.deviceId,
        deviceSecret: secret.value,
      });
      if (!outcome.ok) {
        online = !outcome.offline;
        await noteRefusal(outcome.reason);
        return outcome;
      }
      online = true;
      refusedForVersion = false;
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
        // The window is holding a page drawn for the old role, and the cache is holding
        // a list read under it. Both go now, not at the next read: 8.2's difference
        // between the two roles is what is on the screen, and a salesperson's Today is
        // not an admin's.
        await dropHeldData();
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
    if (refusedForVersion) return 'upgrade_required';
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
      mayMutate: signedIn() && !refusedForVersion && (supported === null || mayMutate(supported, options.clientVersion)),
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
      /*
       * Back online with a sign-out still owed to the server (A2).
       *
       * A pending Mac makes no authenticated calls, so in production nothing reaches
       * this while one is owed — the clock in `startSignOutRetries` is what actually
       * finishes it (P1-1). This stays because it costs one attempt and it is the
       * fastest path when something *does* reach the server.
       */
      if (returned && device !== null && device.signOutPending === true) {
        void finishSignOut().then(done => {
          if (done) stopSignOutRetries();
        });
      }
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
      await dropHeldData();
      if (sessionGeneration !== generation) return;
      await options.store.forget();
      if (sessionGeneration !== generation) return;
      device = null;
      session = null;
      announce(reason, true);
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
      /*
       * A sign-out still on the wire finishes before a sign-in starts (P0-B).
       *
       * Without this the two interleave: the sign-in writes the new registration and
       * the new Keychain secret, and the retry — which began on the old one — reaches
       * its `forget()` afterwards and deletes them. `finishSignOut` also refuses to
       * forget a registration that is no longer the one it started on, so this is the
       * second of two locks rather than the only one; a person pressing Sign in should
       * not have to race anything.
       */
      if (signingOut !== null) await signingOut.catch(() => false);
      stopSignOutRetries();
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
          /*
           * Anything still held belongs to somebody else.
           *
           * Every way into a new registration passes a transition that has already
           * wiped — a sign-out confirmed or pending, a revocation — so this is normally
           * nothing to do, and it is conditional so that it stays nothing to do rather
           * than a second wipe on every sign-in. It is here because "normally" is not
           * a guarantee and a stale list is the one thing that must not survive.
           */
          if (today !== null) await dropHeldData();
          device = registered;
          session = {
            accessToken: grant.accessToken,
            accessTokenExpiresAt: grant.accessTokenExpiresAt,
            reauthenticateAfter: grant.reauthenticateAfter,
          };
          supported = grant.supportedClientVersions;
          refusedForVersion = false;
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
      if (device.signOutPending === true) {
        await finishSignOut();
        startSignOutRetries();
        return snapshot();
      }

      // The token in hand is the one the sign-out needs (P0-C). Opening a second
      // session to end the first is a round trip for nothing, and a round trip that
      // can fail; only the retry path, which holds no token, has to open first.
      const held =
        session !== null && Date.parse(session.accessTokenExpiresAt) > options.now().getTime() ? session : null;

      const pending: StoredDevice = { ...device, signOutPending: true };
      device = pending;
      await options.store.saveDevice(pending);
      // The window empties now, and so does this Mac: what is on screen and what is in
      // the cache are the last person's (P0-A).
      session = null;
      await dropHeldData();
      notice = 'signed_out';
      announce('signed_out');

      if (held !== null) {
        const told = await options.api.signOut(held.accessToken);
        if (told.ok || (!told.offline && ENDS_THE_REGISTRATION.has(told.reason))) {
          await forget('signed_out');
          return snapshot();
        }
        online = !told.offline;
        notice = 'sign_out_pending';
        startSignOutRetries();
        return snapshot();
      }

      const done = await finishSignOut();
      if (!done) startSignOutRetries();
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
      if (refusedForVersion || (supported !== null && !mayMutate(supported, options.clientVersion))) {
        return { allowed: false, refusal: 'client_upgrade_required' };
      }
      return { allowed: true };
    },
  };
}
