import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DelegationRuntime } from '../../src/main/delegation/delegationRuntime';
import type { OutreachApi } from '../../src/shared/contracts/outreachContract';
import type { RemoteGoogleConnectionsApi } from '../../src/shared/contracts/remoteGoogleConnectionsContract';
import { googleGrantDisclosure, personalGoogleGrantDisclosure, googleScopes } from '../../src/shared/contracts/googleGrantCapabilities';
import { createIpcClient } from '../../src/preload/ipcClient';
import { createRemoteGoogleConnectionsApi } from '../../src/preload/apis/remoteGoogleConnectionsApi';
import { registeredIpcHandler } from '../fixtures/registeredIpcHandler';
const electron = vi.hoisted(() => ({ handle: vi.fn(), removeHandler: vi.fn() }));
vi.mock('electron', () => ({ ipcMain: electron }));
import { registerOutreachIpc } from '../../src/main/ipc/registerOutreachIpc';

const selector = { purpose: 'personal_availability' as const };
const begin = { ...selector, capabilities: ['availability' as const], disclosureVersion: personalGoogleGrantDisclosure.version,
  availabilityCalendars: { calendarIds: ['owner@example.com'], confirmed: true as const } };
const legacyBegin = { capabilities: ['send' as const], disclosureVersion: googleGrantDisclosure.version };
const personalGrant = { provider: 'google' as const, subject: 'google-subject', email: 'owner@example.com', owner: 'remote' as const,
  ...selector, capabilities: ['availability' as const], grantedScopes: ['openid', 'email', googleScopes.availability], availabilityCalendars: begin.availabilityCalendars };
const trusted = { senderFrame: { url: 'callie://app/index.html' } };
const names = ['status', 'disclosure', 'begin', 'revoke'] as const;
const channel = (name: string) => `outreach:google-connection-${name}`;
const outreach = () => ({ status: async () => ({ model: 'unconfigured', modelName: '', gmail: 'unconfigured', accountEmail: null, senderName: '', postalAddress: '' }) }) as OutreachApi;
function bridge() {
  const google: RemoteGoogleConnectionsApi = {
    status: vi.fn<RemoteGoogleConnectionsApi['status']>(async () => ({ state: 'ready', grant: personalGrant })),
    disclosure: vi.fn<RemoteGoogleConnectionsApi['disclosure']>(async () => personalGoogleGrantDisclosure),
    begin: vi.fn<RemoteGoogleConnectionsApi['begin']>(async () => ({ state: 'consent_opened', ...selector })),
    revoke: vi.fn<RemoteGoogleConnectionsApi['revoke']>(async () => ({ state: 'revoked', grant: personalGrant, providerRevocation: 'pending' })),
  };
  const dispose = registerOutreachIpc({ provider: outreach(), delegation: { googleConnections: google } as DelegationRuntime });
  const invoke = (name: string) => registeredIpcHandler(electron.handle, channel(name));
  const transport = vi.fn(async (name: string, ...args: unknown[]) => registeredIpcHandler(electron.handle, name)(trusted, ...args));
  return { google, dispose, invoke, transport, api: createRemoteGoogleConnectionsApi(createIpcClient({ invoke: transport })) };
}
beforeEach(() => { electron.handle.mockReset(); electron.removeHandler.mockReset(); });

