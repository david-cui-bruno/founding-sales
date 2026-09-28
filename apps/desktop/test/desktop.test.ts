import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEVICE_FILE, DEVICE_SECRET_ACCOUNT, REFRESH_CREDENTIAL_ACCOUNT, WORKSPACE_FILE, createDeviceStore } from '../src/main/deviceStore.ts';
import { KeychainError, createKeychainVault, createMemoryVault, keychainCommand, type SecretVault } from '../src/main/keychain.ts';
import { CACHE_FILE, createOfflineCache } from '../src/main/offlineCache.ts';
import { createSessionManager } from '../src/main/sessionManager.ts';
import { buildScreenView } from '../src/renderer/viewModel.ts';
import { createAuthedClient } from '../src/main/authedClient.ts';
import { createAdminBridge } from '../src/main/settingsBridge.ts';
import { outboundStatusAnswer } from './support/outboundStatus.ts';
import {
  NAVIGATION_TARGETS,
  ROUTE_NAMES,
  desktopStateSchema,
  navigationTargetOf,
  routeNameOf,
  type SessionChange,
} from '../src/shared/contract.ts';
import { IPC_CHANNELS } from '../src/main/ipc.ts';
import { DEEP_LINKS, deepLinkRoute, windowMenuTemplate } from '../src/main/windowMenu.ts';
import { routeOf, routeText, sidebarRowOf } from '../src/renderer/routes.ts';
import {
  CLIENT_VERSION,
  createDesktopFixture,
  sampleToday,
  type DesktopFixture,
} from './support/desktopFixture.ts';

/**
 * The Mac's half of specification 5.3 and 14.2, and of Appendix G 24 and 40.
 *
 * Nothing here touches the real Keychain, the real network or a real browser: the
 * vault is in memory, the API is a script, and "opening the system browser" records
 * a URL. What is real is the encryption, the file layout and the timing.
 */

let fixture: DesktopFixture | null = null;

afterEach(async () => {
  await fixture?.stop();
  fixture = null;
});

/**
 * Wait for something the app does without being awaited: the sign-out retry (A2) is
 * started by a launch and by the connection returning, and neither hands a promise to
 * a caller. A fixed tick is a flake under load; this is the condition itself.
 */
async function eventually(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function started(options?: Parameters<typeof createDesktopFixture>[0]): Promise<DesktopFixture> {
  fixture = await createDesktopFixture(options);
  return fixture;
}

describe('the macOS Keychain adapter', () => {
  it('never puts the secret in an argument vector', () => {
    const invocation = keychainCommand('write', {
      service: 'com.callie.fss.desktop',
      account: DEVICE_SECRET_ACCOUNT,
      secret: 'a-secret-nobody-should-see-in-ps',
    });
    expect(invocation.args.join(' ')).not.toContain('a-secret-nobody-should-see-in-ps');
    // `-w` with nothing after it is what makes `security` read standard input.
    expect(invocation.args.at(-1)).toBe('-w');
    expect(invocation.stdin).toBe('a-secret-nobody-should-see-in-ps\na-secret-nobody-should-see-in-ps\n');
  });

  it('reads, writes and removes by account within one service', () => {
    const read = keychainCommand('read', { service: 'svc', account: 'acct' });
    expect(read.args).toEqual(['find-generic-password', '-a', 'acct', '-s', 'svc', '-w']);
    expect(read.stdin).toBeUndefined();
    expect(keychainCommand('remove', { service: 'svc', account: 'acct' }).args).toEqual([
      'delete-generic-password',
      '-a',
      'acct',
      '-s',
      'svc',
    ]);
  });
});

describe('sign-in through the system browser', () => {
  it('opens the authorization URL outside the app and stores the grant in the vault', async () => {
    const mac = await started();
    const state = await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: "David's MacBook" });

    expect(mac.openedUrls).toHaveLength(1);
    expect(mac.openedUrls[0]).toContain('accounts.google.test');
    expect(state.screen).toBe('today');
    expect(state.device?.deviceLabel).toBe("David's MacBook");

    // The one secret is in the vault and nowhere else. The file on disk holds
    // identifiers only, and a grep over it finds nothing. There is no second
    // credential to store: the rotating one went with migration 0021.
    expect(mac.vault.entries.has(DEVICE_SECRET_ACCOUNT)).toBe(true);
    expect(mac.vault.entries.has(REFRESH_CREDENTIAL_ACCOUNT)).toBe(false);
    const onDisk = await readFile(join(mac.directory, DEVICE_FILE), 'utf8');
    for (const value of mac.vault.entries.values()) expect(onDisk).not.toContain(value);
    expect(JSON.stringify(state)).not.toContain(mac.vault.entries.get(DEVICE_SECRET_ACCOUNT) ?? 'x');
  });

  it('signs in on a grant with no rotating credential, and keeps that account empty', async () => {
    // Migration 0021 (lane W3-C2) stopped minting one, and `sessionGrantSchema` has no
    // field for it, so the claim's strict parse would refuse a grant that carried one.
    const mac = await started();

    const state = await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: 'A Mac' });

    expect(state.screen).toBe('today');
    expect(state.device?.deviceLabel).toBe('A Mac');
    expect(Object.keys(state)).not.toContain('refreshCredential');
    expect(mac.vault.entries.has(DEVICE_SECRET_ACCOUNT)).toBe(true);
    // The Keychain account the rotating credential used to live in stays empty, so a
    // Mac restored from a backup that still has one is not read from.
    expect(mac.vault.entries.has(REFRESH_CREDENTIAL_ACCOUNT)).toBe(false);
  });

  it('waits for the browser and gives up rather than hanging', async () => {
    const mac = await started();
    mac.script.browserFinished(false);
    // The fixture's opener normally finishes the browser half; this one does not.
    const state = await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: 'A Mac' });
    expect(state.screen).toBe('today');
    expect(mac.openedUrls).toHaveLength(1);
  });

  it('refuses the sign-in when the account has no membership, and stays signed out', async () => {
    const mac = await started();
    mac.script.refuse('/auth/sign-in/claim', 'membership_required');
    const state = await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: 'A Mac' });
    expect(state.screen).toBe('sign_in');
    expect(state.notice).toBe('membership_required');
    expect(state.device).toBeNull();
  });
});

