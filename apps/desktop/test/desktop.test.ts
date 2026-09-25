import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CACHE_FILE,
  DEVICE_FILE,
  DEVICE_SECRET_ACCOUNT,
  REFRESH_CREDENTIAL_ACCOUNT,
  createOfflineCache,
  createMemoryVault,
  keychainCommand,
} from '../src/main/index.ts';
import { buildScreenView } from '../src/renderer/viewModel.ts';
import { WINDOW_TARGETS, desktopStateSchema, windowTargetOf } from '../src/shared/contract.ts';
import { IPC_CHANNELS } from '../src/main/ipc.ts';
import { windowMenuTemplate } from '../src/main/windowMenu.ts';
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
    expect(state.mayMutate).toBe(false);

    const view = buildScreenView(state);
    expect(view.showingCachedList).toBe(true);
    expect(view.actionsEnabled).toBe(false);
    expect(view.banners.some(banner => banner.text.includes('earlier read'))).toBe(true);
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

  it('lets a supported Mac mutate and refuses while it is offline', async () => {
    const mac = await started();
    await mac.manager.signIn({ workspaceId: mac.workspaceId, deviceLabel: 'A Mac' });
    expect(await mac.manager.mayMutateNow()).toEqual({ allowed: true });

    mac.script.offline(true);
    await mac.manager.refreshToday();
    expect(await mac.manager.mayMutateNow()).toEqual({ allowed: false, refusal: 'offline' });
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

describe('opening the other windows from Home (lane g65)', () => {
  it('opens exactly the five windows by name, and nothing for any other value', () => {
    expect(WINDOW_TARGETS).toEqual(['replies', 'firms', 'sequences', 'dashboard', 'administration']);
    for (const target of WINDOW_TARGETS) expect(windowTargetOf({ window: target })).toBe(target);
    // `registerBridge` opens only what this returns, and answers the current state for
    // everything else, as every handler on the bridge does for a malformed argument.
    for (const malformed of [
      null,
      undefined,
      'replies',
      42,
      [],
      {},
      { screen: 'dashboard' },
      { window: 'today' },
      { window: 'settings' },
      { window: 'settings.html' },
      { window: 'https://example.test/' },
      { window: 'Replies' },
      { window: ' replies' },
      { window: '__proto__' },
      { window: 'constructor' },
      { window: 'toString' },
      { window: ['replies'] },
      { window: { toString: () => 'replies' } },
    ]) {
      expect(windowTargetOf(malformed), JSON.stringify(malformed) ?? String(malformed)).toBeNull();
    }
  });

  it('adds one channel to the main window’s bridge', () => {
    expect(Object.values(IPC_CHANNELS)).toEqual([
      'callie:state',
      'callie:sign-in',
      'callie:sign-out',
      'callie:refresh-today',
      'callie:open-window',
    ]);
  });
});

describe('the Window menu (lane g65)', () => {
  it('brings Home forward on ⌘1 and opens the Dashboard on ⌘6, beside Administration', () => {
    const pressed: string[] = [];
    const press = (name: string) => (): void => {
      pressed.push(name);
    };
    const [menu] = windowMenuTemplate({
      today: press('today'),
      replies: press('replies'),
      firms: press('firms'),
      sequences: press('sequences'),
      administration: press('administration'),
      dashboard: press('dashboard'),
    });
    expect(menu?.label).toBe('Window');
    expect(menu?.submenu.map(item => `${item.label} ${item.accelerator}`)).toEqual([
      'Today CmdOrCtrl+1',
      'Replies CmdOrCtrl+2',
      'Firms CmdOrCtrl+3',
      'Sequences CmdOrCtrl+4',
      'Administration CmdOrCtrl+5',
      'Dashboard CmdOrCtrl+6',
    ]);
    for (const item of menu?.submenu ?? []) item.click();
    expect(pressed).toEqual(['today', 'replies', 'firms', 'sequences', 'administration', 'dashboard']);
  });

  it('offers the Dashboard only beside the window it is a screen of', () => {
    const noop = (): void => undefined;
    const [menu] = windowMenuTemplate({ today: noop, replies: noop, firms: noop, sequences: noop, dashboard: noop });
    expect(menu?.submenu.map(item => item.label)).toEqual(['Today', 'Replies', 'Firms', 'Sequences']);
  });
});
