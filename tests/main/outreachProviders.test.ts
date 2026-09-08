import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, stat, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CredentialStore } from '../../src/main/outreach/providers/credentialStore';
import { createOutreachProviders } from '../../src/main/outreach/providers/outreachProviders';
import type { SafeStorage, StoredCredentials } from '../../src/main/outreach/providers/providerTypes';

// Only the OS encryption boundary is substituted. Real store, private fixture FS,
// authenticated encryption, schemas, manager and HTTP adapter remain exercised.
const key = randomBytes(32);
const safeStorage: SafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
  },
  decryptString: (bytes) => {
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
  },
};
const dirs: string[] = [];
const managers: ReturnType<typeof createOutreachProviders>[] = [];
async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), 'outreach-provider-fixture-'));
  dirs.push(parent);
  return join(parent, 'providers');
}
afterEach(async () => {
  managers.splice(0).forEach((manager) => manager.dispose());
  await Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
const stored: StoredCredentials = {
  model: { apiKey: 'fixture-api-secret', model: 'fixture-model' },
  gmail: { clientId: 'fixture.apps.googleusercontent.com', clientSecret: 'fixture-client-secret',
    refreshToken: 'fixture-refresh-secret', accessToken: 'fixture-access-secret', expiresAt: 200000, email: 'founder@example.com' },
  senderName: 'Fixture Founder', postalAddress: '123 Example Street',
};

describe('protected outreach credentials', () => {
  it('persists authenticated ciphertext privately and reopens without plaintext secrets', async () => {
    const directory = await fixture();
    await new CredentialStore({ directory, safeStorage }).save(stored);
    expect(await new CredentialStore({ directory, safeStorage }).load()).toEqual(stored);
    const raw = await readFile(join(directory, 'credentials.json'), 'utf8');
    expect(raw).not.toContain('fixture-api-secret');
    expect(raw).not.toContain('fixture-refresh-secret');
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(directory, 'credentials.json'))).mode & 0o777).toBe(0o600);
  });
  it('returns null only when absent, never on corruption or locked Keychain', async () => {
    const directory = await fixture();
    const store = new CredentialStore({ directory, safeStorage });
    expect(await store.load()).toBeNull();
    await store.save(stored);
    await writeFile(join(directory, 'credentials.json'), '{"bad":"secret"}');
    await expect(store.load()).rejects.toThrow('credentials_corrupt');
    const locked = new CredentialStore({ directory, safeStorage: { ...safeStorage, isEncryptionAvailable: () => false } });
    await expect(locked.load()).rejects.toThrow('credentials_locked');
    await expect(locked.save(stored)).rejects.toThrow('credentials_locked');
  });
  it('rejects symlink envelopes and directories rather than following them', async () => {
    const directory = await fixture();
    const store = new CredentialStore({ directory, safeStorage });
    await store.save(stored);
    const file = join(directory, 'credentials.json');
    await rm(file);
    const target = join(directory, 'target');
    await writeFile(target, 'fixture secret');
    await symlink(target, file);
    await expect(store.load()).rejects.toThrow('credentials_corrupt');
    await expect(store.save(stored)).rejects.toThrow('credentials_corrupt');
  });
});

