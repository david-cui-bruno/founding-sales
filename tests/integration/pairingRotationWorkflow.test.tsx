// @vitest-environment jsdom
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { RegisteredIpcHandler } from '../fixtures/registeredIpcHandler';
import { createCallieApi } from '../../src/preload/createCallieApi';
import { registerOutreachIpc } from '../../src/main/ipc/registerOutreachIpc';
import { createDelegationRuntime } from '../../src/main/delegation/delegationRuntime';
import { PairingStore } from '../../src/main/delegation/pairingStore';
import type { SafeStorage } from '../../src/main/outreach/providers/providerTypes';
import { WorkerSetupSection, rotationConfirmation } from '../../src/renderer/foundation/WorkerSetupSection';
import { WorkerAuth } from '../../cloud/lambdas/delegated-worker/src/workerAuth';
import { createWorkerHandler } from '../../cloud/lambdas/delegated-worker/src/handler';
import { ConditionalCommandHarness } from '../../cloud/lambdas/delegated-worker/test/sdkHarness';

// Only Electron's registration/invoke transport is replaced. The preload, the outreach registrar, the pairing store on a
// real private directory and the worker handler over the in-memory conditional harness are all the real code.
const transport = vi.hoisted(() => ({ handlers: new Map<string, RegisteredIpcHandler>() }));
vi.mock('electron', () => ({ ipcMain: {
  handle: (channel: string, handler: RegisteredIpcHandler) => { if (transport.handlers.has(channel)) throw Error('Duplicate handler'); transport.handlers.set(channel, handler); },
  removeHandler: (channel: string) => transport.handlers.delete(channel),
} }));
const key = randomBytes(32);
const safeStorage: SafeStorage = { isEncryptionAvailable: () => true,
  encryptString: value => { const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', key, iv); const body = Buffer.concat([c.update(value, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), body]); },
  decryptString: value => { const c = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); c.setAuthTag(value.subarray(12, 28)); return Buffer.concat([c.update(value.subarray(28)), c.final()]).toString('utf8'); } };