describe('session transitions the window is told about (1.0.12)', () => {
  /*
   * Until 1.0.12 the renderer found out that the person had changed by noticing that a
   * state it happened to read looked different, which is one read too late: everything
   * it was holding — the request cache, the reply lane, what somebody had typed — was
   * still the last person's until something asked. These are the four transitions, as
   * the main process sees them.
   */
  const changes = (mac: Awaited<ReturnType<typeof started>>): { readonly seen: SessionChange[] } => {
    const seen: SessionChange[] = [];
    mac.manager.onSessionChange(change => seen.push(change));
    return { seen };
  };

  it('says nothing at startup: being signed in already is not a transition', async () => {
    const mac = await started();
    const { seen } = changes(mac);
    await mac.manager.state();
    expect(seen).toEqual([]);
    expect(mac.manager.sessionGeneration()).toBe(0);
  });

  it('announces a sign-in and the sign-out after it, with the identity each leaves behind', async () => {
    const mac = await started();
    const { seen } = changes(mac);
    await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: "David's MacBook" });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.reason).toBe('signed_in');
    expect(seen[0]?.identity).toContain(mac.workspaceId);
    expect(seen[0]?.identity).toContain('salesperson');

    /*
     * A sign-out is two announcements since wave 3b (A2): the person is signed out on
     * this Mac at once — the window empties, the cache goes — and the second says the
     * server has now been told and there is nothing left owed. The window needs both:
     * the first empties it, and the second takes away the line that says the sign-out
     * has not reached the server.
     */
    await mac.manager.signOut();
    expect(seen).toHaveLength(3);
    expect(seen[1]).toMatchObject({ reason: 'signed_out', identity: null, generation: 2 });
    expect(seen[2]).toMatchObject({ reason: 'signed_out', identity: null, generation: 3 });
    // Another workspace is this pair: the window is emptied twice, and the second
    // sign-in announces the new one.
  });

  it('announces a role a renewal came back with, without a sign-out', async () => {
    const mac = await started();
    await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: 'A Mac' });
    const { seen } = changes(mac);

    mac.script.role('admin');
    // Past the renewal margin: the next token this Mac needs is a renewed one.
    mac.advance(3_600_000);
    await mac.manager.accessToken();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.reason).toBe('role_changed');
    expect(seen[0]?.identity).toContain('admin');
  });

  it('announces a revocation a bridge call was refused with, and wipes', async () => {
    const mac = await started();
    await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: 'A Mac' });
    const { seen } = changes(mac);

    // What `authedClient` reports when one of the six bridges is answered 401, with
    // the session the call was made under.
    await mac.manager.noteAuthRefusal('device_revoked', mac.manager.sessionGeneration());

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ reason: 'device_revoked', identity: null });
    const state = await mac.manager.state();
    expect(state.device).toBeNull();
    expect(state.notice).toBe('device_revoked');
    expect(mac.vault.entries.has(DEVICE_SECRET_ACCOUNT)).toBe(false);
  });

  it('ignores a revocation answered to a session that has already ended', async () => {
    /*
     * The race: a bridge call is made, the person signs out and signs in again, and
     * only then does the server answer the first call `device_revoked`. Applied to
     * whichever session is current, that wipes a perfectly good new one on the strength
     * of the old one's answer — a sign-in that ends by itself a second later.
     */
    const mac = await started();
    await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: 'A Mac' });
    const madeUnder = mac.manager.sessionGeneration();

    await mac.manager.signOut();
    await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: 'A Mac' });
    const { seen } = changes(mac);

    await mac.manager.noteAuthRefusal('device_revoked', madeUnder);

    expect(seen).toEqual([]);
    const state = await mac.manager.state();
    expect(state.device).not.toBeNull();
    expect(state.notice).not.toBe('device_revoked');
    expect(mac.vault.entries.has(DEVICE_SECRET_ACCOUNT)).toBe(true);

    // The same refusal, for the session that actually asked, still wipes.
    await mac.manager.noteAuthRefusal('device_revoked', mac.manager.sessionGeneration());
    expect((await mac.manager.state()).device).toBeNull();
  });

  it('wipes for a token the renewal issued, even though acquiring it moved the session', async () => {
    /*
     * The case the generation check could have swallowed. Asking for a token renews the
     * session; the renewal came back with a different role, which is a transition, so
     * the number moves *during* acquisition. The token in the request's header belongs
     * to the session after that, and a `device_revoked` for it is this session's
     * business — reading the number before the token would have called it somebody
     * else's and ignored it.
     */
    const mac = await started();
    await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: 'A Mac' });
    const before = mac.manager.sessionGeneration();

    mac.script.role('admin');
    mac.advance(3_600_000);
    const access = await mac.manager.accessToken();
    expect(access).not.toBeNull();
    expect(access?.generation).toBe(before + 1);

    await mac.manager.noteAuthRefusal('device_revoked', access?.generation ?? -1);
    expect((await mac.manager.state()).device).toBeNull();
  });

  it('drops the wipe when somebody signs in while it is in flight', async () => {
    // The wipe is asynchronous — the cache, then the device file and both secrets — and
    // the check is repeated after each await, so a session that began in the middle of
    // it keeps its credentials.
    const mac = await started({ holdCacheWipe: true });
    await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: 'A Mac' });
    const madeUnder = mac.manager.sessionGeneration();

    const wiping = mac.manager.noteAuthRefusal('device_revoked', madeUnder);
    // The wipe is waiting on the cache. Somebody signs out and in again behind it.
    // The sign-out wipes too, so the held one is let go first: what this drives is the
    // *refusal's* wipe finishing after a sign-in, not a queue of wipes.
    await eventually(() => mac.wipeHeld(), 'the cache wipe to begin');
    mac.releaseCacheWipe();
    await mac.manager.signOut();
    await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: 'A Mac' });
    await wiping;

    // `store.forget()` is never reached: this Mac is still registered.
    expect((await mac.manager.state()).device).not.toBeNull();
    expect(mac.vault.entries.has(DEVICE_SECRET_ACCOUNT)).toBe(true);
  });

  it('keeps the new session whole when the wipe resumes after the sign-in, not before', async () => {
    /*
     * The same drop, with the ordering pinned rather than left to the scheduler.
     *
     * The held wipe is released only *after* the next sign-in has finished, so the
     * refusal's flow resumes with `store.forget()` — which deletes `device.json` and
     * the device secret — still ahead of it and a newer registration already written.
     * The guard used to read `generation` after the wipe's await, which by then was
     * the new session's own number, so it always matched and never fired: the wipe
     * went on to delete the credential the sign-in had just stored.
     */
    const mac = await started({ holdCacheWipe: true });
    await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: 'A Mac' });
    const madeUnder = mac.manager.sessionGeneration();

    const wiping = mac.manager.noteAuthRefusal('device_revoked', madeUnder);
    await eventually(() => mac.wipeHeld(), 'the cache wipe to begin');
    await mac.manager.signOut();
    const signedIn = await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: 'A Mac' });
    const newDeviceId = signedIn.device?.deviceId;
    const newSecret = mac.vault.entries.get(DEVICE_SECRET_ACCOUNT);
    expect(newDeviceId).toBeDefined();
    expect(newSecret).toBeDefined();

    mac.releaseCacheWipe();
    await wiping;

    // The new registration is still on disk, and so is the one secret it needs.
    expect((await mac.manager.state()).device?.deviceId).toBe(newDeviceId);
    expect(mac.vault.entries.get(DEVICE_SECRET_ACCOUNT)).toBe(newSecret);
    const onDisk = await readFile(join(mac.directory, DEVICE_FILE), 'utf8');
    expect(onDisk).toContain(newDeviceId ?? 'no-device-id');
  });

  it('is not a wipe for a refusal that is not one: a 403 on one call is that call’s business', async () => {
    const mac = await started();
    await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: 'A Mac' });
    const { seen } = changes(mac);

    await mac.manager.noteAuthRefusal('not_assigned', mac.manager.sessionGeneration());

    expect(seen).toEqual([]);
    expect((await mac.manager.state()).device).not.toBeNull();
  });
});

describe('the authenticated client reports what it was refused with (1.0.12)', () => {
  interface Refusal {
    reason: string;
    status: number;
    generation: number;
  }

  const clientWith = (
    status: number,
    body: unknown,
    refusals: Refusal[],
    access: () => Promise<{ token: string; generation: number }> = async () =>
      await Promise.resolve({ token: 'token-value', generation: 0 }),
  ) =>
    createAuthedClient({
      baseUrl: 'https://api.example.test/',
      clientVersion: '1.4.0',
      accessToken: access,
      send: async () => await Promise.resolve({ status, body }),
      onAuthRefusal: (reason, refusedStatus, sessionGeneration) =>
        refusals.push({ reason, status: refusedStatus, generation: sessionGeneration }),
    });

  it('tells the session manager about a 401 and a 403, by reason', async () => {
    const refusals: Refusal[] = [];
    await clientWith(401, { error: 'device_revoked' }, refusals).read('/today', value => value, {});
    await clientWith(403, { reason: 'not_assigned' }, refusals).read('/today', value => value, {});
    expect(refusals).toEqual([
      { reason: 'device_revoked', status: 401, generation: 0 },
      { reason: 'not_assigned', status: 403, generation: 0 },
    ]);
  });

  it('reports the session the call was made under, not the one it was answered under', async () => {
    const refusals: Refusal[] = [];
    let generation = 4;
    const client = clientWith(401, { error: 'device_revoked' }, refusals, async () =>
      await Promise.resolve({ token: 'token-value', generation }),
    );
    const reading = client.read('/today', value => value, {});
    // Somebody signs out and in again while the call is on the wire.
    generation = 6;
    await reading;
    expect(refusals).toEqual([{ reason: 'device_revoked', status: 401, generation: 4 }]);
  });

  it('reports the session the token came from, when fetching it moved the session', async () => {
    /*
     * The renewal case. Asking for a token can renew the session, and a renewal that
     * came back with a different role *is* a transition: the token in this request's
     * header belongs to the session after it, not before. Reading the number before the
     * token would report the old one, and a revocation for the new token would then be
     * ignored — which is the reproduction the review gave: started=1, current=2.
     */
    const refusals: Refusal[] = [];
    let generation = 1;
    const client = clientWith(401, { error: 'device_revoked' }, refusals, async () => {
      await Promise.resolve();
      generation = 2; // the renewal came back with another role, mid-acquisition
      return { token: 'the-renewed-token', generation };
    });
    await client.read('/today', value => value, {});
    expect(refusals).toEqual([{ reason: 'device_revoked', status: 401, generation: 2 }]);
  });

  it('says nothing about a refusal that is not about authentication', async () => {
    const refusals: Refusal[] = [];
    await clientWith(409, { error: 'already_confirmed' }, refusals).read('/replies/card', value => value, {});
    expect(refusals).toEqual([]);
  });
});

describe('the remembered workspace (wave 1)', () => {
  it('signs in again after Sign out without asking for the workspace or the name', async () => {
    const mac = await started();
    await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: "David's MacBook" });
    const out = await mac.manager.signOut();
    expect(out.device).toBeNull();
    // Sign out tells the server, then removes device.json and both Keychain accounts,
    // and leaves workspace.json (wave 3b, A2).
    expect(mac.script.calls.get('/auth/sign-out')).toBe(1);
    await expect(readFile(join(mac.directory, DEVICE_FILE), 'utf8')).rejects.toThrow();
    expect(out.rememberedWorkspace).toEqual({ workspaceId: mac.workspaceId, deviceLabel: "David's MacBook" });
    const onDisk = await readFile(join(mac.directory, WORKSPACE_FILE), 'utf8');
    expect(JSON.parse(onDisk)).toEqual({ workspaceId: mac.workspaceId, deviceLabel: "David's MacBook" });
    for (const value of mac.vault.entries.values()) expect(onDisk).not.toContain(value);

    const again = await mac.manager.signIn({});
    expect(again.screen).toBe('today');
    expect(again.device?.workspaceId).toBe(mac.workspaceId);
    expect(again.device?.deviceLabel).toBe("David's MacBook");
  });

  it('asks for the workspace on a Mac that has never signed in, and starts nothing', async () => {
    const mac = await started();
    const state = await mac.manager.signIn({});
    expect(state.screen).toBe('sign_in');
    expect(state.notice).toBe('workspace_required');
    expect(state.rememberedWorkspace).toBeNull();
    expect(mac.openedUrls).toEqual([]);
  });

  it('remembers a Mac registered before wave 1 from its device.json, on first load', async () => {
    const mac = await started();
    await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: 'Old Mac' });
    await rm(join(mac.directory, WORKSPACE_FILE));
    const reopened = createSessionManager({
      api: mac.api,
      store: createDeviceStore({ directory: mac.directory, vault: mac.vault }),
      cache: createOfflineCache({ directory: mac.directory, vault: mac.vault, now: () => new Date('2026-09-21T10:00:01.000Z') }),
      clientVersion: CLIENT_VERSION,
      now: () => new Date('2026-09-21T10:00:01.000Z'),
      openInBrowser: async () => {
        await Promise.resolve();
      },
    });
    expect((await reopened.state()).rememberedWorkspace).toEqual({ workspaceId: mac.workspaceId, deviceLabel: 'Old Mac' });
    expect(JSON.parse(await readFile(join(mac.directory, WORKSPACE_FILE), 'utf8'))).toMatchObject({ deviceLabel: 'Old Mac' });
  });
});

