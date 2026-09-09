import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { authorizeGoogle } from '../../src/main/outreach/providers/googleOAuth';
import { CredentialStore } from '../../src/main/outreach/providers/credentialStore';
import { createOutreachProviders } from '../../src/main/outreach/providers/outreachProviders';
import { googleScopes, requireCapabilities } from '../../cloud/lambdas/delegated-worker/src/googleGrantCapabilities';
import type { SafeStorage, StoredCredentials } from '../../src/main/outreach/providers/providerTypes';
const key = randomBytes(32);
const safeStorage: SafeStorage = { isEncryptionAvailable: () => true,
  encryptString: value => { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv); const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), body]); },
  decryptString: value => { const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); cipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString('utf8'); } };
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture() {
  const dir = await mkdtemp(join(process.env.JCODE_SCRATCH_DIR ?? process.cwd(), '.fictional-google-'));
  dirs.push(dir); const directory = join(dir, 'credentials');
  return { directory, store: new CredentialStore({ directory, safeStorage }) };
}
const legacy: StoredCredentials = { model: { apiKey: '', model: '' }, senderName: '', postalAddress: '', gmail: {
  clientId: 'fictional.apps.googleusercontent.com', clientSecret: 'fictional-secret', refreshToken: 'fictional-old-refresh', accessToken: 'fictional-old-access', expiresAt: 9999999999999, email: 'operator@example.test' } };
async function callback(url: string, cancelled = false): Promise<void> {
  const authorization = new URL(url); const redirect = new URL(authorization.searchParams.get('redirect_uri')!);
  expect(redirect.hostname).toBe('127.0.0.1');
  redirect.searchParams.set('state', authorization.searchParams.get('state')!);
  redirect.searchParams.set(cancelled ? 'error' : 'code', cancelled ? 'access_denied' : 'fictional-code');
  expect((await fetch(redirect)).status).toBe(200);
}
describe('local actual Google grant binding', () => {
  it('persists actual subject, scopes and capabilities after the real loopback flow', async () => {
    const { directory, store } = await fixture(); await store.save(legacy);
    const manager = createOutreachProviders({ directory, safeStorage, openExternal: callback, fetch: async url => String(url).endsWith('/token')
      ? Response.json({ access_token: 'fictional-new-access', refresh_token: 'fictional-new-refresh', token_type: 'Bearer', expires_in: 3600, scope: `openid email ${googleScopes.send}` })
      : Response.json({ sub: 'fictional-subject', email: 'operator@example.test', email_verified: true }) });
    try { await manager.connectGmail(); } finally { manager.dispose(); }
    const stored = await store.load();
    expect(stored?.gmail.grant).toMatchObject({ subject: 'fictional-subject', owner: 'local', capabilities: ['send'], grantedScopes: ['openid', 'email', googleScopes.send] });
    expect(() => requireCapabilities(stored?.gmail.grant, ['relevant_read'])).toThrow('grant_missing_capability');
    expect(await readFile(join(directory, 'credentials.json'), 'utf8')).not.toContain('fictional-new-refresh');
  });
  it('cancelled manager reauthorization leaves existing encrypted credentials byte-for-byte unchanged', async () => {
    const { directory, store } = await fixture(); await store.save(legacy);
    const before = await readFile(join(directory, 'credentials.json'));
    const manager = createOutreachProviders({ directory, safeStorage, openExternal: url => callback(url, true), fetch: async () => { throw new Error('provider forbidden'); } });
    try { await expect(manager.connectGmail()).rejects.toThrow('oauth_denied'); } finally { manager.dispose(); }
    expect(await readFile(join(directory, 'credentials.json'))).toEqual(before);
    expect(await store.load()).toEqual(legacy);
  });
  it('scoped local authorization requests exact powers and rejects a downgrade', async () => {
    let requested = '';
    await expect(authorizeGoogle({ ...legacy.gmail, capabilities: ['send', 'event_write'], calendars: { ownedCalendarId: 'owned@example.test', conflictCalendarIds: ['owned@example.test'], confirmed: true }, signal: new AbortController().signal,
      openExternal: async url => { requested = new URL(url).searchParams.get('scope')!; await callback(url); },
      fetch: async url => String(url).endsWith('/token') ? Response.json({ access_token: 'access', refresh_token: 'refresh', token_type: 'Bearer', expires_in: 3600, scope: `openid email ${googleScopes.send}` }) : Response.json({ sub: 'fictional-subject', email: 'operator@example.test', email_verified: true }) })).rejects.toThrow('oauth_denied');
    expect(requested).toContain(googleScopes.event_write);
  });
  it('rejects remote grant metadata and mismatched local subject before replacing credentials', async () => {
    const { store } = await fixture();
    const grant = { provider: 'google' as const, subject: 'original-subject', email: legacy.gmail.email, owner: 'local' as const,
      purpose: 'permitted_correspondence' as const, capabilities: ['send' as const], grantedScopes: [googleScopes.send] };
    await store.save({ ...legacy, gmail: { ...legacy.gmail, grant } });
    await expect(store.save({ ...legacy, gmail: { ...legacy.gmail, grant: { ...grant, owner: 'remote' } } })).rejects.toThrow('invalid_configuration');
    await expect(store.save({ ...legacy, gmail: { ...legacy.gmail, grant: { ...grant, subject: 'different-subject' } } })).rejects.toThrow('oauth_identity_invalid');
    expect((await store.load())?.gmail.grant?.subject).toBe('original-subject');
  });
});

describe('explicit local scope boundaries', () => {
  it('does not acquire unrequested read powers from a broader provider response', async () => {
    await expect(authorizeGoogle({ ...legacy.gmail, signal: new AbortController().signal, openExternal: callback,
      fetch: async url => String(url).endsWith('/token')
        ? Response.json({ access_token: 'access', refresh_token: 'refresh', token_type: 'Bearer', expires_in: 3600, scope: `openid email ${googleScopes.send} ${googleScopes.relevant_read}` })
        : Response.json({ sub: 'fictional-subject', email: 'operator@example.test', email_verified: true }) })).rejects.toThrow('oauth_denied');
  });
});

describe('local calendar configuration gate', () => {
  it('refuses calendar powers without an explicit confirmed calendar selection', async () => {
    await expect(authorizeGoogle({ ...legacy.gmail, capabilities: ['event_write'], signal: new AbortController().signal,
      openExternal: async () => { throw new Error('browser must remain closed'); }, fetch: async () => { throw new Error('provider must remain untouched'); } })).rejects.toThrow('invalid_configuration');
  });
});