const dirs: string[] = [];
afterEach(async () => {
  cleanup(); vi.unstubAllGlobals(); expect(transport.handlers.size).toBe(0);
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

const endpoint = 'https://worker.example.test';
const workspace = 'paired-workspace';
const widened = ['commands:write', 'events:read', 'google:grant', 'pairing:revoke'] as const;
const NOW = '2026-09-18T12:00:00.000Z';

async function fixture() {
  const external = vi.fn(async (): Promise<never> => { throw Error('Unexpected provider/network operation'); });
  vi.stubGlobal('fetch', external);
  const dir = await mkdtemp(join(process.env.JCODE_SCRATCH_DIR ?? process.cwd(), '.fictional-rotation-')); dirs.push(dir);
  const directory = join(dir, 'pairing');
  const auth = new WorkerAuth({ dynamo: new ConditionalCommandHarness(), tableName: 'fictional', workspaceId: workspace, clock: { now: () => NOW } });
  const handler = createWorkerHandler({ auth, host: 'worker.example.test' });
  const workerRequests: string[] = [];
  const http: typeof fetch = async (url, init) => {
    const parsed = new URL(String(url)); workerRequests.push(parsed.pathname);
    if (parsed.origin !== endpoint) throw Error('Rotation attempted an unexpected endpoint');
    const result = await handler({ version: '2.0', rawPath: parsed.pathname, rawQueryString: '', body: String(init?.body),
      headers: { host: parsed.host, 'x-forwarded-proto': 'https' }, requestContext: { domainName: parsed.host, http: { method: 'POST', sourceIp: 'fixture' } } });
    return new Response(result.body, { status: result.statusCode });
  };
  const store = new PairingStore({ directory, safeStorage, fetch: http });
  // The runtime is startup-bound: it holds no pairing until a normal restart, exactly as the section tells David.
  const runtime = createDelegationRuntime({ databaseGate: { withDatabase: async () => { throw Error('No SQL expected'); } }, pairing: null, clock: { now: () => NOW } });
  const unavailable = external;
  const ipc: string[] = [];
  const unregister = registerOutreachIpc({ provider: { status: unavailable, configure: unavailable, connectGmail: unavailable, disconnectGmail: unavailable,
    openDraft: unavailable, saveDraft: unavailable, generateDraft: unavailable, sendDraft: unavailable, inspectLocalAuthority: unavailable },
  delegation: runtime, pairingStore: store, isTrustedRendererUrl: url => url === 'app://rotation' });
  const api = createCallieApi({ invoke: async (channel, ...args) => {
    ipc.push(channel); const registered = transport.handlers.get(channel); if (!registered) throw Error('Unregistered channel');
    return registered({ senderFrame: { url: 'app://rotation' } }, ...args);
  } });
  return { auth, store, api, ipc, workerRequests, external, directory,
    async finish() { try { cleanup(); unregister(); await runtime.dispose(); expect(external).not.toHaveBeenCalled(); } catch (error) { unregister(); throw error; } } };
}

it('pairs, then rotates the credential in place through the real preload, registrar, store and worker handler, and refuses the replay', async () => {
  const f = await fixture();
  try {
    const issued = await f.auth.issuePairing({ scopes: ['commands:write', 'events:read'], expiresInSeconds: 300 });
    render(<WorkerSetupSection api={f.api.delegation} />);
    const region = await screen.findByRole('region', { name: 'Worker connection' });
    await within(region).findByText('Unconfigured', { exact: true });
    await within(region).findByText('Stored pairing credential: none. Pair worker below stores one.', { exact: true });
    expect(within(region).queryByRole('button', { name: 'Rotate pairing credential' })).toBeNull();

    // Fresh pairing through the existing control: the stored facts appear beside the receipt.
    fireEvent.change(within(region).getByLabelText('Endpoint'), { target: { value: endpoint } });
    fireEvent.change(within(region).getByLabelText('Expected workspace ID'), { target: { value: workspace } });
    fireEvent.change(within(region).getByLabelText('Pairing code'), { target: { value: issued.code } });
    fireEvent.click(within(region).getByRole('button', { name: 'Pair worker' }));
    await within(region).findByText('Worker paired', { exact: true });
    const before = (await f.store.load())!;
    expect(before).toMatchObject({ pairingId: issued.pairingId, workspaceId: workspace, endpoint, generation: 0, scopes: ['commands:write', 'events:read'] });
    await within(region).findByText('Stored credential: generation 0, scopes commands:write, events:read.', { exact: true });
    await within(region).findByText(issued.pairingId, { exact: true });

    // The operator mints the rotation code against the existing pairing; the CLI is the trusted composition of this call.
    const rotation = await f.auth.issueRotation({ pairingId: issued.pairingId, scopes: [...widened], expiresInSeconds: 300 });
    expect(rotation.pairingId).toBe(issued.pairingId);
    expect((within(region).getByLabelText('Rotation endpoint (locked)') as HTMLInputElement).value).toBe(endpoint);
    expect((within(region).getByLabelText('Rotation workspace ID (locked)') as HTMLInputElement).value).toBe(workspace);
    const rotate = within(region).getByRole('button', { name: 'Rotate pairing credential' }) as HTMLButtonElement;
    expect(rotate.disabled).toBe(true);
    fireEvent.change(within(region).getByLabelText('Rotation code'), { target: { value: rotation.code } });
    fireEvent.click(within(region).getByLabelText(rotationConfirmation(issued.pairingId)));
    expect(rotate.disabled).toBe(false);
    fireEvent.click(rotate);
    await within(region).findByText(new RegExp(`Pairing credential rotated: pairing ${issued.pairingId} is now at generation 1 with scopes commands:write, events:read, google:grant, pairing:revoke\\.`));

    // Same pairing id, next generation, new credentials on disk; the worker refuses the old ones and honours the new scopes.
    const after = (await f.store.load())!;
    expect(after).toMatchObject({ pairingId: issued.pairingId, workspaceId: workspace, endpoint, generation: 1, scopes: [...widened] });
    expect(after.credential).not.toBe(before.credential); expect(after.emergencyCredential).not.toBe(before.emergencyCredential);
    await expect(f.auth.authenticate(`Bearer ${before.credential}`, ['commands:write'])).rejects.toThrow('worker_unauthorized');
    await expect(f.auth.authenticate(`Bearer ${before.emergencyCredential}`, ['emergency:stop'])).rejects.toThrow('worker_unauthorized');
    expect((await f.auth.authenticate(`Bearer ${after.credential}`, ['google:grant', 'pairing:revoke'])).generation).toBe(1);
    expect((await f.auth.authenticate(`Bearer ${after.emergencyCredential}`, ['emergency:stop'])).kind).toBe('emergency');
    await within(region).findByText('commands:write, events:read, google:grant, pairing:revoke', { exact: true });
    expect(f.workerRequests).toEqual(['/pairing/redeem', '/pairing/redeem']);
    expect(f.ipc.filter(channel => channel === 'outreach:delegation-pair')).toHaveLength(1);
    expect(f.ipc.filter(channel => channel === 'outreach:delegation-rotate-pairing')).toHaveLength(1);
    expect(f.ipc.filter(channel => channel === 'outreach:delegation-pairing').length).toBeGreaterThanOrEqual(3);
    for (const secret of [issued.code, rotation.code, before.credential, after.credential, before.emergencyCredential, after.emergencyCredential]) {
      expect(document.body.textContent).not.toContain(secret);
    }
    expect((await readdir(f.directory)).sort()).toEqual(['pairing.json']);

    // Replaying the consumed code is refused by the worker and stated as uncertain here; nothing on disk changes.
    fireEvent.change(within(region).getByLabelText('Rotation code'), { target: { value: rotation.code } });
    fireEvent.click(within(region).getByLabelText(rotationConfirmation(issued.pairingId)));
    fireEvent.click(within(region).getByRole('button', { name: 'Rotate pairing credential' }));
    const alert = await within(region).findByRole('alert');
    expect(alert.textContent).toContain('Rotation outcome could not be verified');
    expect(await f.store.load()).toEqual(after);
    expect(f.workerRequests).toEqual(['/pairing/redeem', '/pairing/redeem', '/pairing/redeem']);
    expect((within(region).getByLabelText('Rotation code') as HTMLInputElement).value).toBe('');
  } finally { await f.finish(); }
}, 20_000);