describe('online follows every call (wave 1)', () => {
  it('a bridge call that reaches the server clears offline at once, without a Home refresh', async () => {
    const mac = await started();
    await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: 'A Mac' });
    mac.script.offline(true);
    await mac.manager.refreshToday();
    expect((await mac.manager.state()).online).toBe(false);

    let reachable = false;
    const client = createAuthedClient({
      baseUrl: 'https://api.fss.test',
      clientVersion: CLIENT_VERSION,
      accessToken: async () => await Promise.resolve({ token: 'token', generation: 0 }),
      send: async () => {
        if (!reachable) throw new Error('the server did not answer');
        // A refusal is an answer: the server was reached.
        return await Promise.resolve({ status: 409, body: { status: 'refused', reason: 'not_found' } });
      },
      onConnection: online => {
        mac.manager.noteConnection(online);
      },
    });
    await client.read('/anything', value => value);
    expect((await mac.manager.state()).online).toBe(false);
    reachable = true;
    const answer = await client.read('/anything', value => value);
    expect(answer.ok).toBe(false);
    const state = await mac.manager.state();
    expect(state.online).toBe(true);
    expect(state.mayMutate).toBe(true);
  });

  it('reports true on any HTTP answer and false only when the server cannot be reached', async () => {
    const seen: boolean[] = [];
    let mode: 'ok' | 'refused' | 'error' | 'down' = 'ok';
    const client = createAuthedClient({
      baseUrl: 'https://api.fss.test',
      clientVersion: CLIENT_VERSION,
      accessToken: async () => await Promise.resolve({ token: 'token', generation: 0 }),
      send: async () => {
        if (mode === 'down') throw new Error('unreachable');
        const status = mode === 'ok' ? 200 : mode === 'refused' ? 409 : 500;
        return await Promise.resolve({ status, body: mode === 'ok' ? { status: 'accepted', replayed: false, result: {} } : {} });
      },
      onConnection: online => {
        seen.push(online);
      },
    });
    for (const next of ['ok', 'refused', 'error', 'down'] as const) {
      mode = next;
      await client.read('/x', value => value);
      await client.command('/y', {}, value => value);
    }
    expect(seen).toEqual([true, true, true, true, true, true, false, false]);
  });
});

describe('serialised session opens', () => {
  it('renews once however many callers notice the expiry at the same moment', async () => {
    const mac = await started();
    await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: 'A Mac' });
    const before = mac.manager.renewalCount();

    // The hour is up. Four views ask for Today at the same instant.
    mac.advance(3_600_001);
    await Promise.all([
      mac.manager.refreshToday(),
      mac.manager.refreshToday(),
      mac.manager.refreshToday(),
      mac.manager.refreshToday(),
    ]);

    // One open, not four. The device secret does not rotate, so a second open is not
    // reuse — but four calls for one expiry is four calls, and one is enough.
    expect(mac.manager.renewalCount()).toBe(before + 1);
    expect(mac.script.calls.get('/auth/session/open')).toBe(1);
    expect(mac.script.calls.get('/auth/session/renew')).toBeUndefined();
  });

  it('opens before the session actually expires rather than after a refusal', async () => {
    const mac = await started();
    await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: 'A Mac' });
    mac.advance(3_600_000 - 30_000);
    await mac.manager.refreshToday();
    expect(mac.script.calls.get('/auth/session/open')).toBe(1);
  });
});

describe('the role an open carries (lane g69)', () => {
  it('applies the role the server now gives, keeps it on disk without a secret, and survives a restart', async () => {
    const mac = await started();
    const signedIn = await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: 'A Mac' });
    expect(signedIn.device?.role).toBe('salesperson');

    // An admin promotes this membership. The Mac learns it at its next open, not at
    // its next sign-in: until g69 it kept `salesperson` until then, and Administration
    // never asked for the sending posture.
    mac.script.role('admin');
    mac.advance(3_600_001);
    await mac.manager.refreshToday();
    expect(mac.script.calls.get('/auth/session/open')).toBe(1);
    expect((await mac.manager.state()).device?.role).toBe('admin');

    const onDisk = JSON.parse(await readFile(join(mac.directory, DEVICE_FILE), 'utf8')) as { role: string };
    expect(onDisk.role).toBe('admin');
    const text = await readFile(join(mac.directory, DEVICE_FILE), 'utf8');
    for (const value of mac.vault.entries.values()) expect(text).not.toContain(value);

    // A second manager over the same directory is the app opened again.
    const reopened = createSessionManager({
      api: mac.api,
      store: createDeviceStore({ directory: mac.directory, vault: mac.vault }),
      cache: createOfflineCache({ directory: mac.directory, vault: mac.vault, now: () => new Date('2026-09-21T10:00:01.000Z') }),
      clientVersion: CLIENT_VERSION,
      now: () => new Date('2026-09-21T10:00:01.000Z'),
      openInBrowser: async () => {
        await Promise.resolve();
      },
    });
    expect((await reopened.state()).device?.role).toBe('admin');
  });

  it('reaches an open Administration window: the posture a salesperson never asked for is read once the open says admin', async () => {
    const mac = await started();
    await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: 'A Mac' });
    const asked: string[] = [];
    const admin = createAdminBridge({
      api: createAuthedClient({
        baseUrl: 'https://api.fss.test',
        clientVersion: CLIENT_VERSION,
        accessToken: async () => await mac.manager.accessToken(),
        send: async url => {
          const path = new URL(url).pathname;
          asked.push(path);
          // Only the sending read answers here; everything else is an API older than it.
          if (path === '/outbound/status') {
            return await Promise.resolve({ status: 200, body: outboundStatusAnswer({ domain: null }) });
          }
          return await Promise.resolve({ status: 404, body: { error: 'not_found' } });
        },
      }),
      session: mac.manager,
    });

    await admin.state();
    expect(asked).not.toContain('/outbound/status');

    mac.script.role('admin');
    mac.advance(3_600_001);
    await mac.manager.refreshToday();
    const promoted = await admin.state();
    expect(promoted.role).toBe('admin');
    expect(asked).toContain('/outbound/status');
    expect(promoted.sendingAdmin).toEqual({ domain: null, ramps: [] });
  });

  it('applies a demotion the same way, and leaves the role alone when the renewal did not change it', async () => {
    const mac = await started();
    mac.script.role('admin');
    await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: 'A Mac' });
    expect((await mac.manager.state()).device?.role).toBe('admin');

    mac.advance(3_600_001);
    await mac.manager.refreshToday();
    expect((await mac.manager.state()).device?.role).toBe('admin');

    mac.script.role('salesperson');
    mac.advance(3_600_001);
    await mac.manager.refreshToday();
    expect(mac.script.calls.get('/auth/session/open')).toBe(2);
    expect((await mac.manager.state()).device?.role).toBe('salesperson');
  });
});

describe('the encrypted offline cache', () => {
  it('is ciphertext on disk and readable only with the key in the vault', async () => {
    const mac = await started();
    await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: 'A Mac' });
    const list = sampleToday(mac.workspaceId);
    mac.script.today(list);
    await mac.manager.refreshToday();

    const raw = await readFile(join(mac.directory, CACHE_FILE), 'utf8');
    expect(raw).not.toContain('Ash & Partners');
    expect(JSON.parse(raw)).toMatchObject({ version: 1 });
  });

  it('shows an unexpired cache marked stale when the server is unreachable', async () => {
    const mac = await started();
    await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: 'A Mac' });
    await mac.manager.refreshToday();

    mac.script.offline(true);
    mac.advance(3_600_000 + 1);
    const state = await mac.manager.refreshToday();
    expect(state.online).toBe(false);
    expect(state.stale).toBe(true);
    expect(state.today?.cards).toHaveLength(2);
    // Offline is a banner, not a gate (wave 1): nothing is disabled for it.
    expect(state.mayMutate).toBe(true);

    const view = buildScreenView(state);
    expect(view.showingCachedList).toBe(true);
    expect(view.actionsEnabled).toBe(true);
    expect(view.banners.some(banner => banner.text.includes('earlier read'))).toBe(true);
    expect(view.banners.some(banner => banner.text === 'Callie cannot reach the server.')).toBe(true);
  });

  it('shows nothing at all once the cache is more than twenty-four hours old', async () => {
    const mac = await started();
    await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: 'A Mac' });
    await mac.manager.refreshToday();

    mac.script.offline(true);
    mac.advance(24 * 3_600_000 + 1000);
    const state = await mac.manager.refreshToday();
    expect(state.today).toBeNull();
    expect(state.stale).toBe(false);
    expect(buildScreenView(state).cardCount).toBe(0);
  });

  it('is wiped, with its key, the moment the API says the device is revoked', async () => {
    const mac = await started();
    await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: 'A Mac' });
    await mac.manager.refreshToday();
    expect(mac.vault.entries.size).toBeGreaterThan(0);

    mac.script.refuse('/today', 'device_revoked');
    const state = await mac.manager.refreshToday();

    expect(state.screen).toBe('sign_in');
    expect(state.notice).toBe('device_revoked');
    expect(state.today).toBeNull();
    // Everything: the cache file, its key, the device record, both credentials.
    expect(mac.vault.entries.size).toBe(0);
    await expect(readFile(join(mac.directory, CACHE_FILE), 'utf8')).rejects.toThrow();
    await expect(readFile(join(mac.directory, DEVICE_FILE), 'utf8')).rejects.toThrow();
  });

  it('refuses a cache file whose ciphertext was edited', async () => {
    const vault = createMemoryVault();
    const directory = (await started()).directory;
    let clock = Date.parse('2026-09-21T09:00:00.000Z');
    const cache = createOfflineCache({ directory, vault, now: () => new Date(clock) });
    const list = sampleToday('11111111-1111-4111-8111-111111111111');
    await cache.write(list);
    expect(await cache.read()).toMatchObject({ state: 'fresh' });

    // Moving the clock forward past the lifetime makes it stale, not fresh, and the
    // expiry is inside the ciphertext, so editing the file cannot extend it.
    clock += 24 * 3_600_000 + 1;
    expect(await cache.read()).toMatchObject({ state: 'stale' });
  });

  it('refuses to cache anything with a field a message body could live in', async () => {
    const mac = await started();
    const cache = createOfflineCache({ directory: mac.directory, vault: mac.vault, now: () => new Date() });
    const contaminated = {
      ...sampleToday(mac.workspaceId),
      // A slice that tried to put a body in the cache would fail here, not in review.
      bodies: [{ messageId: 'm-1', text: 'Thanks, not interested.' }],
    };
    await expect(cache.write(contaminated as never)).rejects.toThrow();
  });
});

