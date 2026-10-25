// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { type EmailCampaignPolicy } from '@fss/contracts';
import { BrowserClient, type InvalidationChannel } from '../../src/client/BrowserClient.ts';
import { EmailCampaignClient } from '../../src/client/EmailCampaignClient.ts';
import { BrowserEmailCampaigns } from '../../src/client/BrowserEmailCampaigns.tsx';
import { BrowserApp } from '../../src/client/BrowserApp.tsx';
import { CAMPAIGN_PENDING_KEY, campaignPendingSchema } from '../../src/client/CampaignPending.ts';

const id = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });
const policy = (): EmailCampaignPolicy => ({ mailboxId: id, sequenceVersionId: other, authorizationRevision: 2, regions: ['MA'], maxEnrollments: 25, dailyAdmissionLimit: 1, expiresAt: new Date(Date.now() + 86400000).toISOString() });
const control = { campaigns: [], admissions: [], senders: [{ id, label: 'Approved synthetic sender', authorizationRevision: 2 }], sequences: [{ id: other, label: 'Published five-email sequence' }], sendingAuthority: 'unchanged' };
const resources: { dispose(): void }[] = [];
function setup() {
  const storage = sessionStorage;
  let session = { status: 'signed_in', workspaceId: id, userId: id, deviceId: id, role: 'admin', revision: 'one', csrfToken: 'c'.repeat(40), expiresAt: new Date(Date.now() + 60000).toISOString() };
  let lose = false, readStatus = 200, commandStatus = 200;
  let waitCommand: (() => Promise<void>) | undefined;
  let waitControl: (() => Promise<Response>) | undefined;
  let broadcast: (() => void) | undefined;
  const channel: InvalidationChannel = { postMessage: vi.fn(), addEventListener: (_type, listener) => { broadcast = listener; }, removeEventListener: () => {}, close: () => {} };
  const commands: unknown[] = [];
  const send = vi.fn<typeof fetch>(async (url, init) => {
    if (url === '/browser/session') return json(session);
    if (String(url).startsWith('/browser/api/today?')) return json({ workspaceId: id, snapshotDate: '2026-10-22', businessTimeZone: 'America/New_York', cards: [] });
    if (url === '/browser/api/outreach/email-campaigns/control') return waitControl ? await waitControl() : json(control, readStatus);
    if (String(url).match(/\/email-campaigns\/(approve|revoke)$/u)) {
      expect(storage.getItem(CAMPAIGN_PENDING_KEY)).not.toBeNull();
      commands.push(JSON.parse(String(init?.body)));
      await waitCommand?.();
      if (lose) throw new Error('Committed response lost');
      return json({ status: 'accepted', replayed: commands.length > 1, result: { campaignId: id, revision: 1 } }, commandStatus);
    }
    throw new Error('Unexpected route');
  });
  const browser = new BrowserClient({ fetch: send, storage, channel, navigate: vi.fn(), randomUUID: () => id });
  const uuid = vi.fn(() => other);
  const client = new EmailCampaignClient(browser, storage, uuid);
  resources.push(browser, client);
  return { browser, client, storage, commands, send, uuid, broadcast: () => { broadcast?.(); },
    lose: (value: boolean) => { lose = value; }, readStatus: (value: number) => { readStatus = value; }, commandStatus: (value: number) => { commandStatus = value; },
    change: (value: Partial<typeof session>) => { session = { ...session, ...value }; }, wait: (value: () => Promise<void>) => { waitCommand = value; },
    waitControl: (value: () => Promise<Response>) => { waitControl = value; } };
}
afterEach(() => { cleanup(); for (const resource of resources.splice(0)) resource.dispose(); sessionStorage.clear(); vi.useRealTimers(); });

