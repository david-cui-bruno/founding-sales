import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEVICE_TOKEN_FILE, TokenStore, TokenStoreError, type SafeStorageLike, type StoredDevice } from './tokenStore';

/** A stand-in for Electron's safeStorage: reversible, obviously not secret, and never the identity function. */
const fakeSafeStorage = (available = true): SafeStorageLike => ({
  isEncryptionAvailable: () => available,
  encryptString: (value) => Buffer.concat([Buffer.from('FAKE1'), Buffer.from(value, 'utf8').map((byte) => byte ^ 0x5a)]),
  decryptString: (buffer) => {
    if (buffer.subarray(0, 5).toString() !== 'FAKE1') throw new Error('not encrypted by the fake');
    return Buffer.from(buffer.subarray(5).map((byte) => byte ^ 0x5a)).toString('utf8');
  },
});

const device = (): StoredDevice => ({
  deviceToken: randomBytes(32).toString('base64url'),
  deviceId: randomUUID(),
  workspaceId: 'ws',
  endpoint: 'https://worker.example.test',
  pairedAt: '2026-09-18T12:00:00.000Z',
});

let root: string;
let directory: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'client-token-store-'));
  directory = join(root, 'client');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('TokenStore', () => {
  it('names the file device-token.bin under the client directory', () => {
    const store = new TokenStore({ directory, safeStorage: fakeSafeStorage() });
    expect(DEVICE_TOKEN_FILE).toBe('device-token.bin');
    expect(store.path).toBe(join(directory, 'device-token.bin'));
  });

  it('loads null when nothing was stored', async () => {
    const store = new TokenStore({ directory, safeStorage: fakeSafeStorage() });
    expect(await store.load()).toBeNull();
    expect(existsSync(directory)).toBe(false);
  });

  it('round-trips one device through the safeStorage-encrypted file with private modes', async () => {
    const store = new TokenStore({ directory, safeStorage: fakeSafeStorage() });
    const stored = device();
    await store.save(stored);
    expect(await store.load()).toEqual(stored);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(store.path).mode & 0o777).toBe(0o600);
    const bytes = readFileSync(store.path);
    expect(bytes.includes(Buffer.from(stored.deviceToken, 'utf8'))).toBe(false);
    expect(bytes.includes(Buffer.from(stored.deviceId, 'utf8'))).toBe(false);
  });

  it('replaces a stored device on the next save', async () => {
    const store = new TokenStore({ directory, safeStorage: fakeSafeStorage() });
    await store.save(device());
    const second = device();
    await store.save(second);
    expect(await store.load()).toEqual(second);
  });

  it('clear removes the file and a later clear is harmless', async () => {
    const store = new TokenStore({ directory, safeStorage: fakeSafeStorage() });
    await store.save(device());
    await store.clear();
    expect(existsSync(store.path)).toBe(false);
    await store.clear();
    expect(await store.load()).toBeNull();
  });

  it('reports a file it cannot decrypt or parse as corrupt, without deleting it', async () => {
    const store = new TokenStore({ directory, safeStorage: fakeSafeStorage() });
    await store.save(device());
    writeFileSync(store.path, Buffer.from('not what safeStorage wrote'));
    await expect(store.load()).rejects.toMatchObject({ reason: 'corrupt' });
    expect(existsSync(store.path)).toBe(true);
    const encryptedJunk = fakeSafeStorage().encryptString(JSON.stringify({ deviceToken: 'short' }));
    writeFileSync(store.path, encryptedJunk);
    await expect(store.load()).rejects.toBeInstanceOf(TokenStoreError);
  });

  it('refuses to save or load when encryption is unavailable', async () => {
    const store = new TokenStore({ directory, safeStorage: fakeSafeStorage(false) });
    await expect(store.save(device())).rejects.toMatchObject({ reason: 'unavailable' });
    await expect(store.load()).rejects.toMatchObject({ reason: 'unavailable' });
  });
});
