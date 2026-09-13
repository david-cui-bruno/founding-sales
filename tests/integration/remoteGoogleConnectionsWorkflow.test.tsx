// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createPmFixture, PM_NOW } from '../fixtures/pmAccounts';
import type { RegisteredIpcHandler } from '../fixtures/registeredIpcHandler';
import { createCallieApi } from '../../src/preload/createCallieApi';
import { registerOutreachIpc } from '../../src/main/ipc/registerOutreachIpc';
import { createDelegationRuntime } from '../../src/main/delegation/delegationRuntime';
import { SettingsScreen } from '../../src/renderer/foundation/SettingsScreen';
import { WorkerAuth } from '../../cloud/lambdas/delegated-worker/src/workerAuth';
import { RemoteGoogleAuthorization } from '../../cloud/lambdas/delegated-worker/src/remoteGoogleAuthorization';
import { createWorkerHandler } from '../../cloud/lambdas/delegated-worker/src/handler';
import { ConditionalCommandHarness } from '../../cloud/lambdas/delegated-worker/test/sdkHarness';
import { googleScopes } from '../../src/shared/contracts/googleGrantCapabilities';

const transport = vi.hoisted(() => ({ handlers: new Map<string, RegisteredIpcHandler>() }));
vi.mock('electron', () => ({ ipcMain: {
  handle: (channel: string, handler: RegisteredIpcHandler) => { if (transport.handlers.has(channel)) throw Error('Duplicate handler'); transport.handlers.set(channel, handler); },
  removeHandler: (channel: string) => transport.handlers.delete(channel),
} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); expect(transport.handlers.size).toBe(0); });

async function fixture() {
  const forbidden = vi.fn(async (): Promise<never> => { throw Error('Unexpected external action'); });
  vi.stubGlobal('fetch', forbidden);
  const f = await createPmFixture();
  let unregister = (): void => undefined;
  let dispose = async (): Promise<void> => undefined;
  try {
    const auth = new WorkerAuth({ dynamo: new ConditionalCommandHarness(), tableName: 'guided-grants', workspaceId: 'guided-workspace', clock: { now: () => PM_NOW } });
    const pairing = { ...await auth.redeemPairing((await auth.issuePairing({ scopes: ['google:grant'], expiresInSeconds: 300 })).code, 'fixture'), endpoint: 'https://guided.example.test' };
    const provider = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input) === 'https://oauth2.googleapis.com/token') {
        const account = new URLSearchParams(String(init?.body)).get('code');
        if (account !== 'work' && account !== 'personal') throw Error('Unexpected synthetic code');
        return new Response(JSON.stringify({ access_token: account, refresh_token: account, token_type: 'Bearer', expires_in: 3600,
          scope: ['openid', 'email', ...(account === 'work' ? [googleScopes.send, googleScopes.relevant_read] : [googleScopes.availability])].join(' ') }));
      }
      if (String(input) === 'https://openidconnect.googleapis.com/v1/userinfo') {
        const account = new Headers(init?.headers).get('authorization')?.replace('Bearer ', '');
        if (account !== 'work' && account !== 'personal') throw Error('Unexpected synthetic identity');
        return new Response(JSON.stringify({ sub: `${account}-subject`, email: account === 'work' ? 'founder@usecali.com' : 'founder@gmail.com', email_verified: true }));
      }
      if (String(input) === 'https://oauth2.googleapis.com/revoke') return new Response('');
      throw Error('Forbidden provider action');
    });
    const google = new RemoteGoogleAuthorization({ auth, config: { clientId: 'fixture.apps.googleusercontent.com', clientSecret: 'fictional-secret', redirectUri: `${pairing.endpoint}/oauth/callback`, encryptionKey: Buffer.alloc(32, 6) }, fetch: provider });
    const handler = createWorkerHandler({ auth, google, host: 'guided.example.test' });
    const invoke = async (path: string, method = 'GET', body?: unknown, credential = `Bearer ${pairing.credential}`) => {
      const url = new URL(path, pairing.endpoint);
      return handler({ version: '2.0', rawPath: url.pathname, rawQueryString: url.search.slice(1), headers: { host: url.host, 'x-forwarded-proto': 'https', authorization: credential },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), requestContext: { domainName: url.host, http: { method, sourceIp: 'fictional' } } });
    };
    const requests: string[] = [], opened: string[] = [], responses: unknown[] = [];
    const http: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.origin !== pairing.endpoint || init?.redirect !== 'error' || init.cache !== 'no-store') throw Error('Unexpected worker transport');
      requests.push(url.pathname);
      const reply = await invoke(url.pathname + url.search, init?.method, init?.body ? JSON.parse(String(init.body)) : undefined, new Headers(init?.headers).get('authorization') ?? '');
      return new Response(reply.body, { status: reply.statusCode });
    };
    const runtime = createDelegationRuntime({ databaseGate: { withDatabase: async fn => fn(f.db) }, pairing, clock: { now: () => PM_NOW }, fetch: http,
      openGoogleConsent: async url => { opened.push(url); },
    });
    dispose = () => runtime.dispose();
    unregister = registerOutreachIpc({ provider: { status: forbidden, configure: forbidden, connectGmail: forbidden, disconnectGmail: forbidden, openDraft: forbidden, saveDraft: forbidden, generateDraft: forbidden, sendDraft: forbidden, inspectLocalAuthority: forbidden }, delegation: runtime, isTrustedRendererUrl: url => url === 'app://guided' });
    const api = createCallieApi({ invoke: async (channel, ...args) => {
      const registered = transport.handlers.get(channel); if (!registered) throw Error('Unregistered IPC');
      const result = await registered({ senderFrame: { url: 'app://guided' } }, ...args); responses.push(result); return result;
    } });
    const mount = () => render(<SettingsScreen state={{ status: 'loading' }} onRetry={() => undefined} theme={{ preference: 'light', resolvedTheme: 'light', setPreference: () => undefined }} density={{ density: 'comfortable', setDensity: () => undefined }} delegationApi={api.delegation} />);
    return { ...f, api, auth, provider, requests, opened, responses, mount,
      async complete(account: 'work' | 'personal') {
        const url = new URL(opened[opened.length - 1]);
        expect(url.origin).toBe('https://accounts.google.com');
        const callback = await invoke(`/oauth/callback?state=${encodeURIComponent(url.searchParams.get('state')!)}&code=${account}`);
        expect(callback.statusCode).toBe(200);
      },
      async finish() { try { cleanup(); unregister(); await dispose(); expect(forbidden).not.toHaveBeenCalled(); } finally { f.close(); } },
    };
  } catch (error) { unregister(); await dispose(); f.close(); throw error; }
}