describe('main-only provider manager', () => {
  it('is honestly unconfigured, performs no background request and saves setup across recreation', async () => {
    const directory = await fixture();
    const observed: string[] = [];
    const manager = createOutreachProviders({ directory, safeStorage,
      openExternal: async (url) => { observed.push(url); },
      fetch: async (url) => { observed.push(String(url)); throw new Error('unexpected'); } });
    managers.push(manager);
    expect(await manager.status()).toMatchObject({ model: 'unconfigured', gmail: 'unconfigured', accountEmail: null });
    await manager.configure({ apiKey: 'fixture-key', model: 'fixture-model', senderName: 'Founder', postalAddress: '123 Example St' });
    const recreated = createOutreachProviders({ directory, safeStorage, openExternal: async () => undefined });
    managers.push(recreated);
    expect(await recreated.status()).toMatchObject({ model: 'ready', modelName: 'fixture-model', senderName: 'Founder' });
    expect(JSON.stringify(await manager.status())).not.toContain('fixture-key');
    expect(observed).toEqual([]);
  });
  it('invalidates a prepared sender immediately when configuration changes', async () => {
    const directory = await fixture();
    await new CredentialStore({ directory, safeStorage }).save(stored);
    const requests: string[] = [];
    const manager = createOutreachProviders({ directory, safeStorage, now: () => 0, openExternal: async () => undefined,
      fetch: async (url) => { requests.push(String(url)); return Response.json({ id: 'message1' }); } });
    managers.push(manager);
    const prepared = await manager.prepare(new AbortController().signal);
    const configuring = manager.configure({ senderName: 'Changed' });
    expect(await prepared.sendOnce({ commandId: '00000000-0000-4000-8000-000000000001', from: 'founder@example.com',
      to: 'owner@example.com', subject: 'Hi', body: 'Message' })).toEqual({ status: 'not_sent', reasonCode: 'provider_invalidated' });
    await configuring;
    expect(requests).toEqual([]);
  });
  it('refreshes before preparation and persists refreshed credentials without send replay', async () => {
    const directory = await fixture();
    await new CredentialStore({ directory, safeStorage }).save({ ...stored, gmail: { ...stored.gmail, expiresAt: 0 } });
    const requests: string[] = [];
    const manager = createOutreachProviders({ directory, safeStorage, now: () => 1000, openExternal: async () => undefined,
      fetch: async (url) => { requests.push(String(url)); return Response.json({ access_token: 'fresh-access', expires_in: 3600, token_type: 'Bearer' }); } });
    managers.push(manager);
    const sender = await manager.prepare(new AbortController().signal);
    expect(sender.accountEmail).toBe('founder@example.com');
    expect(requests).toEqual(['https://oauth2.googleapis.com/token']);
    expect((await new CredentialStore({ directory, safeStorage }).load()).gmail.accessToken).toBe('fresh-access');
    manager.dispose();
    expect(await sender.sendOnce({ commandId: '00000000-0000-4000-8000-000000000001', from: 'founder@example.com',
      to: 'owner@example.com', subject: 'Hi', body: 'Message' })).toEqual({ status: 'not_sent', reasonCode: 'provider_invalidated' });
    expect(requests).toHaveLength(1);
  });
  it('does not misreport corrupted storage as unconfigured', async () => {
    const directory = await fixture();
    await new CredentialStore({ directory, safeStorage }).save(stored);
    await writeFile(join(directory, 'credentials.json'), 'corrupt');
    const manager = createOutreachProviders({ directory, safeStorage, openExternal: async () => undefined });
    managers.push(manager);
    expect(await manager.status()).toMatchObject({ model: 'error', gmail: 'error' });
    await expect(manager.configure({ apiKey: 'replacement' })).rejects.toThrow('credentials_corrupt');
  });
  it.each(['dispose', 'invalidate'] as const)('does not commit credentials after %s while encryption was in flight', async (action) => {
    const directory = await fixture();
    await new CredentialStore({ directory, safeStorage }).save(stored);
    let release: () => void;
    let started: () => void;
    const encryptionStarted = new Promise<void>((resolve) => { started = resolve; });
    const pause = new Promise<void>((resolve) => { release = resolve; });
    const manager = createOutreachProviders({ directory, openExternal: async () => undefined,
      safeStorage: { ...safeStorage, encryptString: async (value) => {
        started(); await pause; return safeStorage.encryptString(value);
      } } });
    managers.push(manager);
    const change = manager.configure({ apiKey: 'replacement-secret' });
    await encryptionStarted;
    manager[action](); release();
    await expect(change).rejects.toThrow('provider_invalidated');
    expect((await new CredentialStore({ directory, safeStorage }).load()).model.apiKey).toBe('fixture-api-secret');
  });
  it('connects only explicitly, persists verified mailbox and locally disconnects without provider requests', async () => {
    const directory = await fixture();
    const requests: string[] = [];
    let browsers = 0;
    const manager = createOutreachProviders({ directory, safeStorage, now: () => 1000,
      openExternal: async (url) => {
        browsers++;
        const auth = new URL(url); const callback = new URL(auth.searchParams.get('redirect_uri'));
        callback.searchParams.set('state', auth.searchParams.get('state')); callback.searchParams.set('code', 'fixture-code');
        await fetch(callback);
      }, fetch: async (url) => {
        requests.push(String(url));
        if (String(url).endsWith('/token')) return Response.json({ access_token: 'a', refresh_token: 'r', expires_in: 3600,
          token_type: 'Bearer', scope: 'openid email https://www.googleapis.com/auth/gmail.send' });
        return Response.json({ sub: 'fixture-account', email: 'founder@example.com', email_verified: true });
      } });
    managers.push(manager);
    await manager.configure({ googleClientId: 'fixture.apps.googleusercontent.com', googleClientSecret: 'fixture-secret' });
    expect(browsers).toBe(0); expect(requests).toEqual([]);
    expect(await manager.connectGmail()).toMatchObject({ gmail: 'ready', accountEmail: 'founder@example.com' });
    expect(browsers).toBe(1);
    expect((await new CredentialStore({ directory, safeStorage }).load()).gmail.refreshToken).toBe('r');
    const prepared = await manager.prepare(new AbortController().signal);
    expect(await manager.disconnectGmail()).toMatchObject({ gmail: 'unconfigured', accountEmail: null });
    expect((await new CredentialStore({ directory, safeStorage }).load()).gmail.refreshToken).toBe('');
    expect(await prepared.sendOnce({ commandId: '00000000-0000-4000-8000-000000000001', from: 'founder@example.com',
      to: 'owner@example.com', subject: 'Hi', body: 'Message' })).toMatchObject({ status: 'not_sent' });
    expect(requests).toHaveLength(2);
  });
  it('cancels a pending OAuth flow before changing account setup', async () => {
    const directory = await fixture();
    let opened: () => void;
    const browserOpened = new Promise<void>((resolve) => { opened = resolve; });
    let callback: string;
    const manager = createOutreachProviders({ directory, safeStorage,
      openExternal: async (url) => { callback = new URL(url).searchParams.get('redirect_uri'); opened(); },
      fetch: async () => { throw new Error('Unexpected provider call'); } });
    managers.push(manager);
    await manager.configure({ googleClientId: 'fixture.apps.googleusercontent.com' });
    const connecting = manager.connectGmail();
    const rejected = expect(connecting).rejects.toThrow('oauth_cancelled');
    await browserOpened;
    const updated = await manager.configure({ googleClientId: 'different.apps.googleusercontent.com' });
    await rejected;
    expect(updated.gmail).toBe('unconfigured');
    await expect(fetch(callback)).rejects.toThrow();
    expect((await new CredentialStore({ directory, safeStorage }).load()).gmail.clientId).toBe('different.apps.googleusercontent.com');
  });
  it('shows reauthorization after revoked refresh token and does not repeat refresh automatically', async () => {
    const directory = await fixture();
    await new CredentialStore({ directory, safeStorage }).save({ ...stored, gmail: { ...stored.gmail, expiresAt: 0 } });
    let requests = 0;
    const manager = createOutreachProviders({ directory, safeStorage, openExternal: async () => undefined,
      fetch: async () => { requests++; return new Response('sensitive-provider-text', { status: 400 }); } });
    managers.push(manager);
    await expect(manager.prepare(new AbortController().signal)).rejects.toThrow('gmail_reauthorize');
    expect(await manager.status()).toMatchObject({ gmail: 'reauthorize' });
    await expect(manager.prepare(new AbortController().signal)).rejects.toThrow('gmail_reauthorize');
    expect(requests).toBe(1);
  });
  it('accepts shared sender-name length 240 and rejects 241 without altering setup', async () => {
    const directory = await fixture();
    const manager = createOutreachProviders({ directory, safeStorage, openExternal: async () => undefined });
    managers.push(manager);
    expect(await manager.configure({ senderName: 'N'.repeat(240) })).toMatchObject({ senderName: 'N'.repeat(240) });
    await expect(manager.configure({ senderName: 'N'.repeat(241) })).rejects.toThrow('invalid_configuration');
    expect((await manager.status()).senderName).toBe('N'.repeat(240));
  });
  it('invalidates pending OAuth without persisting tokens or permanently closing the manager', async () => {
    const directory = await fixture();
    let opened: () => void;
    const browserOpened = new Promise<void>((resolve) => { opened = resolve; });
    let callback: URL;
    let requests = 0;
    let browsers = 0;
    const manager = createOutreachProviders({ directory, safeStorage,
      openExternal: async (url) => {
        browsers++;
        const auth = new URL(url); callback = new URL(auth.searchParams.get('redirect_uri'));
        callback.searchParams.set('code', 'fixture-code'); callback.searchParams.set('state', auth.searchParams.get('state'));
        opened();
      }, fetch: async (url) => {
        requests++;
        return String(url).endsWith('/token')
          ? Response.json({ access_token: 'a', refresh_token: 'r', expires_in: 3600, token_type: 'Bearer',
            scope: 'openid email https://www.googleapis.com/auth/gmail.send' })
          : Response.json({ sub: 'id', email: 'founder@example.com', email_verified: true });
      } });
    managers.push(manager);
    await manager.configure({ googleClientId: 'fixture.apps.googleusercontent.com' });
    const connecting = manager.connectGmail().then(() => 'connected', (error: Error) => error.message);
    await browserOpened;
    manager.invalidate?.();
    await fetch(callback).catch((): undefined => undefined);
    expect(await connecting).toBe('oauth_cancelled');
    expect((await new CredentialStore({ directory, safeStorage }).load()).gmail.refreshToken).toBe('');
    expect(await manager.status()).toMatchObject({ gmail: 'unconfigured' });
    expect(await manager.configure({ senderName: 'Still active' })).toMatchObject({ senderName: 'Still active' });
    expect(browsers).toBe(1); expect(requests).toBe(0);
  });
  it('fences a late token refresh after nonterminal invalidation', async () => {
    const directory = await fixture();
    await new CredentialStore({ directory, safeStorage }).save({ ...stored, gmail: { ...stored.gmail, expiresAt: 0 } });
    let started: () => void;
    let release: (response: Response) => void;
    const requested = new Promise<void>((resolve) => { started = resolve; });
    const manager = createOutreachProviders({ directory, safeStorage, openExternal: async () => undefined,
      fetch: () => { started(); return new Promise<Response>((resolve) => { release = resolve; }); } });
    managers.push(manager);
    const preparation = manager.prepare(new AbortController().signal).then(() => 'prepared', (error: Error) => error.message);
    await requested;
    manager.invalidate?.();
    release(Response.json({ access_token: 'late-access', expires_in: 3600, token_type: 'Bearer' }));
    expect(await preparation).toMatch(/^(provider_invalidated|network_uncertain)$/);
    expect((await new CredentialStore({ directory, safeStorage }).load()).gmail.accessToken).toBe('fixture-access-secret');
  });
});