describe('the sign-in screen offline (wave 1)', () => {
  it('says the server cannot be reached once, not once for the connection and again for the press', () => {
    const state = desktopStateSchema.parse({
      screen: 'sign_in',
      clientVersion: CLIENT_VERSION,
      supportedClientVersions: null,
      device: null,
      online: false,
      stale: false,
      asOf: null,
      mayMutate: false,
      notice: 'offline',
      today: null,
      rememberedWorkspace: null,
      devices: null,
    });
    const view = buildScreenView(state);
    expect(view.banners.map(banner => banner.text)).toEqual(['Callie cannot reach the server.']);
    expect(view.signInEnabled).toBe(true);
  });
});

describe('the version gate', () => {
  it('shows an outdated Mac the upgrade instruction and nothing it can press', async () => {
    const mac = await started({ clientVersion: '1.0.0' });
    const state = await mac.manager.state();
    expect(state.screen).toBe('upgrade_required');
    expect(state.mayMutate).toBe(false);

    const view = buildScreenView(state);
    expect(view.heading).toBe('Update Callie');
    expect(view.signInEnabled).toBe(false);
    expect(view.actionsEnabled).toBe(false);
    expect(view.banners[0]?.tone).toBe('blocking');

    // The upgrade instruction is exactly what it was still allowed to read.
    expect(mac.script.calls.get('/auth/client-version')).toBe(1);
    expect(await mac.manager.mayMutateNow()).toEqual({
      allowed: false,
      refusal: 'not_signed_in',
    });
  });

  it('lets a supported Mac mutate, offline or not: a command sent offline fails on its own (wave 1)', async () => {
    const mac = await started();
    await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: 'A Mac' });
    expect(await mac.manager.mayMutateNow()).toEqual({ allowed: true });

    mac.script.offline(true);
    await mac.manager.refreshToday();
    expect((await mac.manager.state()).online).toBe(false);
    expect(await mac.manager.mayMutateNow()).toEqual({ allowed: true });
  });

  it('blocks mutation when the minimum rises under a running client', async () => {
    const mac = await started({ clientVersion: CLIENT_VERSION, supported: { minimum: '1.5.0', maximum: '1.6.0' } });
    const state = await mac.manager.state();
    expect(state.screen).toBe('upgrade_required');
    expect(buildScreenView(state).actionsEnabled).toBe(false);
  });
});

describe('the state that crosses the bridge', () => {
  it('has no field a secret or a message body could travel in', async () => {
    const mac = await started();
    const state = await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: 'A Mac' });
    // `strictObject` all the way down: an extra field is a parse error, not a warning.
    expect(() => desktopStateSchema.parse({ ...state, accessToken: 'anything' })).toThrow();
    expect(Object.keys(state)).not.toContain('accessToken');
    expect(Object.keys(state)).not.toContain('refreshCredential');
  });
});

describe('one window: the routes the menu and deep links may name (wave 1)', () => {
  it('names exactly five views and seven targets, and nothing for any other value', () => {
    expect(ROUTE_NAMES).toEqual(['today', 'replies', 'firms', 'sequences', 'settings']);
    expect(NAVIGATION_TARGETS).toEqual([
      'today',
      'replies',
      'firms',
      'sequences',
      'settings/administration',
      'settings/dashboard',
      'settings/diagnostics',
    ]);
    for (const name of ROUTE_NAMES) expect(routeNameOf(name)).toBe(name);
    for (const target of NAVIGATION_TARGETS) expect(navigationTargetOf(target)).toBe(target);
    for (const retired of ['admin', 'dashboard', 'settings/nothing']) expect(navigationTargetOf(retired)).toBeNull();
    // The preload drops anything else before the page hears of it.
    for (const malformed of [
      null,
      undefined,
      42,
      [],
      {},
      'Today',
      ' today',
      'administration',
      'firm',
      'settings.html',
      'https://example.test/',
      '__proto__',
      'constructor',
      'toString',
      ['today'],
      { toString: () => 'today' },
    ]) {
      expect(routeNameOf(malformed), JSON.stringify(malformed) ?? String(malformed)).toBeNull();
    }
  });

  it('reads a route from text, a firm by its id and Settings by its tab, and nothing else', () => {
    const firmId = '11111111-1111-4111-8111-111111111111';
    expect(routeOf('today')).toEqual({ name: 'today' });
    expect(routeOf('settings')).toEqual({ name: 'settings', tab: 'administration' });
    expect(routeOf('settings/diagnostics')).toEqual({ name: 'settings', tab: 'diagnostics' });
    expect(routeOf(`firm/${firmId}`)).toEqual({ name: 'firm', firmId });
    for (const text of ['', 'firm', 'firm/', 'firm/not-an-id', `firm/${firmId}/x`, 'settings/elsewhere', 'today/x', 'Today']) {
      expect(routeOf(text), text).toBeNull();
    }
    for (const route of [{ name: 'firms' }, { name: 'firm', firmId }, { name: 'settings', tab: 'diagnostics' }] as const) {
      expect(routeOf(routeText(route))).toEqual(route);
    }
    expect(sidebarRowOf({ name: 'firm', firmId })).toBe('firms');
    expect(sidebarRowOf({ name: 'settings', tab: 'dashboard' })).toBe('settings');
  });

  it('maps 1.0.11 route names onto the Settings tab that holds what they opened', () => {
    // Links made before 1.0.12 exist on the owner's Mac, and the two keys people learned
    // are the two tabs beside Administration. Each opens the tab, and a section asks it
    // to scroll — which is what Needs you's Open has always meant.
    expect(routeOf('admin')).toEqual({ name: 'settings', tab: 'administration' });
    expect(routeOf('dashboard')).toEqual({ name: 'settings', tab: 'dashboard' });
    expect(routeOf('admin/calling-number')).toEqual({
      name: 'settings',
      tab: 'administration',
      section: 'calling-number',
    });
    expect(routeOf('admin/alerts')).toEqual({ name: 'settings', tab: 'diagnostics', section: 'alerts' });
    expect(routeOf('admin/elsewhere')).toBeNull();
    // The section is not part of the route's text: `settings/administration` is one
    // place, whether or not somebody arrived at it pointed at a section.
    expect(routeText({ name: 'settings', tab: 'administration', section: 'calling-number' })).toBe('settings/administration');
  });

  it('answers a deep link for each view and for the two retired names, and ignores every other link', () => {
    expect(DEEP_LINKS).toEqual([
      ...NAVIGATION_TARGETS.map(target => `callie://${target}`),
      'callie://admin',
      'callie://dashboard',
      'callie://settings',
    ]);
    expect(deepLinkRoute('callie://today')).toBe('today');
    expect(deepLinkRoute('callie://firms/')).toBe('firms');
    expect(deepLinkRoute('callie://settings/diagnostics')).toBe('settings/diagnostics');
    // 1.0.11's two links, each onto the tab that holds what it used to open.
    expect(deepLinkRoute('callie://admin')).toBe('settings/administration');
    expect(deepLinkRoute('callie://dashboard')).toBe('settings/dashboard');
    expect(deepLinkRoute('callie://settings')).toBe('settings/administration');
    for (const url of [
      'callie://firm/11111111-1111-4111-8111-111111111111',
      'callie://today?x=1',
      'callie://auth',
      'callie-app://bundle/index.html',
      'https://example.test/today',
      'callie://Today',
      'callie://',
    ]) {
      expect(deepLinkRoute(url), url).toBeNull();
    }
  });

  it('has no channel that opens a window: the main process tells the one window where to go', () => {
    expect(Object.values(IPC_CHANNELS)).toEqual([
      'callie:state',
      'callie:sign-in',
      'callie:sign-out',
      'callie:devices',
      'callie:device-revoke',
      'callie:navigate',
      // 1.0.12: main to page, and it opens nothing either — it says the session the
      // page was drawing for is over.
      'callie:session-changed',
    ]);
  });
});

describe('the Window menu (wave 1)', () => {
  it('shows each view in the one window: ⌘1 to ⌘4, then Settings with ⌘, and its two tabs', () => {
    const shown: string[] = [];
    const menu = windowMenuTemplate(route => {
      shown.push(route);
    });
    const window = menu.find(entry => 'label' in entry && entry.label === 'Window');
    if (window === undefined || !('submenu' in window)) throw new Error('no Window menu');
    const views = window.submenu.filter(item => 'click' in item);
    expect(views.map(item => ('label' in item ? `${item.label} ${item.accelerator}` : ''))).toEqual([
      'Today CmdOrCtrl+1',
      'Replies CmdOrCtrl+2',
      'Firms CmdOrCtrl+3',
      'Sequences CmdOrCtrl+4',
      'Settings CmdOrCtrl+,',
      'Dashboard CmdOrCtrl+5',
      'Diagnostics CmdOrCtrl+6',
    ]);
    for (const item of views) if ('click' in item) item.click();
    expect(shown).toEqual([
      'today',
      'replies',
      'firms',
      'sequences',
      'settings/administration',
      'settings/dashboard',
      'settings/diagnostics',
    ]);
  });

  it('is one Window menu, built whole rather than appended to Electron’s default', () => {
    const menu = windowMenuTemplate(() => undefined);
    expect(menu.filter(entry => 'label' in entry && entry.label === 'Window')).toHaveLength(1);
    expect(menu.filter(entry => 'role' in entry).map(entry => ('role' in entry ? entry.role : ''))).toEqual([
      'appMenu',
      'editMenu',
      'viewMenu',
    ]);
  });
});

