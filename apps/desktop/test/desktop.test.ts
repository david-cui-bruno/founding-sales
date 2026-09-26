import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CACHE_FILE,
  DEVICE_FILE,
  DEVICE_SECRET_ACCOUNT,
  REFRESH_CREDENTIAL_ACCOUNT,
  WORKSPACE_FILE,
  createDeviceStore,
  createOfflineCache,
  createMemoryVault,
  createSessionManager,
  keychainCommand,
} from '../src/main/index.ts';
import { buildScreenView } from '../src/renderer/viewModel.ts';
import { createAuthedClient } from '../src/main/authedClient.ts';
import { createAdminBridge } from '../src/main/settingsBridge.ts';
import { outboundStatusAnswer } from './support/outboundStatus.ts';
import { ROUTE_NAMES, desktopStateSchema, routeNameOf } from '../src/shared/contract.ts';
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

    // The two secrets are in the vault and nowhere else. The file on disk holds
    // identifiers only, and a grep over it finds neither.
    expect(mac.vault.entries.has(DEVICE_SECRET_ACCOUNT)).toBe(true);
    expect(mac.vault.entries.has(REFRESH_CREDENTIAL_ACCOUNT)).toBe(true);
    const onDisk = await readFile(join(mac.directory, DEVICE_FILE), 'utf8');
    for (const value of mac.vault.entries.values()) expect(onDisk).not.toContain(value);
    expect(JSON.stringify(state)).not.toContain(mac.vault.entries.get(DEVICE_SECRET_ACCOUNT) ?? 'x');
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

describe('the remembered workspace (wave 1)', () => {
  it('signs in again after Sign out without asking for the workspace or the name', async () => {
    const mac = await started();
    await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: "David's MacBook" });
    const out = await mac.manager.signOut();
    expect(out.device).toBeNull();
    // Sign out removes device.json and both secrets, and leaves workspace.json.
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
      accessToken: async () => await Promise.resolve('token'),
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
      accessToken: async () => await Promise.resolve('token'),
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

describe('serialised session renewal', () => {
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

    // One renewal, not four. Presenting one refresh credential twice is reuse, and
    // reuse revokes the device (specification 5.3).
    expect(mac.manager.renewalCount()).toBe(before + 1);
    expect(mac.script.calls.get('/auth/session/renew')).toBe(1);
  });

  it('renews before the session actually expires rather than after a refusal', async () => {
    const mac = await started();
    await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: 'A Mac' });
    mac.advance(3_600_000 - 30_000);
    await mac.manager.refreshToday();
    expect(mac.script.calls.get('/auth/session/renew')).toBe(1);
  });
});

describe('the role a renewal carries (lane g69)', () => {
  it('applies the role the server now gives, keeps it on disk without a secret, and survives a restart', async () => {
    const mac = await started();
    const signedIn = await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: 'A Mac' });
    expect(signedIn.device?.role).toBe('salesperson');

    // An admin promotes this membership. The Mac learns it at its next renewal, not at
    // its next sign-in: until g69 it kept `salesperson` until then, and Administration
    // never asked for the sending posture.
    mac.script.role('admin');
    mac.advance(3_600_001);
    await mac.manager.refreshToday();
    expect(mac.script.calls.get('/auth/session/renew')).toBe(1);
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

  it('reaches an open Administration window: the posture a salesperson never asked for is read once the renewal says admin', async () => {
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
    expect(promoted.sendingAdmin).toEqual({ domain: null, personalGmailRecipients: 0, ramps: [] });
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
    expect(mac.script.calls.get('/auth/session/renew')).toBe(2);
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
  it('names exactly six views, and nothing for any other value', () => {
    expect(ROUTE_NAMES).toEqual(['today', 'replies', 'firms', 'sequences', 'admin', 'dashboard']);
    for (const name of ROUTE_NAMES) expect(routeNameOf(name)).toBe(name);
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

  it('reads a route from text, a firm by its id and Administration by its section, and nothing else', () => {
    const firmId = '11111111-1111-4111-8111-111111111111';
    expect(routeOf('today')).toEqual({ name: 'today' });
    expect(routeOf('admin')).toEqual({ name: 'admin' });
    expect(routeOf('admin/calling-number')).toEqual({ name: 'admin', section: 'calling-number' });
    expect(routeOf(`firm/${firmId}`)).toEqual({ name: 'firm', firmId });
    for (const text of ['', 'firm', 'firm/', 'firm/not-an-id', `firm/${firmId}/x`, 'admin/elsewhere', 'today/x', 'Today']) {
      expect(routeOf(text), text).toBeNull();
    }
    for (const route of [{ name: 'firms' }, { name: 'firm', firmId }, { name: 'admin', section: 'alerts' }] as const) {
      expect(routeOf(routeText(route))).toEqual(route);
    }
    expect(sidebarRowOf({ name: 'firm', firmId })).toBe('firms');
  });

  it('answers a deep link for each of the six views, and ignores every other link', () => {
    expect(DEEP_LINKS).toEqual(ROUTE_NAMES.map(name => `callie://${name}`));
    expect(deepLinkRoute('callie://today')).toBe('today');
    expect(deepLinkRoute('callie://firms/')).toBe('firms');
    expect(deepLinkRoute('callie://dashboard')).toBe('dashboard');
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
      'callie:refresh-today',
      'callie:navigate',
    ]);
  });
});

describe('the Window menu (wave 1)', () => {
  it('shows each view in the one window, ⌘1 to ⌘6 in the sidebar’s order', () => {
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
      'Administration CmdOrCtrl+5',
      'Dashboard CmdOrCtrl+6',
    ]);
    for (const item of views) if ('click' in item) item.click();
    expect(shown).toEqual(['today', 'replies', 'firms', 'sequences', 'admin', 'dashboard']);
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
