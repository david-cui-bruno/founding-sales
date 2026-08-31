import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { KeyProtector } from '../../src/main/security/keyProtector';
import { createRecoveryKeyMaterial } from '../../src/main/security/recoveryKey';
import {
  InvalidWorkspaceKeyEnvelopeError,
  WorkspaceKeyProtectionError,
  WorkspaceKeyStore,
  WorkspaceKeyUnavailableError,
} from '../../src/main/security/workspaceKeyStore';

class FakeKeyProtector implements KeyProtector {
  protectCalls: Buffer[] = [];
  unprotectCalls: Buffer[] = [];
  shouldReprotect = false;
  failProtection = false;
  private generation = 0;

  async protect(value: Buffer): Promise<Buffer> {
    this.protectCalls.push(Buffer.from(value));
    if (this.failProtection) {
      throw new Error('synthetic protection failure');
    }
    this.generation += 1;
    const transformed = Buffer.from(value);
    for (let index = 0; index < transformed.byteLength; index += 1) {
      transformed[index] ^= 0xa5;
    }
    return Buffer.concat([
      Buffer.from([this.generation]),
      transformed,
    ]);
  }

  async unprotect(value: Buffer): Promise<{ value: Buffer; shouldReprotect: boolean }> {
    this.unprotectCalls.push(Buffer.from(value));
    const transformed = Buffer.from(value.subarray(1));
    for (let index = 0; index < transformed.byteLength; index += 1) {
      transformed[index] ^= 0xa5;
    }
    return {
      value: transformed,
      shouldReprotect: this.shouldReprotect,
    };
  }
}