/**
 * The device secret as this Mac's long-lived credential (wave 3b, audit item S7).
 *
 * The defect it closes: until wave 3b the only credential a running Mac held was the
 * rotating refresh credential, so losing it — a Mac restored from a backup, a second
 * window that had already spent it — meant a full Google sign-in. The device secret is
 * minted once at the claim, kept in the Keychain, never rotated, and
 * `POST /auth/session/open` takes it. `/auth/session/renew` has no caller here.
 */
describe('opening a session with the device secret (wave 3b, S7)', () => {
  it('opens with the Keychain secret, twice, and never renews', async () => {
    const mac = await started();
    await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: 'A Mac' });
    expect(mac.vault.entries.get(DEVICE_SECRET_ACCOUNT)).toBe(mac.script.grantedSecret());

    mac.advance(3_600_001);
    await mac.manager.refreshToday();
    mac.advance(3_600_001);
    await mac.manager.refreshToday();

    // Two opens with the same secret: opening twice is not reuse, so nothing rotates
    // and nothing is spent. The Keychain still holds the one it was given at the claim.
    expect(mac.script.calls.get('/auth/session/open')).toBe(2);
    expect(mac.script.calls.get('/auth/session/renew')).toBeUndefined();
    expect(mac.vault.entries.get(DEVICE_SECRET_ACCOUNT)).toBe(mac.script.grantedSecret());
    expect(mac.vault.entries.has(REFRESH_CREDENTIAL_ACCOUNT)).toBe(false);
  });

  it('a Mac signed out under the old server is told to sign in again, not retried forever', async () => {
    const mac = await started();
    await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: 'A Mac' });
    // The server has this device as revoked: a sign-out somebody made elsewhere.
    mac.script.refuse('/auth/session/open', 'device_revoked');
    mac.advance(3_600_001);
    const state = await mac.manager.refreshToday();
    expect(state.screen).toBe('sign_in');
    expect(state.notice).toBe('device_revoked');
    await expect(readFile(join(mac.directory, DEVICE_FILE), 'utf8')).rejects.toThrow();
    expect(mac.vault.entries.has(DEVICE_SECRET_ACCOUNT)).toBe(false);
  });

  /**
   * A3: `device.json` names a registration the Keychain has no secret for.
   *
   * A Mac restored without its Keychain, or one whose item somebody removed. There is
   * nothing to present and no amount of waiting will find it, so the registration goes
   * at startup — with a leftover `refresh-credential` item, which nothing has asked for
   * since wave 3b and which must not outlive the registration it belonged to.
   */
  it('wipes a registration whose device secret is gone, at startup, with its leftovers', async () => {
    const mac = await started();
    await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: 'A Mac' });
    // What 1.0.12 left behind, beside a Keychain somebody has emptied of the secret.
    await mac.vault.write(REFRESH_CREDENTIAL_ACCOUNT, 'fssr1.a.b.1.leftover');
    await mac.vault.remove(DEVICE_SECRET_ACCOUNT);

    const reopened = createSessionManager({
      api: mac.api,
      store: createDeviceStore({ directory: mac.directory, vault: mac.vault }),
      cache: createOfflineCache({ directory: mac.directory, vault: mac.vault, now: () => new Date('2026-09-21T10:00:01.000Z') }),
      clientVersion: CLIENT_VERSION,
      now: () => new Date('2026-09-21T10:00:01.000Z'),
      openInBrowser: async () => {
        await Promise.resolve();
      },
    });

    const state = await reopened.state();
    expect(state.screen).toBe('sign_in');
    expect(state.device).toBeNull();
    expect(state.notice).toBe('not_signed_in');
    await expect(readFile(join(mac.directory, DEVICE_FILE), 'utf8')).rejects.toThrow();
    expect(mac.vault.entries.has(REFRESH_CREDENTIAL_ACCOUNT)).toBe(false);
    // And nothing was asked of the server about a registration that cannot be used.
    expect(mac.script.calls.get('/auth/session/open')).toBeUndefined();
  });

  it('wipes it at an open too, when the item goes while the app is running', async () => {
    const mac = await started();
    await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: 'A Mac' });
    await mac.vault.remove(DEVICE_SECRET_ACCOUNT);
    mac.advance(3_600_001);
    const state = await mac.manager.refreshToday();
    expect(state.screen).toBe('sign_in');
    expect(state.notice).toBe('not_signed_in');
    expect(mac.script.calls.get('/auth/session/open')).toBeUndefined();
  });
});

/**
 * A2: a sign-out tells the server first, and forgets the Keychain secret after.
 *
 * The other order leaves a device the workspace still counts as active and nothing on
 * this Mac able to revoke it.
 */
describe('signing out (wave 3b, A2)', () => {
  it('tells the server, then forgets, when it can reach it', async () => {
    const mac = await started();
    await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: 'A Mac' });
    const out = await mac.manager.signOut();

    expect(mac.script.calls.get('/auth/sign-out')).toBe(1);
    expect(mac.script.deviceActive()).toBe(false);
    expect(out.screen).toBe('sign_in');
    expect(out.device).toBeNull();
    expect(out.notice).toBe('signed_out');
    expect(mac.vault.entries.has(DEVICE_SECRET_ACCOUNT)).toBe(false);
    await expect(readFile(join(mac.directory, DEVICE_FILE), 'utf8')).rejects.toThrow();
  });

  it('shows the signed-out screen offline, keeps the secret, and finishes when it is back', async () => {
    const mac = await started();
    await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: 'A Mac' });
    const kept = mac.vault.entries.get(DEVICE_SECRET_ACCOUNT);

    mac.script.offline(true);
    const pending = await mac.manager.signOut();
    // Signed out here and now, with one line saying what is left to do.
    expect(pending.screen).toBe('sign_in');
    expect(pending.device).toBeNull();
    expect(pending.notice).toBe('sign_out_pending');
    expect(buildScreenView(pending).banners.map(banner => banner.text)).toContain(
      'This Mac still has to tell the server it signed out; Callie retries when it is back online.',
    );
    // The secret and the ids are kept, and nothing but the retry may use them.
    expect(mac.vault.entries.get(DEVICE_SECRET_ACCOUNT)).toBe(kept);
    expect(JSON.parse(await readFile(join(mac.directory, DEVICE_FILE), 'utf8'))).toMatchObject({ signOutPending: true });
    expect(await mac.manager.accessToken()).toBeNull();
    expect(await mac.manager.mayMutateNow()).toEqual({ allowed: false, refusal: 'not_signed_in' });
    // The call was attempted and did not arrive, which is the whole point: the server
    // still has this device, so the secret may not be forgotten yet.
    expect(mac.script.deviceActive()).toBe(true);

    // Back online: open, sign out, forget — in that order.
    // Back online: open, sign out, forget — in that order. The counter is attempts,
    // and the offline one counted, so what is waited for is the server's own state.
    mac.script.offline(false);
    mac.manager.noteConnection(true);
    await eventually(() => !mac.script.deviceActive(), 'the sign-out to reach the server');
    expect(mac.script.calls.get('/auth/session/open')).toBeGreaterThanOrEqual(1);
    await eventually(() => !mac.vault.entries.has(DEVICE_SECRET_ACCOUNT), 'the secret to be forgotten');
    await expect(readFile(join(mac.directory, DEVICE_FILE), 'utf8')).rejects.toThrow();
  });

  it('finishes a sign-out left pending by a previous run, at the next launch', async () => {
    const mac = await started();
    await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: 'A Mac' });
    mac.script.offline(true);
    await mac.manager.signOut();
    mac.script.offline(false);

    // The app opened again over the same directory and Keychain.
    const reopened = createSessionManager({
      api: mac.api,
      store: createDeviceStore({ directory: mac.directory, vault: mac.vault }),
      cache: createOfflineCache({ directory: mac.directory, vault: mac.vault, now: () => new Date('2026-09-21T10:00:01.000Z') }),
      clientVersion: CLIENT_VERSION,
      now: () => new Date('2026-09-21T10:00:01.000Z'),
      openInBrowser: async () => {
        await Promise.resolve();
      },
    });
    // The window sees the sign-in form from the first read, whatever the retry does.
    expect((await reopened.state()).screen).toBe('sign_in');
    await eventually(() => !mac.script.deviceActive(), 'the sign-out to reach the server');
    await eventually(() => !mac.vault.entries.has(DEVICE_SECRET_ACCOUNT), 'the secret to be forgotten');
  });
});