describe('campaign exact command custody over actual BrowserClient', () => {
  it('same-mounted BrowserApp recovers enabled campaign controls after command 409 and Refresh access without replay', async () => {
    const scope = setup(); await scope.browser.refresh();
    scope.client.prepare({ kind: 'revoke', id, expectedRevision: 1 }); scope.commandStatus(409);
    render(<BrowserApp client={scope.browser} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry same campaign command' }));
    await vi.waitFor(() => { expect(scope.browser.current).toBeNull(); });
    expect(scope.commands).toHaveLength(1); expect(scope.storage.getItem(CAMPAIGN_PENDING_KEY)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh access' }));
    const refresh = await screen.findByRole('button', { name: 'Refresh campaigns' });
    expect(refresh.hasAttribute('disabled')).toBe(false);
    fireEvent.click(refresh);
    await screen.findByRole('option', { name: /Published five-email/u });
    expect(scope.commands).toHaveLength(1);
  });
  it('cross-tab recovery permits a new operation while late old completion cannot publish or unlock it', async () => {
    const scope = setup(); await scope.browser.refresh();
    const releases: ((response: Response) => void)[] = [];
    scope.waitControl(() => new Promise<Response>(resolve => { releases.push(resolve); }));
    render(<BrowserApp client={scope.browser} />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh campaigns' }));
    await vi.waitFor(() => { expect(releases).toHaveLength(1); });
    await act(async () => { scope.broadcast(); });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh access' }));
    const refresh = await screen.findByRole('button', { name: 'Refresh campaigns' });
    expect(refresh.hasAttribute('disabled')).toBe(false);
    fireEvent.click(refresh);
    await vi.waitFor(() => { expect(releases).toHaveLength(2); });
    await act(async () => { releases[0]?.(json({ ...control, sequences: [{ id: other, label: 'Stale old sequence' }] })); });
    expect(screen.getByRole('button', { name: 'Refresh campaigns' }).hasAttribute('disabled')).toBe(true);
    expect(screen.queryByRole('option', { name: 'Stale old sequence' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh campaigns' }));
    expect(releases).toHaveLength(2);
    await act(async () => { releases[1]?.(json({ ...control, sequences: [{ id: other, label: 'Current replacement sequence' }] })); });
    expect(screen.getByRole('button', { name: 'Refresh campaigns' }).hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('option', { name: 'Current replacement sequence' })).toBeTruthy();
    expect(scope.commands).toHaveLength(0);
  });
  it('persists before dispatch, retains lost response and reload never replays, explicit retry is identical', async () => {
    const scope = setup(); await scope.browser.refresh(); scope.lose(true);
    scope.client.prepare({ kind: 'approve', policy: policy() });
    await expect(scope.client.retry()).rejects.toThrow('unavailable');
    const held = scope.storage.getItem(CAMPAIGN_PENDING_KEY);
    expect(held).not.toMatch(/Approved synthetic|Published|csrf|credential|address/u);
    scope.client.dispose();
    const reloaded = new EmailCampaignClient(scope.browser, scope.storage, scope.uuid); resources.push(reloaded);
    render(<BrowserEmailCampaigns client={scope.browser} />);
    expect(screen.getByRole('button', { name: 'Retry same campaign command' })).toBeTruthy();
    expect(scope.commands).toHaveLength(1);
    scope.lose(false); await reloaded.retry();
    expect(scope.commands).toHaveLength(2); expect(scope.commands[1]).toEqual(scope.commands[0]);
    expect(scope.uuid).toHaveBeenCalledTimes(1); expect(scope.storage.getItem(CAMPAIGN_PENDING_KEY)).toBeNull();
  });
  it('accepted IDs survive authenticated current source unavailability and retry only reads', async () => {
    const scope = setup(); await scope.browser.refresh(); scope.readStatus(503);
    scope.client.prepare({ kind: 'revoke', id, expectedRevision: 3 });
    await expect(scope.client.retry()).rejects.toThrow('refused');
    expect(scope.client.pending()?.accepted).toEqual({ campaignId: id, revision: 1 });
    expect(() => scope.client.prepare({ kind: 'approve', policy: policy() })).toThrow('refused');
    scope.readStatus(200); await scope.client.retry();
    expect(scope.commands).toEqual([{ id, expectedRevision: 3, commandId: other }]);
  });
  it.each(['revision', 'role', 'userId'] as const)('clears pending on actual %s change', async field => {
    const scope = setup(); await scope.browser.refresh(); scope.client.prepare({ kind: 'approve', policy: policy() });
    scope.change({ [field]: field === 'role' ? 'salesperson' : field === 'userId' ? other : 'two' });
    await expect(scope.browser.refresh()).rejects.toThrow('session_changed');
    expect(scope.storage.getItem(CAMPAIGN_PENDING_KEY)).toBeNull();
  });
  it.each([401, 403, 409])('honestly clears pending on generic boundary refusal %s', async status => {
    const scope = setup(); await scope.browser.refresh(); scope.client.prepare({ kind: 'revoke', id, expectedRevision: 1 }); scope.commandStatus(status);
    await expect(scope.client.retry()).rejects.toThrow('refused'); expect(scope.storage.getItem(CAMPAIGN_PENDING_KEY)).toBeNull();
  });
  it('cross-tab invalidation fences a late accepted command and clears private UI', async () => {
    const scope = setup(); await scope.browser.refresh(); scope.client.prepare({ kind: 'approve', policy: policy() });
    let release: (() => void) | undefined;
    scope.wait(() => new Promise<void>(resolve => { release = resolve; }));
    const result = expect(scope.client.retry()).rejects.toThrow('session_changed');
    await vi.waitFor(() => { expect(scope.commands).toHaveLength(1); });
    render(<BrowserEmailCampaigns client={scope.browser} />);
    await act(async () => { scope.broadcast(); release?.(); });
    await result;
    expect(scope.storage.getItem(CAMPAIGN_PENDING_KEY)).toBeNull(); expect(screen.queryByRole('region', { name: 'Email campaigns' })).toBeNull();
  });
  it('expires idle pending custody on timer, not only on a later request', async () => {
    vi.useFakeTimers(); const scope = setup(); await scope.browser.refresh();
    scope.client.prepare({ kind: 'approve', policy: { ...policy(), expiresAt: new Date(Date.now() + 1000).toISOString() } });
    await vi.advanceTimersByTimeAsync(1001); expect(scope.storage.getItem(CAMPAIGN_PENDING_KEY)).toBeNull(); expect(scope.commands).toHaveLength(0);
  });
  it('cold reload discovers same identity without dispatch and retains exact custody', async () => {
    const scope = setup(); await scope.browser.refresh();
    const held = scope.client.prepare({ kind: 'approve', policy: policy() });
    scope.client.dispose();
    const replacement = new BrowserClient({ fetch: scope.send, storage: scope.storage, navigate: vi.fn(), randomUUID: () => id });
    const manager = new EmailCampaignClient(replacement, scope.storage, () => id); resources.push(replacement, manager);
    expect(manager.pending()).toBeNull(); expect(scope.storage.getItem(CAMPAIGN_PENDING_KEY)).not.toBeNull();
    await replacement.refresh(); expect(manager.pending()).toEqual(held); expect(scope.commands).toHaveLength(0);
  });
  it('actual BrowserApp cold signed-out discovery clears retained command without mounting private campaign controls', async () => {
    const scope = setup(); await scope.browser.refresh();
    scope.client.prepare({ kind: 'approve', policy: policy() });
    scope.client.dispose();
    const send = vi.fn<typeof fetch>(async () => json({ status: 'signed_out', csrfToken: 'c'.repeat(40) }));
    const replacement = new BrowserClient({ fetch: send, storage: scope.storage, navigate: vi.fn(), randomUUID: () => id }); resources.push(replacement);
    render(<BrowserApp client={replacement} />);
    await screen.findByLabelText('Workspace ID');
    await vi.waitFor(() => { expect(scope.storage.getItem(CAMPAIGN_PENDING_KEY)).toBeNull(); });
    expect(screen.queryByRole('region', { name: 'Email campaigns' })).toBeNull();
    expect(scope.commands).toHaveLength(0);
    expect(send.mock.calls.every(([url]) => url === '/browser/session')).toBe(true);
  });
  it('policy expiry fences a late accepted response without reconstituting custody', async () => {
    vi.useFakeTimers(); const scope = setup(); await scope.browser.refresh();
    scope.client.prepare({ kind: 'approve', policy: { ...policy(), expiresAt: new Date(Date.now() + 1000).toISOString() } });
    let release: (() => void) | undefined;
    scope.wait(() => new Promise<void>(resolve => { release = resolve; }));
    const result = expect(scope.client.retry()).rejects.toThrow('session_changed');
    await vi.advanceTimersByTimeAsync(1); expect(scope.commands).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000); release?.(); await result;
    expect(scope.storage.getItem(CAMPAIGN_PENDING_KEY)).toBeNull();
  });
  it('logout immediately clears custody and prevents replay even when remote logout fails', async () => {
    const scope = setup(); await scope.browser.refresh(); scope.client.prepare({ kind: 'revoke', id, expectedRevision: 1 });
    await expect(scope.browser.signOut()).rejects.toThrow(); expect(scope.storage.getItem(CAMPAIGN_PENDING_KEY)).toBeNull();
    await expect(scope.client.retry()).rejects.toThrow('refused'); expect(scope.commands).toHaveLength(0);
  });
  it('storage failure prevents dispatch and strict custody rejects prose/unknown fields', async () => {
    const scope = setup(); await scope.browser.refresh();
    expect(campaignPendingSchema.safeParse({ identity: 'public', commandId: id, expiresAt: policy().expiresAt, action: { kind: 'approve', policy: { ...policy(), address: 'private' } } }).success).toBe(false);
    const client = new EmailCampaignClient(scope.browser, { getItem: () => null, removeItem: () => {}, setItem: () => { throw new Error('blocked'); } }, () => id); resources.push(client);
    expect(() => client.prepare({ kind: 'approve', policy: policy() })).toThrow('storage_unavailable'); expect(scope.commands).toHaveLength(0);
    const unreadable = new EmailCampaignClient(scope.browser, { getItem: () => { throw new Error('blocked'); }, removeItem: () => {}, setItem: vi.fn() }, () => id); resources.push(unreadable);
    expect(() => unreadable.prepare({ kind: 'approve', policy: policy() })).toThrow('storage_unavailable');
  });
  it('RTL presents approved choices and explicit subset, approves once with no recipient/send controls', async () => {
    // Pin Date only: real async timers still run, while the bounded expiry fixture cannot age out.
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-22T12:00:00.000Z'));
    const scope = setup(); await scope.browser.refresh(); render(<BrowserEmailCampaigns client={scope.browser} />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh campaigns' }));
    await screen.findByRole('option', { name: /Published five-email/u });
    fireEvent.change(screen.getByLabelText('Approved sender'), { target: { value: id } });
    fireEvent.change(screen.getByLabelText('Approved email sequence'), { target: { value: other } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'MA' }));
    for (const expiresAt of ['2026-10-21T12:00', '2026-11-23T12:00']) {
      fireEvent.change(screen.getByLabelText('Campaign expiry'), { target: { value: expiresAt } });
      fireEvent.click(screen.getByRole('button', { name: 'Approve campaign once' }));
      expect(screen.getByRole('status').textContent).toContain('an expiry within 30 days');
      expect(scope.commands).toHaveLength(0); expect(scope.storage.getItem(CAMPAIGN_PENDING_KEY)).toBeNull();
    }
    fireEvent.change(screen.getByLabelText('Campaign expiry'), { target: { value: '2026-10-23T12:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve campaign once' }));
    await vi.waitFor(() => { expect(scope.commands).toHaveLength(1); });
    expect(scope.commands[0]).toMatchObject({ mailboxId: id, sequenceVersionId: other, regions: ['MA'], authorizationRevision: 2, dailyAdmissionLimit: 1, maxEnrollments: 25, expiresAt: new Date('2026-10-23T12:00').toISOString() });
    expect(screen.queryByRole('button', { name: /^send|recipient/iu })).toBeNull();
  });
});