describe('WorkspaceKeyStore', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, {
      force: true,
      recursive: true,
    })));
  });

  async function createHarness(options: {
    now?: string;
    protector?: FakeKeyProtector;
  } = {}) {
    const directory = await mkdtemp(join(tmpdir(), 'callie-workspace-key-'));
    directories.push(directory);
    const envelopePath = join(directory, 'callie.key-envelope.json');
    const protector = options.protector ?? new FakeKeyProtector();
    const randomBuffers: Buffer[] = [];
    let randomCalls = 0;
    const store = new WorkspaceKeyStore({
      keyProtector: protector,
      now: () => options.now ?? '2026-08-30T12:00:00.000Z',
      randomBytes: (size) => {
        randomCalls += 1;
        const generated = Buffer.alloc(size, 0x2a);
        randomBuffers.push(generated);
        return generated;
      },
    });

    return {
      directory,
      envelopePath,
      protector,
      randomBuffers,
      randomCallCount: () => randomCalls,
      store,
    };
  }

  it('creates a 0600 exact-schema envelope only when no database or envelope exists', async () => {
    const harness = await createHarness();

    const key = await harness.store.loadOrCreate({
      envelopePath: harness.envelopePath,
      databaseExists: false,
    });

    expect(key).toEqual({ bytes: Buffer.alloc(32, 0x2a), version: 1 });
    expect(harness.randomCallCount()).toBe(1);
    expect(harness.protector.protectCalls).toEqual([Buffer.alloc(32, 0x2a)]);
    expect(key.bytes).not.toBe(harness.randomBuffers[0]);
    expect(harness.randomBuffers[0]).toEqual(Buffer.alloc(32));

    const serialized = await readFile(harness.envelopePath, 'utf8');
    const envelope = JSON.parse(serialized) as Record<string, unknown>;
    expect(envelope).toEqual({
      format: 'callie-workspace-key',
      version: 1,
      protectedKeyBase64: 'AY+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+P',
      createdAt: '2026-08-30T12:00:00.000Z',
    });
    expect(Object.keys(envelope)).toEqual([
      'format',
      'version',
      'protectedKeyBase64',
      'createdAt',
    ]);
    expect(serialized).not.toContain(Buffer.alloc(32, 0x2a).toString('base64'));
    expect(serialized).not.toContain(Buffer.alloc(32, 0x2a).toString('hex'));
    expect(serialized).not.toContain(Buffer.alloc(32, 0x2a).toString('utf8'));
    expect((await stat(harness.envelopePath)).mode & 0o777).toBe(0o600);
    expect(await readdir(harness.directory)).toEqual(['callie.key-envelope.json']);
  });

  it('reloads an existing envelope without generating another key', async () => {
    const harness = await createHarness();
    const first = await harness.store.loadOrCreate({
      envelopePath: harness.envelopePath,
      databaseExists: false,
    });

    const reloaded = await harness.store.loadOrCreate({
      envelopePath: harness.envelopePath,
      databaseExists: true,
    });

    expect(reloaded).toEqual(first);
    expect(reloaded.bytes).not.toBe(first.bytes);
    expect(harness.randomCallCount()).toBe(1);
    expect(harness.protector.unprotectCalls).toHaveLength(1);
  });

  it('copies an unprotected result before clearing a potentially aliased protector input', async () => {
    const harness = await createHarness();
    harness.protector.protect = async () => Buffer.alloc(32, 0x6d);
    harness.protector.unprotect = async (value) => ({
      value,
      shouldReprotect: false,
    });
    await harness.store.loadOrCreate({
      envelopePath: harness.envelopePath,
      databaseExists: false,
    });

    const reloaded = await harness.store.loadOrCreate({
      envelopePath: harness.envelopePath,
      databaseExists: true,
    });

    expect(reloaded).toEqual({ bytes: Buffer.alloc(32, 0x6d), version: 1 });
  });

  it('refuses to load an envelope after its private parent directory becomes public', async () => {
    const harness = await createHarness();
    await harness.store.loadOrCreate({
      envelopePath: harness.envelopePath,
      databaseExists: false,
    });
    await chmod(harness.directory, 0o755);

    const operation = harness.store.loadOrCreate({
      envelopePath: harness.envelopePath,
      databaseExists: true,
    });

    await expect(operation).rejects.toThrow('Workspace key storage operation failed.');
  });

  it('never generates a replacement key when an existing database has no envelope', async () => {
    const harness = await createHarness();

    const operation = harness.store.loadOrCreate({
      envelopePath: harness.envelopePath,
      databaseExists: true,
    });

    await expect(operation).rejects.toBeInstanceOf(WorkspaceKeyUnavailableError);
    await expect(operation).rejects.toThrow(
      'Workspace key is unavailable for an existing database',
    );
    expect(harness.randomCallCount()).toBe(0);
    expect(harness.protector.protectCalls).toEqual([]);
  });

  it('refuses to persist a protector result that is the raw workspace key', async () => {
    const harness = await createHarness();
    harness.protector.protect = async (value) => value;

    const operation = harness.store.loadOrCreate({
      envelopePath: harness.envelopePath,
      databaseExists: false,
    });

    await expect(operation).rejects.toBeInstanceOf(WorkspaceKeyProtectionError);
    expect(await readdir(harness.directory)).toEqual([]);
    expect(harness.randomBuffers[0]).toEqual(Buffer.alloc(32));
  });

  it('fails closed on a malformed existing envelope without generating a key', async () => {
    const harness = await createHarness();
    await writeFile(
      harness.envelopePath,
      JSON.stringify({
        format: 'callie-workspace-key',
        version: 1,
        protectedKeyBase64: 'ciphertext',
        createdAt: '2026-08-30T12:00:00.000Z',
        unexpected: true,
      }),
      { mode: 0o600 },
    );

    const operation = harness.store.loadOrCreate({
      envelopePath: harness.envelopePath,
      databaseExists: true,
    });

    await expect(operation).rejects.toBeInstanceOf(InvalidWorkspaceKeyEnvelopeError);
    await expect(operation).rejects.toThrow('Workspace key envelope is invalid.');
    expect(harness.randomCallCount()).toBe(0);
  });

  it('reprotects atomically while preserving the original creation time', async () => {
    const protector = new FakeKeyProtector();
    const harness = await createHarness({ protector });
    await harness.store.loadOrCreate({
      envelopePath: harness.envelopePath,
      databaseExists: false,
    });
    const original = await readFile(harness.envelopePath, 'utf8');
    protector.shouldReprotect = true;
    protector.failProtection = true;

    const failedReprotect = harness.store.loadOrCreate({
      envelopePath: harness.envelopePath,
      databaseExists: true,
    });
    await expect(failedReprotect).rejects.toBeInstanceOf(WorkspaceKeyProtectionError);
    await expect(failedReprotect).rejects.not.toThrow('synthetic protection failure');
    expect(await readFile(harness.envelopePath, 'utf8')).toBe(original);
    expect(await readdir(harness.directory)).toEqual(['callie.key-envelope.json']);

    protector.failProtection = false;
    const key = await harness.store.loadOrCreate({
      envelopePath: harness.envelopePath,
      databaseExists: true,
    });
    const replacement = await readFile(harness.envelopePath, 'utf8');
    const parsed = JSON.parse(replacement) as Record<string, unknown>;

    expect(key).toEqual({ bytes: Buffer.alloc(32, 0x2a), version: 1 });
    expect(replacement).not.toBe(original);
    expect(parsed.createdAt).toBe('2026-08-30T12:00:00.000Z');
    expect(protector.protectCalls).toHaveLength(3);
    expect((await stat(harness.envelopePath)).mode & 0o777).toBe(0o600);
    expect(await readdir(harness.directory)).toEqual(['callie.key-envelope.json']);
  });

  it('atomically restores recovery material into a loadable envelope', async () => {
    const harness = await createHarness({ now: '2026-08-30T18:00:00.000Z' });
    const recoveryKey = { bytes: Buffer.alloc(32, 0x6c), version: 1 as const };
    const recoveryMaterial = createRecoveryKeyMaterial(recoveryKey);

    const restored = await harness.store.restore({
      envelopePath: harness.envelopePath,
      recoveryMaterial,
    });
    const reloaded = await harness.store.loadOrCreate({
      envelopePath: harness.envelopePath,
      databaseExists: true,
    });

    expect(restored).toEqual(recoveryKey);
    expect(reloaded).toEqual(recoveryKey);
    expect(reloaded.bytes).not.toBe(restored.bytes);
    const serialized = await readFile(harness.envelopePath, 'utf8');
    expect(serialized).not.toContain(recoveryKey.bytes.toString('base64'));
    expect(JSON.parse(serialized)).toMatchObject({
      format: 'callie-workspace-key',
      version: 1,
      createdAt: '2026-08-30T18:00:00.000Z',
    });
    expect((await stat(harness.envelopePath)).mode & 0o777).toBe(0o600);
  });

  it('rejects unprotected envelope content that is not exactly 32 bytes', async () => {
    const harness = await createHarness();
    await harness.store.loadOrCreate({
      envelopePath: harness.envelopePath,
      databaseExists: false,
    });
    harness.protector.unprotect = async () => ({
      value: Buffer.alloc(31),
      shouldReprotect: false,
    });

    await expect(harness.store.loadOrCreate({
      envelopePath: harness.envelopePath,
      databaseExists: true,
    })).rejects.toThrow('Workspace key envelope is invalid.');
  });
});