// Acceptance cases below intentionally exercise the actual Settings route, preload,
// trusted registrar and leased runtime. Google/Dynamo and browser opening remain
// controlled boundaries. No actual account authorization or resource access is claimed.
it('connects separate work and personal grants through actual Settings and only an explicit main-owned consent action', async () => {
  const f = await fixture();
  try {
    f.mount(); fireEvent.click(screen.getByRole('button', { name: 'Connections' }));
    const work = within(await screen.findByRole('region', { name: 'Work email' }));
    const personal = within(screen.getByRole('region', { name: 'Personal calendar availability' }));
    await work.findByText('No cloud grant configured', { exact: false });
    await personal.findByText('No cloud grant configured', { exact: false });
    expect(f.opened).toEqual([]); expect(f.provider).not.toHaveBeenCalled();
    expect(f.requests.every(path => ['/google/status', '/google/disclosure'].includes(path))).toBe(true);
    fireEvent.change(work.getByLabelText('Named work email (@usecali.com)'), { target: { value: 'founder@usecali.com' } });
    fireEvent.click(work.getByLabelText('I confirm this named work mailbox'));
    fireEvent.click(work.getByLabelText('I have reviewed and acknowledge this disclosure'));
    fireEvent.click(work.getByRole('button', { name: 'Continue to Google' }));
    await work.findByText(/Google consent opened/);
    expect(f.opened).toHaveLength(1); expect(f.provider).not.toHaveBeenCalled();
    expect(work.queryByText(/Cloud grant ready/)).toBeNull();
    await f.complete('work');
    fireEvent.click(work.getByRole('button', { name: 'Refresh' }));
    await work.findByText(/Cloud grant ready/);
    const workRows = await f.auth.store.list('GOOGLE_GRANT#'); expect(workRows).toHaveLength(1);
    fireEvent.change(personal.getByLabelText('Calendar IDs, one per line'), { target: { value: 'founder@gmail.com' } });
    fireEvent.click(personal.getByLabelText('I confirm these exact calendar IDs'));
    fireEvent.click(personal.getByLabelText('I have reviewed and acknowledge this disclosure'));
    fireEvent.click(personal.getByRole('button', { name: 'Continue to Google' }));
    await personal.findByText(/Google consent opened/); expect(f.opened).toHaveLength(2);
    await f.complete('personal');
    fireEvent.click(personal.getByRole('button', { name: 'Refresh' }));
    await personal.findByText(/Cloud grant ready/);
    expect(await f.auth.store.list('GOOGLE_GRANT#')).toContainEqual(workRows[0]);
    expect(JSON.stringify(f.responses)).not.toMatch(/authorizationUrl|access_token|refresh_token|ciphertext|code_challenge/);
    fireEvent.click(personal.getByLabelText(/I acknowledge this revocation request/));
    fireEvent.click(personal.getByRole('button', { name: 'Revoke cloud grant' }));
    await personal.findByText(/Revocation response received/);
    expect((await f.api.delegation.googleConnections!.status({ purpose: 'personal_availability' })).state).toBe('revoked');
    expect((await f.api.delegation.googleConnections!.status({ purpose: 'permitted_correspondence' })).state).toBe('ready');
    expect(await f.auth.store.list('GOOGLE_GRANT#')).toContainEqual(workRows[0]);
    const before = f.requests.filter(path => path === '/google/begin' || path === '/google/revoke').length;
    fireEvent.click(screen.getByRole('button', { name: 'About' }));
    fireEvent.click(screen.getByRole('button', { name: 'Connections' }));
    await waitFor(() => expect(screen.getAllByText(/Cloud grant ready/)).toHaveLength(1));
    expect(f.requests.filter(path => path === '/google/begin' || path === '/google/revoke')).toHaveLength(before);
    expect(f.opened).toHaveLength(2);
    expect(f.db.raw.prepare('SELECT * FROM delegated_commands').all()).toEqual([]);
    expect(f.db.raw.prepare('SELECT * FROM delegated_local_configuration').all()).toEqual([]);
    expect(f.db.raw.prepare('SELECT * FROM persons ORDER BY id').all()).toEqual(f.historicalPersons);
  } finally { await f.finish(); }
}, 15000);