/** A4: the workspace's other Macs, and signing one of them out. */
describe('the other Macs in the workspace (wave 3b, A4)', () => {
  const OTHER = '99999999-9999-4999-8999-999999999999';

  it('lists them beside this one, and signs one out by id', async () => {
    const mac = await started();
    await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: 'A Mac' });
    mac.script.otherDevices([
      {
        deviceId: OTHER,
        deviceLabel: "David's old MacBook",
        status: 'active',
        registeredAt: '2026-09-01T12:00:00.000Z',
        lastSeenAt: '2026-09-19T12:00:00.000Z',
        clientVersion: '1.0.12',
        thisDevice: false,
      },
    ]);

    const listed = await mac.manager.listDevices();
    expect(listed.devices?.map(entry => [entry.deviceLabel, entry.thisDevice])).toEqual([
      ['This Mac', true],
      ["David's old MacBook", false],
    ]);

    const revoked = await mac.manager.revokeDevice({ deviceId: OTHER });
    expect(revoked.notice).toBe('device_revoked_elsewhere');
    expect(revoked.devices?.find(entry => entry.deviceId === OTHER)?.status).toBe('revoked');
    // This Mac is still signed in: it revoked somebody else's.
    expect(revoked.device).not.toBeNull();
    expect(mac.vault.entries.has(DEVICE_SECRET_ACCOUNT)).toBe(true);
  });

  it('revoking this Mac is this Mac signing out, and the server has already been told', async () => {
    const mac = await started();
    const signedIn = await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: 'A Mac' });
    const mine = signedIn.device?.deviceId ?? '';

    const after = await mac.manager.revokeDevice({ deviceId: mine });
    expect(after.screen).toBe('sign_in');
    expect(after.device).toBeNull();
    expect(after.notice).toBe('signed_out');
    expect(mac.vault.entries.has(DEVICE_SECRET_ACCOUNT)).toBe(false);
    await expect(readFile(join(mac.directory, DEVICE_FILE), 'utf8')).rejects.toThrow();
  });
});

/**
 * Every identity transition empties this Mac (1.0.13, P0-A).
 *
 * The rule is one sentence and it had three holes: a sign-out waiting to be told to the
 * server left the encrypted cache and the list in memory where they were; a role change
 * left both; and only the reply bridge was cleared on the announcement, so the CRM and
 * settings bridges answered the next read from the last person's snapshot.
 */
describe('an identity transition empties this Mac (P0-A)', () => {
  const listed = (mac: DesktopFixture): SessionChange[] => {
    const seen: SessionChange[] = [];
    mac.manager.onSessionChange(change => seen.push(change));
    return seen;
  };

  it('wipes the cache and the list when a sign-out is only pending', async () => {
    const mac = await started();
    await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: 'A Mac' });
    await mac.manager.refreshToday();
    expect((await mac.manager.state()).today?.cards).not.toHaveLength(0);
    await expect(readFile(join(mac.directory, CACHE_FILE), 'utf8')).resolves.toContain('"');

    mac.script.offline(true);
    const seen = listed(mac);
    const pending = await mac.manager.signOut();

    expect(pending.notice).toBe('sign_out_pending');
    expect(pending.today).toBeNull();
    expect(pending.stale).toBe(false);
    // The file on disk, not only the copy in memory: it is an encrypted list of the
    // last person's firms and it must not be there to be read.
    await expect(readFile(join(mac.directory, CACHE_FILE), 'utf8')).rejects.toThrow();
    // And the window was told, so it can empty everything it was holding.
    expect(seen.map(change => change.identity)).toEqual([null]);
  });

  it('drops a Today read that lands after the wipe, rather than writing it back', async () => {
    /*
     * `/today` can be on the wire when somebody signs out. The wipe empties the cache
     * and the list; this answer, landing afterwards, would put the last person's firms
     * straight back on to the disk — under the next person's session.
     */
    const mac = await started();
    await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: 'A Mac' });
    await mac.manager.refreshToday();
    await expect(readFile(join(mac.directory, CACHE_FILE), 'utf8')).resolves.toContain('"');

    mac.script.hold('/today');
    const reading = mac.manager.refreshToday();
    await eventually(() => mac.script.holding('/today'), 'the list read to reach the server');

    // Signed out while it is still on the wire, and the cache goes.
    await mac.manager.signOut();
    await expect(readFile(join(mac.directory, CACHE_FILE), 'utf8')).rejects.toThrow();

    mac.script.release('/today');
    const late = await reading;

    expect(late.today).toBeNull();
    // Nothing was written back: the file is still gone.
    await expect(readFile(join(mac.directory, CACHE_FILE), 'utf8')).rejects.toThrow();
    expect((await mac.manager.state()).today).toBeNull();
  });

  it('drops a Today read that lands while the wipe is still running', async () => {
    /*
     * The window between the wipe and the number moving (item 4).
     *
     * Emptying this Mac is asynchronous — a file being removed — and the number that
     * tells a late answer it is stale used to move only afterwards, at the announcement.
     * An answer landing in between saw a number it recognised and wrote itself back on
     * to the disk that had just been cleared. The number moves first now, so the wipe
     * is held open here and the read released into that window.
     */
    const mac = await started({ holdCacheWipe: true });
    await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: 'A Mac' });
    await mac.manager.refreshToday();
    await expect(readFile(join(mac.directory, CACHE_FILE), 'utf8')).resolves.toContain('"');

    // The list the server will answer the held read with: a day nothing else uses, so
    // that finding it anywhere afterwards means the late answer was stored.
    mac.script.today({ ...sampleToday(mac.workspaceId), snapshotDate: '2026-09-22' });
    mac.script.hold('/today');
    const reading = mac.manager.refreshToday();
    await eventually(() => mac.script.holding('/today'), 'the list read to reach the server');

    // The sign-out stops inside the wipe: the cache is going but the file is still there.
    const signingOut = mac.manager.signOut();
    await eventually(() => mac.wipeHeld(), 'the wipe to be held open');

    mac.script.release('/today');
    const late = await reading;
    // It answered with what this Mac was already holding, not with what it read.
    expect(late.today?.snapshotDate).not.toBe('2026-09-22');

    mac.releaseCacheWipe();
    await signingOut;
    // Nothing was written into the window: the file is gone and stays gone.
    await expect(readFile(join(mac.directory, CACHE_FILE), 'utf8')).rejects.toThrow();
    expect((await mac.manager.state()).today).toBeNull();
  });

  it('wipes the cache when the role changes, without a sign-out', async () => {
    const mac = await started();
    await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: 'A Mac' });
    await mac.manager.refreshToday();
    await expect(readFile(join(mac.directory, CACHE_FILE), 'utf8')).resolves.toContain('"');

    const seen = listed(mac);
    const before = mac.cacheWipes();
    mac.script.role('admin');
    mac.advance(3_600_001);
    const promoted = await mac.manager.refreshToday();

    expect(seen.map(change => change.reason)).toEqual(['role_changed']);
    expect(promoted.device?.role).toBe('admin');
    /*
     * The list on this Mac was read under the old role. 8.2 is the difference between
     * the two — a salesperson's Today is not an admin's — so it goes at the moment the
     * change is seen, and the read that follows fills the cache again under the new
     * one. The count is the assertion: the file is there either way.
     */
    expect(mac.cacheWipes()).toBe(before + 1);
    expect(promoted.stale).toBe(false);
  });
});

/**
 * A sign-out on the wire and a sign-in do not fight over the registration (P0-B).
 *
 * The retry captured a device; a sign-in writes another. Before the review, the retry's
 * `forget()` was bound to nothing and deleted whichever registration it found.
 */
