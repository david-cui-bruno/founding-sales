// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createPmFixture, PM_NOW } from '../fixtures/pmAccounts';
import type { RegisteredIpcHandler } from '../fixtures/registeredIpcHandler';
import { createCallieApi } from '../../src/preload/createCallieApi';
import { registerOutreachIpc } from '../../src/main/ipc/registerOutreachIpc';
import { createDelegationRuntime } from '../../src/main/delegation/delegationRuntime';
import { SettingsScreen } from '../../src/renderer/foundation/SettingsScreen';
import { WorkerAuth } from '../../cloud/lambdas/delegated-worker/src/workerAuth';
import { createWorkerHandler } from '../../cloud/lambdas/delegated-worker/src/handler';
import { ConditionalCommandHarness } from '../../cloud/lambdas/delegated-worker/test/sdkHarness';

const transport = vi.hoisted(() => ({ handlers: new Map<string, RegisteredIpcHandler>() }));
vi.mock('electron', () => ({ ipcMain: {
  handle: (channel: string, handler: RegisteredIpcHandler) => { if (transport.handlers.has(channel)) throw Error('Duplicate handler'); transport.handlers.set(channel, handler); },
  removeHandler: (channel: string) => transport.handlers.delete(channel),
} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); expect(transport.handlers.size).toBe(0); });

async function fixture() {
  const external = vi.fn(async (): Promise<never> => { throw Error('Unexpected provider/network operation'); });
  vi.stubGlobal('fetch', external);
  const f = await createPmFixture();
  let dispose = async (): Promise<void> => undefined;
  let unregister = (): void => undefined;
  try {
    // Pairing is an explicitly supplied prerequisite, not a newly deployed service.
    // No local configuration, owner, campaign or queue is prepopulated.
    const auth = new WorkerAuth({ dynamo: new ConditionalCommandHarness(), tableName: 'setup-fixture', workspaceId: 'setup-workspace', clock: { now: () => PM_NOW } });
    const issued = await auth.issuePairing({ scopes: ['commands:write', 'events:read'], expiresInSeconds: 300 });
    const pairing = { ...await auth.redeemPairing(issued.code, 'fixture-device'), endpoint: 'https://setup.example.invalid' };
    const handler = createWorkerHandler({ auth, host: 'setup.example.invalid' });
    const requests: string[] = [], ipc: string[] = [];
    let failRead = false, loseConfigurationResponse = false;
    const http: typeof fetch = async (input, init) => {
      const url = new URL(String(input)); requests.push(url.pathname);
      if (url.origin !== pairing.endpoint || url.pathname !== '/events' || (init?.method ?? 'GET') !== 'GET') throw Error('Setup attempted an unexpected command');
      if (failRead) throw Error('Synthetic worker outage');
      const reply = await handler({ version: '2.0', rawPath: url.pathname, rawQueryString: url.search.slice(1), headers: { host: url.host, 'x-forwarded-proto': 'https', authorization: new Headers(init?.headers).get('authorization') ?? '' }, requestContext: { domainName: url.host, http: { method: 'GET', sourceIp: 'fixture' } } });
      return new Response(reply.body, { status: reply.statusCode });
    };
    const runtime = createDelegationRuntime({ databaseGate: { withDatabase: async operation => operation(f.db) }, pairing, clock: { now: () => PM_NOW }, fetch: http,
      configurationChanged: async () => { if (loseConfigurationResponse) throw Error('Synthetic lost response after commit'); },
    });
    dispose = () => runtime.dispose();
    const unavailable = external;
    unregister = registerOutreachIpc({ provider: { status: unavailable, configure: unavailable, connectGmail: unavailable, disconnectGmail: unavailable, openDraft: unavailable, saveDraft: unavailable, generateDraft: unavailable, sendDraft: unavailable, inspectLocalAuthority: unavailable }, delegation: runtime, isTrustedRendererUrl: url => url === 'app://setup' });
    const api = createCallieApi({ invoke: async (channel, ...args) => {
      ipc.push(channel); const handler = transport.handlers.get(channel); if (!handler) throw Error('Unregistered channel');
      return handler({ senderFrame: { url: 'app://setup' } }, ...args);
    } });
    const mount = () => render(<SettingsScreen state={{ status: 'loading' }} onRetry={() => undefined} theme={{ preference: 'light', resolvedTheme: 'light', setPreference: () => undefined }} density={{ density: 'comfortable', setDensity: () => undefined }} delegationApi={api.delegation} />);
    return { ...f, api, runtime, requests, ipc, external, mount,
      configuration: () => f.db.raw.prepare('SELECT revision,configuration_json FROM delegated_local_configuration').all(),
      failRead(value: boolean) { failRead = value; },
      loseResponse(value: boolean) { loseConfigurationResponse = value; },
      async finish() { try { cleanup(); unregister(); await dispose(); expect(external).not.toHaveBeenCalled(); } finally { f.close(); } },
    };
  } catch (error) { unregister(); await dispose(); f.close(); throw error; }
}
async function openAccess() {
  fireEvent.click(screen.getByRole('button', { name: 'Worker connection' }));
  return within(await screen.findByRole('region', { name: 'Workspace access' }));
}