describe('pure Google connections IPC and preload', () => {
  it('registers exactly four optional Google channels and removes all once in reverse order', async () => {
    const f = bridge();
    expect(electron.handle.mock.calls.map(([name]) => name).filter(name => name.includes('google-connection-'))).toEqual(names.map(channel));
    expect(await f.api.status(selector)).toMatchObject({ state: 'ready', grant: personalGrant });
    expect(await f.api.disclosure(selector)).toEqual(personalGoogleGrantDisclosure);
    expect(await f.api.begin(begin)).toEqual({ state: 'consent_opened', ...selector });
    expect(await f.api.revoke(selector)).toMatchObject({ state: 'revoked', providerRevocation: 'pending' });
    for (const name of names) expect(f.google[name]).toHaveBeenCalledWith(name === 'begin' ? begin : selector);
    const registered = electron.handle.mock.calls.map(([name]) => name);
    f.dispose(); f.dispose();
    expect(electron.removeHandler.mock.calls.map(([name]) => name)).toEqual(registered.reverse());
  });
  it('does not add channels to legacy delegation fixtures', () => {
    const dispose = registerOutreachIpc({ provider: outreach(), delegation: {} as DelegationRuntime });
    expect(electron.handle.mock.calls.some(([name]) => name.includes('google-connection-'))).toBe(false);
    dispose();
  });
  it.each(names)('rejects untrusted %s before provider and redacts all errors', async name => {
    const f = bridge();
    try {
      await expect(f.invoke(name)({ senderFrame: { url: 'https://untrusted.test' } }, name === 'begin' ? begin : selector)).rejects.toThrow(/^OUTREACH_REQUEST_FAILED$/);
      expect(f.google[name]).not.toHaveBeenCalled();
      vi.mocked(f.google[name]).mockRejectedValue(Error('SECRET token https://private.test/oauth?code=secret'));
      await expect(f.api[name]((name === 'begin' ? begin : selector) as never)).rejects.toThrow(/^OUTREACH_REQUEST_FAILED$/);
    } finally { f.dispose(); }
  });
  const malformed = names.flatMap(name => [
    { name, label: 'no argument', args: [] },
    { name, label: 'extra argument', args: [name === 'begin' ? begin : selector, {}] },
    { name, label: 'missing purpose or begin fields', args: [{}] },
    { name, label: 'unknown purpose', args: [{ ...(name === 'begin' ? begin : selector), purpose: 'other' }] },
    { name, label: 'injected URL', args: [{ ...(name === 'begin' ? begin : selector), url: 'https://evil.test' }] },
    { name, label: 'injected token', args: [{ ...(name === 'begin' ? begin : selector), token: 'secret' }] },
  ]);
  it.each(malformed)('rejects $name $label at both boundaries before effects', async ({ name, args }) => {
    const f = bridge();
    try {
      await expect(f.invoke(name)(trusted, ...args)).rejects.toThrow(/^OUTREACH_REQUEST_FAILED$/);
      await expect(Reflect.apply(f.api[name], f.api, args)).rejects.toThrow();
      expect(f.google[name]).not.toHaveBeenCalled(); expect(f.transport).not.toHaveBeenCalled();
    } finally { f.dispose(); }
  });
  it('accepts the existing omitted-purpose correspondence begin only, and binds its result', async () => {
    const invoke = vi.fn(async () => ({ state: 'consent_opened', purpose: 'permitted_correspondence' }));
    const api = createRemoteGoogleConnectionsApi(createIpcClient({ invoke }));
    expect(await api.begin(legacyBegin)).toEqual({ state: 'consent_opened', purpose: 'permitted_correspondence' });
    expect(invoke).toHaveBeenCalledWith(channel('begin'), legacyBegin);
  });
  const invalidResults: { name: keyof RemoteGoogleConnectionsApi; value: unknown }[] = [
    { name: 'status' as const, value: { state: 'ready', grant: { provider: 'google', subject: 'other', email: 'other@example.com', owner: 'remote', purpose: 'permitted_correspondence', capabilities: ['send'], grantedScopes: [googleScopes.send] } } },
    { name: 'status' as const, value: { state: 'unconfigured', grant: null, token: 'SECRET' } },
    { name: 'disclosure' as const, value: googleGrantDisclosure },
    { name: 'begin' as const, value: { state: 'consent_opened', purpose: 'permitted_correspondence' } },
    { name: 'begin' as const, value: { state: 'consent_opened', ...selector, authorizationUrl: 'https://accounts.google.com' } },
    { name: 'revoke' as const, value: { state: 'ready', grant: personalGrant } },
    { name: 'revoke' as const, value: { state: 'unconfigured', grant: null } },
  ];
  it.each(invalidResults)('preload rejects unbound or unsafe $name response', async ({ name, value }) => {
    const api = createRemoteGoogleConnectionsApi(createIpcClient({ invoke: async () => value }));
    await expect(api[name]((name === 'begin' ? begin : selector) as never)).rejects.toThrow();
  });
  it.each(names)('captures immutable purpose for %s while transport is pending', async name => {
    let resolve!: (value: unknown) => void;
    const pending = new Promise<unknown>(done => { resolve = done; });
    const invoke = vi.fn(async () => pending);
    const api = createRemoteGoogleConnectionsApi(createIpcClient({ invoke }));
    const input = name === 'begin' ? { ...begin } : { ...selector };
    const result = api[name](input as never);
    (input as { purpose: string }).purpose = 'permitted_correspondence';
    resolve(name === 'begin' ? { state: 'consent_opened', ...selector } : name === 'disclosure' ? personalGoogleGrantDisclosure : { state: name === 'revoke' ? 'revoked' : 'ready', grant: personalGrant });
    await expect(result).resolves.toBeDefined();
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it.each(names)('rejects %s response matching mutated rather than original purpose', async name => {
    let resolve!: (value: unknown) => void;
    const pending = new Promise<unknown>(done => { resolve = done; });
    const api = createRemoteGoogleConnectionsApi(createIpcClient({ invoke: async () => pending }));
    const input = name === 'begin' ? { ...begin } : { ...selector };
    const result = api[name](input as never);
    (input as { purpose: string }).purpose = 'permitted_correspondence';
    const grant = { provider: 'google', subject: 'legacy', email: 'owner@example.com', owner: 'remote', purpose: 'permitted_correspondence', capabilities: ['send'], grantedScopes: [googleScopes.send] };
    resolve(name === 'begin' ? { state: 'consent_opened', purpose: 'permitted_correspondence' } : name === 'disclosure' ? googleGrantDisclosure : { state: name === 'revoke' ? 'revoked' : 'ready', grant });
    await expect(result).rejects.toThrow(/purpose mismatch/);
  });
  it.each(names)('IPC itself rejects secret-bearing %s responses', async name => {
    const f = bridge();
    try {
      const response = await f.google[name]((name === 'begin' ? begin : selector) as never);
      vi.mocked(f.google[name]).mockResolvedValue({ ...response, token: 'SECRET' } as never);
      await expect(f.invoke(name)(trusted, name === 'begin' ? begin : selector)).rejects.toThrow(/^OUTREACH_REQUEST_FAILED$/);
    } finally { f.dispose(); }
  });
  it.each([9, 10, 11, 12, 13])('rolls back exact registration prefix when index %s throws', position => {
    let index = 0; electron.handle.mockImplementation(() => { if (index++ === position) throw Error('registration failed'); });
    expect(() => bridge()).toThrow('registration failed');
    const attempted = electron.handle.mock.calls.map(([name]) => name);
    expect(electron.removeHandler.mock.calls.map(([name]) => name)).toEqual(attempted.slice(0, -1).reverse());
  });
  it('source-gates live leases, bounded combined abort, proof invalidation and main-only opening', () => {
    const runtime = readFileSync(new URL('../../src/main/delegation/delegationRuntime.ts', import.meta.url), 'utf8');
    const google = runtime.slice(runtime.indexOf(' function googleRun'), runtime.indexOf(' const contextInput'));
    expect(google).toContain('return run(async(database,signal)=>');
    expect(google).toContain('AbortSignal.any([signal,AbortSignal.timeout(15000)])');
    expect(google).toContain('if(!input.openGoogleConsent)throw');
    expect(google.indexOf('if(!input.openGoogleConsent)throw')).toBeLessThan(google.indexOf('client.beginGoogleGrant'));
    expect(google).toMatch(/begin:async raw=>[\s\S]*?invalidate\(\);[\s\S]*?client\.beginGoogleGrant/);
    expect(google).toMatch(/revoke:async raw=>[^\n]*invalidate\(\);[^\n]*googleRun/);
    expect(google).toContain('assertCurrent(signal);await openConsent(result.authorizationUrl,signal);assertCurrent(signal);');
    expect(google).not.toMatch(/\.sync\(|\.configure\(|\.submit\(/);
    expect(google).toContain("googleConsentOpenedSchema.parse({state:'consent_opened',purpose:selectedGooglePurpose(request.purpose)})");
  });
});

// Parent executes these real SQL/runtime acceptance cases. This worker only runs
// the pure describe above, never native fixtures, rebuilds or network requests.
describe('native Google connections runtime acceptance (parent-run)', () => {
  async function fixture(options: { opener?: (url: string) => Promise<void>; paired?: boolean; fetch?: typeof globalThis.fetch } = {}) {
    const { createPmFixture, PM_NOW } = await import('../fixtures/pmAccounts');
    const { createDelegationRuntime } = await import('../../src/main/delegation/delegationRuntime');
    const f = await createPmFixture();
    const fetcher = vi.fn(options.fetch ?? (async () => new Response(JSON.stringify({ state: 'unconfigured', grant: null }))));
    const runtime = createDelegationRuntime({ databaseGate: { withDatabase: async fn => fn(f.db) },
      pairing: options.paired === false ? null : { endpoint: 'https://worker.example.test', workspaceId: 'ws', pairingId: '11111111-1111-4111-8111-111111111111', credential: 'a'.repeat(43), emergencyCredential: 'b'.repeat(43), generation: 0, scopes: ['commands:write', 'events:read'] },
      clock: { now: () => PM_NOW }, fetch: fetcher, openGoogleConsent: options.opener });
    return { ...f, runtime, fetcher, async cleanup() { await runtime.dispose(); f.close(); } };
  }
  function authorizationUrl() {
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({ client_id: 'fixture.apps.googleusercontent.com', redirect_uri: 'https://worker.example.test/oauth/callback', response_type: 'code', scope: ['openid', 'email', googleScopes.availability].join(' '), state: 's'.repeat(43), code_challenge: 'c'.repeat(43), code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent select_account', include_granted_scopes: 'false' }).toString();
    return url.toString();
  }
  it('fails missing opener before HTTP, and missing pairing/lock/dispose before all requests', async () => {
    const f = await fixture();
    try {
      await expect(f.runtime.googleConnections.begin(begin)).rejects.toThrow('google_consent_opener_unavailable');
      expect(f.fetcher).not.toHaveBeenCalled();
      f.runtime.invalidate(true);
      for (const name of ['status', 'disclosure', 'revoke'] as const) await expect(f.runtime.googleConnections[name](selector)).rejects.toThrow('delegation_inactive');
      await f.runtime.dispose();
      await expect(f.runtime.googleConnections.status(selector)).rejects.toThrow('delegation_inactive');
      expect(f.fetcher).not.toHaveBeenCalled();
    } finally { await f.cleanup(); }
    const unpaired = await fixture({ paired: false, opener: async () => undefined });
    try {
      for (const name of names) await expect(unpaired.runtime.googleConnections[name]((name === 'begin' ? begin : selector) as never)).rejects.toThrow('pairing_unconfigured');
      expect(unpaired.fetcher).not.toHaveBeenCalled();
    } finally { await unpaired.cleanup(); }
  });
  it('uses only validated consent URLs and returns no credentials or URL', async () => {
    const opener = vi.fn(async () => undefined);
    const url = authorizationUrl();
    const f = await fixture({ opener, fetch: async () => new Response(JSON.stringify({ authorizationUrl: url })) });
    const unregister = registerOutreachIpc({ provider: outreach(), delegation: f.runtime });
    const api = createRemoteGoogleConnectionsApi(createIpcClient({ invoke: async (channel, ...args) => registeredIpcHandler(electron.handle, channel)(trusted, ...args) }));
    try {
      expect(await api.begin(begin)).toEqual({ state: 'consent_opened', ...selector });
      expect(opener).toHaveBeenCalledWith(url); expect(f.fetcher).toHaveBeenCalledTimes(1);
      f.fetcher.mockImplementation(async () => new Response(JSON.stringify({ authorizationUrl: 'https://evil.test' })));
      await expect(f.runtime.googleConnections.begin(begin)).rejects.toThrow('Worker authorization URL invalid');
      expect(opener).toHaveBeenCalledTimes(1);
    } finally { unregister(); await f.cleanup(); }
  });
  it('checks current state before opening after response and after a pending opener', async () => {
    const opener = vi.fn(async () => undefined);
    const f = await fixture({ opener });
    try {
      f.fetcher.mockImplementation(async () => { f.runtime.invalidate(true); return new Response(JSON.stringify({ authorizationUrl: authorizationUrl() })); });
      await expect(f.runtime.googleConnections.begin(begin)).rejects.toThrow();
      expect(opener).not.toHaveBeenCalled();
      f.runtime.invalidate(false);
      let entered!: () => void;
      const opened = new Promise<void>(resolve => { entered = resolve; });
      opener.mockImplementation(() => { entered(); return new Promise<void>(() => undefined); });
      f.fetcher.mockImplementation(async () => new Response(JSON.stringify({ authorizationUrl: authorizationUrl() })));
      const result = f.runtime.googleConnections.begin(begin);
      const rejected = expect(result).rejects.toThrow('delegation_inactive');
      await opened; await f.runtime.dispose(); await rejected;
    } finally { await f.cleanup(); }
  });
  it('retains old inbound proof for reads but invalidates it before begin and revoke', async () => {
    const { DelegationRepository } = await import('../../src/main/delegation/delegationRepository');
    const { PM_NOW } = await import('../fixtures/pmAccounts');
    const f = await fixture({ opener: async () => undefined, fetch: async raw => {
      const path = new URL(String(raw)).pathname;
      if (path === '/google/begin') return new Response(JSON.stringify({ authorizationUrl: authorizationUrl() }));
      if (path === '/google/disclosure') return new Response(JSON.stringify(personalGoogleGrantDisclosure));
      return new Response(JSON.stringify({ state: path === '/google/revoke' ? 'revoked' : 'unconfigured', grant: null }));
    } });
    try {
      const account = f.repo.create({ commandId: '33333333-3333-4333-8333-333333333333', name: 'Proof account', domain: null });
      new DelegationRepository({ database: f.db, workspaceId: 'ws', clock: { now: () => PM_NOW } }).initializeLocalAuthority(account.id);
      const subject = { kind: 'account' as const, id: account.id };
      const proof = await f.runtime.adapter.synchronize(subject, new AbortController().signal);
      expect(f.runtime.adapter.isAppliedCurrent(subject, proof.revision)).toBe(true);
      await f.runtime.googleConnections.status(selector); await f.runtime.googleConnections.disclosure(selector);
      expect(f.runtime.adapter.isAppliedCurrent(subject, proof.revision)).toBe(true);
      await f.runtime.googleConnections.begin(begin);
      expect(f.runtime.adapter.isAppliedCurrent(subject, proof.revision)).toBe(false);
      const next = await f.runtime.adapter.synchronize(subject, new AbortController().signal);
      expect(f.runtime.adapter.isAppliedCurrent(subject, next.revision)).toBe(true);
      await f.runtime.googleConnections.revoke(selector);
      expect(f.runtime.adapter.isAppliedCurrent(subject, next.revision)).toBe(false);
    } finally { await f.cleanup(); }
  });
  it('bounds a nonsettling native opener with the combined 15-second timeout', async () => {
    const timeout = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
    let entered!: () => void;
    const opened = new Promise<void>(resolve => { entered = resolve; });
    const f = await fixture({ opener: () => { entered(); return new Promise<void>(() => undefined); },
      fetch: async () => new Response(JSON.stringify({ authorizationUrl: authorizationUrl() })) });
    try {
      const result = f.runtime.googleConnections.begin(begin);
      const rejected = expect(result).rejects.toThrow('delegation_inactive');
      await opened; expect(timeoutSpy).toHaveBeenCalledWith(15000); timeout.abort();
      await rejected; await f.runtime.dispose();
    } finally { timeoutSpy.mockRestore(); await f.cleanup(); }
  });
  it('reads status/disclosure without sync and revokes purpose without auto-configuration', async () => {
    const f = await fixture({ fetch: async (raw, init) => {
      const url = new URL(String(raw));
      if (url.pathname === '/google/status') return new Response(JSON.stringify({ state: 'ready', grant: personalGrant }));
      if (url.pathname === '/google/disclosure') return new Response(JSON.stringify(personalGoogleGrantDisclosure));
      if (url.pathname === '/google/revoke') { expect(JSON.parse(String(init?.body))).toEqual(selector); return new Response(JSON.stringify({ state: 'revoked', grant: personalGrant, providerRevocation: 'pending' })); }
      throw Error('Unexpected synchronization or mutation');
    } });
    try {
      await f.runtime.googleConnections.status(selector); await f.runtime.googleConnections.disclosure(selector); await f.runtime.googleConnections.revoke(selector);
      expect(f.fetcher).toHaveBeenCalledTimes(3);
      expect(f.db.raw.prepare('SELECT * FROM delegated_commands').all()).toEqual([]);
    } finally { await f.cleanup(); }
  });
});