describe('a sign-out retry and a sign-in (P0-B)', () => {
  /** Sign out with the server unreachable, so the Mac owes it a sign-out. */
  const owing = async (mac: DesktopFixture): Promise<void> => {
    await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: 'A Mac' });
    mac.script.offline(true);
    await mac.manager.signOut();
    expect((await mac.manager.state()).notice).toBe('sign_out_pending');
    mac.script.offline(false);
  };

  it('makes a sign-in wait for the retry already on the wire', async () => {
    const mac = await started();
    await owing(mac);

    // The retry reaches the server and stops inside it, exactly where a slow network
    // would leave it.
    mac.script.hold('/auth/sign-out');
    void mac.manager.noteConnection(true);
    await eventually(() => mac.script.holding('/auth/sign-out'), 'the retry to reach the server');
    const startsBefore = mac.script.calls.get('/auth/sign-in/start') ?? 0;
    const opensBefore = mac.openedUrls.length;

    let done = false;
    const signingIn = mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: 'A Mac' }).then(state => {
      done = true;
      return state;
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    // Nothing of the sign-in has started: not the first call, not the browser.
    expect(done).toBe(false);
    expect(mac.script.calls.get('/auth/sign-in/start') ?? 0).toBe(startsBefore);
    expect(mac.openedUrls).toHaveLength(opensBefore);

    mac.script.release('/auth/sign-out');
    const signedIn = await signingIn;

    expect(signedIn.screen).toBe('today');
    expect(mac.vault.entries.get(DEVICE_SECRET_ACCOUNT)).toBe(mac.script.grantedSecret());
    await expect(readFile(join(mac.directory, DEVICE_FILE), 'utf8')).resolves.toContain('"deviceId"');
  });

  it('holds a sign-in behind the live-token sign-out, which forgets only the device it began on', async () => {
    /*
     * The sign-out this Mac makes with the token in hand (P0-C) used to run outside the
     * lock and without the ownership check: while its `/auth/sign-out` was on the wire a
     * sign-in could finish, and the `forget()` that followed deleted the *new*
     * registration and the new Keychain secret — leaving a Mac that looked signed out
     * and a device still active at the server that nothing here could revoke.
     */
    const mac = await started();
    await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: 'A Mac' });
    const first = mac.script.grantedSecret();

    mac.script.hold('/auth/sign-out');
    const signingOut = mac.manager.signOut();
    await eventually(() => mac.script.holding('/auth/sign-out'), 'the sign-out to reach the server');
    const startsBefore = mac.script.calls.get('/auth/sign-in/start') ?? 0;

    let signedInYet = false;
    const signingIn = mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: 'A Mac' }).then(state => {
      signedInYet = true;
      return state;
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    // The sign-in has not begun: it is behind the same lock the retry takes.
    expect(signedInYet).toBe(false);
    expect(mac.script.calls.get('/auth/sign-in/start') ?? 0).toBe(startsBefore);

    mac.script.release('/auth/sign-out');
    await signingOut;
    const signedIn = await signingIn;

    expect(signedIn.screen).toBe('today');
    // The new registration and the new secret survived the sign-out's cleanup, and the
    // secret really is a new one.
    const second = mac.script.grantedSecret();
    expect(second).not.toBe(first);
    expect(mac.vault.entries.get(DEVICE_SECRET_ACCOUNT)).toBe(second);
    await expect(readFile(join(mac.directory, DEVICE_FILE), 'utf8')).resolves.toContain('"deviceId"');
    const after = await mac.manager.state();
    expect(after.device).not.toBeNull();
  });

  it('refuses to sign in at all while the server has not been told, and says why', async () => {
    /*
     * There is one `device-secret` item on this Mac and a sign-in overwrites it. Signing
     * in over a sign-out the server has not heard about leaves that device active for
     * ever with nothing here able to revoke it — so the sign-in does not start.
     */
    const mac = await started();
    await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: 'A Mac' });
    const owed = mac.script.grantedSecret();
    mac.script.offline(true);
    await mac.manager.signOut();
    const startsBefore = mac.script.calls.get('/auth/sign-in/start') ?? 0;
    const opensBefore = mac.openedUrls.length;

    const refused = await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: 'A Mac' });

    expect(refused.notice).toBe('sign_out_pending');
    // The sign-in form, with the line under it: this Mac is not signed in to anything.
    expect(refused.screen).toBe('sign_in');
    expect(mac.script.calls.get('/auth/sign-in/start') ?? 0).toBe(startsBefore);
    expect(mac.openedUrls).toHaveLength(opensBefore);
    // Nothing was overwritten: the credential that will end that device is still here.
    expect(mac.vault.entries.get(DEVICE_SECRET_ACCOUNT)).toBe(owed);
    expect(mac.script.deviceActive()).toBe(true);
  });

  it('tells the server first when it can, and only then signs in', async () => {
    const mac = await started();
    await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: 'A Mac' });
    const owed = mac.script.grantedSecret();
    mac.script.offline(true);
    await mac.manager.signOut();
    expect((await mac.manager.state()).notice).toBe('sign_out_pending');

    mac.script.offline(false);
    const from = mac.script.order.length;
    const signedIn = await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: 'A Mac' });

    expect(signedIn.screen).toBe('today');
    // In this order: the owed sign-out, then the sign-in it was blocking.
    const order = mac.script.order
      .slice(from)
      .filter(path => path === '/auth/sign-out' || path === '/auth/sign-in/start');
    expect(order[0]).toBe('/auth/sign-out');
    expect(order).toContain('/auth/sign-in/start');
    // A new secret, and the old device is not still active at the server.
    expect(mac.vault.entries.get(DEVICE_SECRET_ACCOUNT)).not.toBe(owed);
    expect(mac.vault.entries.get(DEVICE_SECRET_ACCOUNT)).toBe(mac.script.grantedSecret());
  });

  it('is not ended by a transition: a Mac on the upgrade screen still owes the sign-out', async () => {
    /*
     * `true` from an attempt means one of three things and nothing else: the server
     * confirmed, the server said the registration is already over, or the registration
     * is no longer on this Mac. Until this review it could also mean "the session
     * generation moved", because the ownership test read that number — and a refusal by
     * client version announces a transition on the very same pending device. The clock
     * stopped on a sign-out that had *failed*, and the sign-in waiting behind it
     * overwrote the one `device-secret` this Mac holds, leaving a device active at the
     * server that nothing here could revoke. A registration is its device id.
     *
     * The scenario: the API raises its minimum, this build is refused, and the person
     * signs out from the upgrade screen while the server is unreachable.
     */
    const ticked: (() => void)[] = [];
    let cleared = 0;
    const mac = await started({
      setInterval: (run: () => void) => {
        ticked.push(run);
        return ticked.length as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval: () => {
        cleared += 1;
      },
    });
    await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: 'A Mac' });
    const owed = mac.script.grantedSecret();

    const seen: SessionChange[] = [];
    mac.manager.onSessionChange(change => seen.push(change));
    mac.script.refuse('/auth/session/open', 'client_upgrade_required');
    mac.advance(3_600_001);
    expect((await mac.manager.refreshToday()).screen).toBe('upgrade_required');
    // The transition that used to end the sign-out by accident.
    expect(seen.map(change => change.reason)).toEqual(['client_upgrade_required']);

    mac.script.offline(true);
    await mac.manager.signOut();
    expect((await mac.manager.state()).notice).toBe('sign_out_pending');
    expect(ticked).toHaveLength(1);

    // An attempt that fails while the refusal stands is still a failure.
    mac.script.offline(false);
    mac.script.refuse('/auth/session/open', 'server_unavailable');
    ticked[0]?.();
    await eventually(() => (mac.script.calls.get('/auth/session/open') ?? 0) > 1, 'the retry to reach the server');
    await new Promise(resolve => setTimeout(resolve, 20));

    // The attempt failed, so nothing may report it as finished: the device is still
    // the server's to see, the clock is still armed, and the credential is still here.
    expect(mac.script.deviceActive()).toBe(true);
    expect(cleared).toBe(0);
    expect(mac.vault.entries.get(DEVICE_SECRET_ACCOUNT)).toBe(owed);

    // And a sign-in attempted while it is still owed does not start.
    mac.script.offline(true);
    const refused = await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: 'A Mac' });
    expect(refused.notice).toBe('sign_out_pending');
    expect(mac.vault.entries.get(DEVICE_SECRET_ACCOUNT)).toBe(owed);
    expect(mac.script.deviceActive()).toBe(true);

    // The server comes back: the owed sign-out lands first, and only then the sign-in.
    mac.script.offline(false);
    const from = mac.script.order.length;
    const signedIn = await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: 'A Mac' });
    expect(signedIn.screen).toBe('today');
    const order = mac.script.order
      .slice(from)
      .filter(path => path === '/auth/sign-out' || path === '/auth/sign-in/start');
    expect(order[0]).toBe('/auth/sign-out');
  });

  it('opens no session and announces nothing while it owes one, so no transition can reach the attempt', async () => {
    /*
     * The other half of the P0, and the reason the mid-flight case above cannot be
     * driven through this interface at all: a Mac that owes the server a sign-out makes
     * no authenticated call, so nothing it does can renew, change a role, or be refused
     * by version. The credential it is keeping is the retry's and nobody else's.
     */
    const mac = await started();
    await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: 'A Mac' });
    mac.script.offline(true);
    await mac.manager.signOut();
    mac.script.offline(false);
    const opensBefore = mac.script.calls.get('/auth/session/open') ?? 0;

    const seen: SessionChange[] = [];
    mac.manager.onSessionChange(change => seen.push(change));
    await mac.manager.refreshToday();
    await mac.manager.mayMutateNow();
    await mac.manager.accessToken();
    await mac.manager.listDevices();

    expect(seen).toEqual([]);
    expect(mac.script.calls.get('/auth/session/open') ?? 0).toBe(opensBefore);
    expect((await mac.manager.state()).notice).toBe('sign_out_pending');
  });

  it('keeps the clock running when an attempt fails, so the next one still comes', async () => {
    const ticked: (() => void)[] = [];
    let cleared = 0;
    const mac = await started({
      setInterval: (run: () => void) => {
        ticked.push(run);
        return ticked.length as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval: () => {
        cleared += 1;
      },
    });
    await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: 'A Mac' });
    mac.script.offline(true);
    await mac.manager.signOut();
    expect(ticked).toHaveLength(1);

    // A sign-in attempted while still offline fails, and used to stop the clock on its
    // way through: the Mac then owed a sign-out with nothing left to try it again.
    const refused = await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: 'A Mac' });
    expect(refused.notice).toBe('sign_out_pending');
    expect(cleared).toBe(0);

    // A transition of its own — the role the server now gives, a version refusal — moves
    // the session number and stops nothing: the server has still not been told.
    mac.script.offline(false);
    mac.script.role('admin');
    mac.advance(3_600_001);
    await mac.manager.refreshToday();
    expect(cleared).toBe(0);
    expect((await mac.manager.state()).notice).toBe('sign_out_pending');

    // And the clock that is still running does finish it once the server is back.
    ticked[0]?.();
    /*
     * The condition is the client's own state, not the server's flag. The fake server
     * marks the device inactive inside the request handler, which is several awaits —
     * the cache wipe, `store.forget()` — before the retry writes `signed_out` here; a
     * loaded machine reads the stale notice in between.
     */
    await eventually(async () => (await mac.manager.state()).notice === 'signed_out', 'the retry to finish');
    expect(mac.script.deviceActive()).toBe(false);
  });
});

/** The immediate sign-out uses the token in hand (P0-C). */
describe('signing out with a live session (P0-C)', () => {
  it('sends one call and opens nothing', async () => {
    const mac = await started();
    await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: 'A Mac' });
    const opensBefore = mac.script.calls.get('/auth/session/open') ?? 0;

    await mac.manager.signOut();

    expect(mac.script.calls.get('/auth/sign-out')).toBe(1);
    expect(mac.script.calls.get('/auth/session/open') ?? 0).toBe(opensBefore);
    expect(mac.script.deviceActive()).toBe(false);
  });
});