it('enables and pauses this Mac through real Settings, preload, registrar and encrypted configuration without remote commands', async () => {
  const f = await fixture();
  try {
    expect(f.configuration()).toEqual([]);
    const view = f.mount(); const access = await openAccess();
    await waitFor(() => expect((access.getByRole('checkbox') as HTMLInputElement).disabled).toBe(false));
    expect(f.configuration()).toEqual([]); expect(f.requests).toEqual([]);
    fireEvent.click(access.getByRole('checkbox'));
    fireEvent.click(access.getByRole('button', { name: 'Enable this Mac for cloud work' }));
    await waitFor(() => expect(f.configuration()).toEqual([{ revision: 1, configuration_json: JSON.stringify({ version: 1, state: 'active', research: null }) }]));
    await waitFor(() => expect((access.getByRole('button', { name: 'Sync saved cloud work' }) as HTMLButtonElement).disabled).toBe(false));
    expect(f.requests).toEqual([]);
    fireEvent.click(access.getByRole('button', { name: 'Sync saved cloud work' }));
    await waitFor(() => expect(f.db.raw.prepare('SELECT state FROM delegated_transport_state').get()).toEqual({ state: 'complete' }));
    expect(f.requests).toEqual(['/events']);
    await waitFor(() => expect((access.getByRole('checkbox') as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(access.getByRole('checkbox'));
    fireEvent.click(access.getByRole('button', { name: 'Pause cloud work on this Mac' }));
    await waitFor(() => expect(f.configuration()).toEqual([{ revision: 2, configuration_json: JSON.stringify({ version: 1, state: 'paused', research: null }) }]));
    view.unmount(); f.mount(); await openAccess();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Enable this Mac for cloud work' })).toBeTruthy());
    expect(f.configuration()).toHaveLength(1); expect(f.requests).toEqual(['/events']);
    expect(f.ipc.filter(channel => channel === 'outreach:delegation-configure')).toHaveLength(2);
    expect(f.db.raw.prepare('SELECT * FROM persons ORDER BY id').all()).toEqual(f.historicalPersons);
    expect(f.db.raw.prepare('SELECT COUNT(*) AS n FROM delegated_commands').get()).toEqual({ n: 0 });
  } finally { await f.finish(); }
});

it('recovers a committed configuration with a lost reply by reading status, then explicitly retries an incomplete sync', async () => {
  const f = await fixture();
  try {
    f.loseResponse(true); f.mount(); const access = await openAccess();
    await waitFor(() => expect((access.getByRole('checkbox') as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(access.getByRole('checkbox'));
    fireEvent.click(access.getByRole('button', { name: 'Enable this Mac for cloud work' }));
    await access.findByRole('alert');
    expect(f.configuration()).toHaveLength(1);
    expect(f.ipc.filter(channel => channel === 'outreach:delegation-configure')).toHaveLength(1);
    f.loseResponse(false);
    fireEvent.click(access.getByRole('button', { name: 'Refresh setup status' }));
    await access.findByRole('button', { name: 'Pause cloud work on this Mac' });
    expect(f.configuration()[0]).toMatchObject({ revision: 1 });
    f.failRead(true); fireEvent.click(access.getByRole('button', { name: 'Sync saved cloud work' }));
    await waitFor(() => expect(f.db.raw.prepare('SELECT state FROM delegated_transport_state').get()).toEqual({ state: 'failed' }));
    await act(async () => undefined);
    expect(f.requests).toHaveLength(1);
    f.failRead(false); fireEvent.click(access.getByRole('button', { name: 'Sync saved cloud work' }));
    await waitFor(() => expect(f.db.raw.prepare('SELECT state FROM delegated_transport_state').get()).toEqual({ state: 'complete' }));
    expect(f.requests).toHaveLength(2);
    expect(f.ipc.filter(channel => channel === 'outreach:delegation-configure')).toHaveLength(1);
  } finally { await f.finish(); }
});