/** The retry has a clock of its own (P1-1). */
describe('a pending sign-out finishes on its own clock (P1-1)', () => {
  it('tries again on the interval and announces when it lands', async () => {
    const ticks: (() => void)[] = [];
    const mac = await started({
      setInterval: (run: () => void) => {
        ticks.push(run);
        return 0 as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval: () => undefined,
    });
    await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: 'A Mac' });
    mac.script.offline(true);
    await mac.manager.signOut();
    expect((await mac.manager.state()).notice).toBe('sign_out_pending');
    expect(ticks).toHaveLength(1);

    const seen: SessionChange[] = [];
    mac.manager.onSessionChange(change => seen.push(change));
    mac.script.offline(false);
    ticks[0]?.();
    await eventually(() => !mac.script.deviceActive(), 'the retry to reach the server');
    await eventually(() => seen.length > 0, 'the transition to be announced');

    // The identity was already null, so the window would have heard nothing without a
    // forced announcement — and the line under the sign-in form would have stayed.
    expect(seen[0]).toMatchObject({ reason: 'signed_out', identity: null });
    expect((await mac.manager.state()).notice).toBe('signed_out');
  });

  it('tries once at launch, with a pending sign-out found on disk', async () => {
    const mac = await started();
    await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: 'A Mac' });
    mac.script.offline(true);
    await mac.manager.signOut();
    expect(mac.script.deviceActive()).toBe(true);

    // The app is closed and opened again, with the server reachable this time.
    mac.script.offline(false);
    const reopened = createSessionManager({
      api: mac.api,
      store: createDeviceStore({ directory: mac.directory, vault: mac.vault }),
      cache: createOfflineCache({ directory: mac.directory, vault: mac.vault, now: () => new Date('2026-09-21T10:00:01.000Z') }),
      clientVersion: CLIENT_VERSION,
      now: () => new Date('2026-09-21T10:00:01.000Z'),
      openInBrowser: async () => {
        await Promise.resolve();
      },
    });

    // Loading is what starts it; nothing is pressed and no clock has ticked.
    expect((await reopened.state()).screen).toBe('sign_in');
    await eventually(() => !mac.script.deviceActive(), 'the launch attempt to reach the server');
    await eventually(async () => (await reopened.state()).notice === 'signed_out', 'the notice to clear');
    await expect(readFile(join(mac.directory, DEVICE_FILE), 'utf8')).rejects.toThrow();
  });
});

/** A refusal by version is the upgrade screen, not a notice under a usable page (P1-2). */
describe('an open refused for the client version (P1-2)', () => {
  it('shows the upgrade screen and closes mutations', async () => {
    const mac = await started();
    await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: 'A Mac' });
    expect((await mac.manager.state()).screen).toBe('today');

    // Nobody pressed anything: the renewal behind a background list read is refused.
    const seen: SessionChange[] = [];
    mac.manager.onSessionChange(change => seen.push(change));
    mac.script.refuse('/auth/session/open', 'client_upgrade_required');
    mac.advance(3_600_001);
    const refused = await mac.manager.refreshToday();

    // The window is told, or it stays on a page whose controls are all refused (P1-2).
    expect(seen.map(change => change.reason)).toEqual(['client_upgrade_required']);
    expect(refused.screen).toBe('upgrade_required');
    expect(refused.mayMutate).toBe(false);
    expect(await mac.manager.mayMutateNow()).toEqual({ allowed: false, refusal: 'client_upgrade_required' });
    // Still registered: an out-of-date build is not a signed-out one.
    expect(mac.vault.entries.has(DEVICE_SECRET_ACCOUNT)).toBe(true);
  });
});

/**
 * A Keychain that could not be asked is not a Keychain with nothing in it (P1-3).
 *
 * Only `errSecItemNotFound` is absence. Reading a locked Keychain as "no secret" is how
 * A3's startup check would have signed the owner out and deleted the registration.
 */
describe('a Keychain that cannot answer (P1-3)', () => {
  const vaultThatFails = (): SecretVault & { readonly entries: Map<string, string> } => {
    const real = createMemoryVault();
    return {
      entries: real.entries,
      read: async () => await Promise.reject(new KeychainError('read_failed')),
      write: real.write,
      remove: real.remove,
    };
  };

  it('keeps the registration and says so, at startup', async () => {
    const mac = await started();
    await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: 'A Mac' });

    const reopened = createSessionManager({
      api: mac.api,
      store: createDeviceStore({ directory: mac.directory, vault: vaultThatFails() }),
      cache: createOfflineCache({ directory: mac.directory, vault: mac.vault, now: () => new Date('2026-09-21T10:00:01.000Z') }),
      clientVersion: CLIENT_VERSION,
      now: () => new Date('2026-09-21T10:00:01.000Z'),
      openInBrowser: async () => {
        await Promise.resolve();
      },
    });

    const state = await reopened.state();
    expect(state.notice).toBe('keychain_unreadable');
    expect(state.device).not.toBeNull();
    // Nothing was deleted: the registration and the item are exactly where they were.
    await expect(readFile(join(mac.directory, DEVICE_FILE), 'utf8')).resolves.toContain('"deviceId"');
    expect(mac.vault.entries.has(DEVICE_SECRET_ACCOUNT)).toBe(true);
  });

  it('refuses the open and forgets nothing, while the app is running', async () => {
    const failing = vaultThatFails();
    const mac = await started();
    await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: 'A Mac' });
    const running = createSessionManager({
      api: mac.api,
      store: createDeviceStore({ directory: mac.directory, vault: failing }),
      cache: createOfflineCache({ directory: mac.directory, vault: mac.vault, now: () => new Date('2026-09-21T11:00:01.000Z') }),
      clientVersion: CLIENT_VERSION,
      now: () => new Date('2026-09-21T11:00:01.000Z'),
      openInBrowser: async () => {
        await Promise.resolve();
      },
    });
    await running.state();
    expect(await running.accessToken()).toBeNull();
    expect((await running.state()).device).not.toBeNull();
    expect(mac.script.calls.get('/auth/session/open')).toBeUndefined();
  });

  it('reads exit 44 as "no such item" and every other failure as a failure', async () => {
    const exits = new Map<string, number>([['find-generic-password', 44]]);
    const vault = createKeychainVault({
      service: 'test.fss',
      runner: async (_command, args) =>
        await Promise.resolve({ code: exits.get(args[0] ?? '') ?? 0, stdout: '', stderr: '' }),
    });
    expect(await vault.read('device-secret')).toBeNull();

    exits.set('find-generic-password', 51);
    await expect(vault.read('device-secret')).rejects.toThrow('keychain_read_failed');
  });
});

/** P2-2: 1.0.12's rotating credential goes at the first startup that finds it. */
describe('the credential 1.0.12 left behind (P2-2)', () => {
  it('is removed at the first startup of this build, not at the next sign-out', async () => {
    const mac = await started();
    await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: 'A Mac' });
    await mac.vault.write(REFRESH_CREDENTIAL_ACCOUNT, 'fssr1.a.b.1.leftover');

    const reopened = createSessionManager({
      api: mac.api,
      store: createDeviceStore({ directory: mac.directory, vault: mac.vault }),
      cache: createOfflineCache({ directory: mac.directory, vault: mac.vault, now: () => new Date('2026-09-21T10:00:01.000Z') }),
      clientVersion: CLIENT_VERSION,
      now: () => new Date('2026-09-21T10:00:01.000Z'),
      openInBrowser: async () => {
        await Promise.resolve();
      },
    });

    expect((await reopened.state()).device).not.toBeNull();
    expect(mac.vault.entries.has(REFRESH_CREDENTIAL_ACCOUNT)).toBe(false);
    // And the one this build does use is untouched.
    expect(mac.vault.entries.has(DEVICE_SECRET_ACCOUNT)).toBe(true);
  });

  it('still loads and works when the Keychain refuses the delete', async () => {
    /*
     * The removal runs inside the one `ensureLoaded`, after `loaded` is already true, so
     * a rejection here would reject the first `state()` the window ever asks for and no
     * later call would retry it: the Mac would sit on a blank window because a *dead*
     * item could not be deleted. It is best effort, and the next launch tries again.
     */
    const mac = await started();
    await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: 'A Mac' });
    await mac.vault.write(REFRESH_CREDENTIAL_ACCOUNT, 'fssr1.a.b.1.leftover');
    const refusing: SecretVault & { readonly entries: Map<string, string> } = {
      entries: mac.vault.entries,
      read: mac.vault.read,
      write: mac.vault.write,
      remove: async account =>
        account === REFRESH_CREDENTIAL_ACCOUNT
          ? await Promise.reject(new KeychainError('remove_failed'))
          : await mac.vault.remove(account),
    };

    const reopened = createSessionManager({
      api: mac.api,
      store: createDeviceStore({ directory: mac.directory, vault: refusing }),
      cache: createOfflineCache({ directory: mac.directory, vault: mac.vault, now: () => new Date('2026-09-21T10:00:01.000Z') }),
      clientVersion: CLIENT_VERSION,
      now: () => new Date('2026-09-21T10:00:01.000Z'),
      openInBrowser: async () => {
        await Promise.resolve();
      },
    });

    // It loads, it is signed in, and it can still read: nothing is stuck.
    const state = await reopened.state();
    expect(state.device).not.toBeNull();
    expect(state.screen).toBe('today');
    expect(state.notice).toBe('keychain_unreadable');
    const listed = await reopened.refreshToday();
    expect(listed.today).not.toBeNull();
    // The item that could not be deleted is still there, for the next launch to try.
    expect(mac.vault.entries.has(REFRESH_CREDENTIAL_ACCOUNT)).toBe(true);

    // The next launch, with a Keychain that answers: it is deleted, and the notice goes.
    const later = createSessionManager({
      api: mac.api,
      store: createDeviceStore({ directory: mac.directory, vault: mac.vault }),
      cache: createOfflineCache({ directory: mac.directory, vault: mac.vault, now: () => new Date('2026-09-21T11:00:01.000Z') }),
      clientVersion: CLIENT_VERSION,
      now: () => new Date('2026-09-21T11:00:01.000Z'),
      openInBrowser: async () => {
        await Promise.resolve();
      },
    });

    const second = await later.state();
    expect(second.device).not.toBeNull();
    expect(second.notice).toBeNull();
    expect(mac.vault.entries.has(REFRESH_CREDENTIAL_ACCOUNT)).toBe(false);
    expect(mac.vault.entries.has(DEVICE_SECRET_ACCOUNT)).toBe(true);
  });
});
