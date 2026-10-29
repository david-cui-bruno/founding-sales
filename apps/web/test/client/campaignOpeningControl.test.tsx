// @vitest-environment jsdom
import '../../src/client/schemaRuntime.ts';
import { webcrypto } from 'node:crypto';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { campaignOpeningApproveCommandSchema, campaignOpeningPolicySchema, type CampaignOpeningControl } from '@fss/contracts';
import { payloadHashOf } from '../../../api/src/auth/tokens.ts';
import { BrowserClient } from '../../src/client/BrowserClient.ts';
import { BrowserCampaignOpening } from '../../src/client/BrowserCampaignOpening.tsx';
import { BrowserEmailCampaigns } from '../../src/client/BrowserEmailCampaigns.tsx';
import { CampaignOpeningDispatch } from '../../src/client/CampaignOpeningDispatch.ts';
import { CampaignOpeningCustody, campaignOpeningPendingSchema } from '../../src/client/CampaignOpeningPending.ts';
const id = '10000000-0000-4000-8000-000000000001', other = '20000000-0000-4000-8000-000000000002';
const phrase = 'Explicit approved {{firm_name}} opening.';
const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status });
const clients: BrowserClient[] = [];
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { resolve, promise }; }
function locks() { const tails = new Map<string, Promise<unknown>>(); return { request: (key: string, _options: unknown, work: () => Promise<unknown>) => {
  const next = (tails.get(key) ?? Promise.resolve()).catch(() => {}).then(work); tails.set(key, next); return next;
} }; }
function setup() {
  const expiry = new Date(Date.now() + 3600000).toISOString();
  let control: CampaignOpeningControl = { campaignId: id, campaignRevision: 1, campaignExpiresAt: expiry, baseline: { sequenceVersionId: id,
    templateVersionId: id, templateVersion: 1, templateContentHash: 'a'.repeat(64), subject: 'Exact baseline subject', body: 'Exact baseline body\n\nSigned off', approvedAt: new Date(Date.now() - 1000).toISOString() },
    policy: null, approvalState: 'available', selectorReadiness: 'not_established', sendingAuthority: 'unchanged' };
  let session = { status: 'signed_in', workspaceId: id, userId: id, deviceId: id, role: 'admin', revision: 'opening-session', csrfToken: 'c'.repeat(40), expiresAt: new Date(Date.now() + 120000).toISOString() };
  let receipt: unknown = { state: 'unknown' }, read: (() => Promise<Response>) | null = null;
  let send: (body: Record<string, unknown>, action: string) => Promise<Response> = async (body, action) => {
    if (action === 'approve') {
      control = { ...control, approvalState: 'already_configured', policy: { value: campaignOpeningPolicySchema.parse({ variants: body['variants'], expiresAt: body['expiresAt'], id: other,
        workspaceId: id, ownerUserId: id, campaignId: id, campaignRevision: 1, sequenceVersionId: id, templateVersionId: id, templateContentHash: 'a'.repeat(64),
        revision: 1, mode: 'approved_variant_selection_v1', firstEmailOnly: true, approvedAt: new Date().toISOString() }), revokedAt: null, state: 'active' } };
    } else if (control.policy) control = { ...control, policy: { ...control.policy, state: 'revoked', revokedAt: new Date().toISOString() } };
    return json({ status: 'accepted', replayed: false, result: { campaignId: id, policyId: other, policyRevision: 1 } });
  };
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const storage = { getItem: (key: string) => localStorage.getItem(key), setItem: (key: string, value: string) => { localStorage.setItem(key, value); }, removeItem: (key: string) => { localStorage.removeItem(key); } };
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    if (url === '/browser/session') return json(session);
    const path = String(url), body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>; calls.push({ path, body });
    if (path.endsWith('/email-campaigns/control')) return json({ campaigns: [{ id, revision: 1, ownerUserId: id, approvedAt: new Date().toISOString(), revokedAt: null, state: 'active', admittedCount: 0,
      mailboxId: id, sequenceVersionId: id, authorizationRevision: 1, regions: ['TX'], maxEnrollments: 25, dailyAdmissionLimit: 5, expiresAt: expiry }], admissions: [], senders: [], sequences: [], sendingAuthority: 'unchanged' });
    if (path.endsWith('/opening/control')) return read ? read() : json(control);
    if (path.endsWith('/opening/receipt')) return json(receipt);
    if (/\/opening\/(approve|revoke)$/u.test(path)) {
      expect(localStorage.length).toBe(1); expect(JSON.stringify({ ...localStorage })).not.toMatch(/Explicit approved|Exact baseline|csrfToken|credential/u);
      return send(body, path.endsWith('/approve') ? 'approve' : 'revoke');
    }
    throw Error('Unexpected opening route');
  });
  const make = () => { const client = new BrowserClient({ fetch, storage, navigate: vi.fn(), randomUUID: () => id }); clients.push(client); return client; };
  const client = make();
  return { client, make, storage, calls, control: () => control, patch: (value: Partial<CampaignOpeningControl>) => { control = { ...control, ...value }; },
    read: (value: typeof read) => { read = value; }, send: (value: typeof send) => { send = value; }, receipt: (value: unknown) => { receipt = value; }, change: (patch: Partial<typeof session>) => { session = { ...session, ...patch }; } };
}
async function mount(s: ReturnType<typeof setup>) { await s.client.refresh(); return render(<BrowserCampaignOpening client={s.client} campaignId={id} />); }
const button = (name: string) => screen.getByRole('button', { name });
async function read() { fireEvent.click(button('Read current opening policy')); await screen.findByLabelText('Approved opening lines'); }
async function readWithControlledClock() {
  await act(async () => { fireEvent.click(button('Read current opening policy')); await vi.advanceTimersByTimeAsync(0); });
  expect(screen.getByLabelText('Approved opening lines')).toBeTruthy();
}
function enter() {
  fireEvent.change(screen.getByLabelText('Approved opening lines'), { target: { value: phrase } });
  fireEvent.change(screen.getByLabelText('Opening policy expiry'), { target: { value: new Date(Date.now() + 600000 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) } });
  fireEvent.click(screen.getByRole('checkbox', { name: /I reviewed the exact baseline/u }));
}
beforeEach(() => { localStorage.clear(); vi.stubGlobal('crypto', webcrypto); Object.defineProperty(navigator, 'locks', { value: locks(), configurable: true }); });
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.dispose()); vi.useRealTimers(); vi.unstubAllGlobals(); localStorage.clear(); });
it('requires informed exact baseline, explicit lines/expiry/confirmation, approves then separately reads and revokes', async () => {
  const s = setup(); await mount(s); expect(screen.queryByLabelText('Approved opening lines')).toBeNull(); await read();
  expect(screen.getByText('Exact baseline subject')).toBeTruthy(); expect(screen.getByText(/Exact baseline body/u).textContent).toBe('Exact baseline body\n\nSigned off');
  expect(screen.getByLabelText('Approved opening lines')).toHaveProperty('value', ''); expect(screen.getByLabelText('Opening policy expiry')).toHaveProperty('value', '');
  expect(button('Approve opening policy once')).toHaveProperty('disabled', true); enter(); fireEvent.click(button('Approve opening policy once'));
  await screen.findByRole('article', { name: 'Configured opening policy' }); expect(s.calls.filter(x => x.path.endsWith('/approve'))).toHaveLength(1);
  expect(localStorage.length).toBe(0); expect(s.control().selectorReadiness).toBe('not_established');
  fireEvent.click(button('Revoke opening policy')); await waitFor(() => expect(s.control().policy?.state).toBe('revoked'));
  await waitFor(() => expect(button('Revoke opening policy')).toHaveProperty('disabled', true));
  expect(screen.queryByRole('button', { name: 'Approve opening policy once' })).toBeNull(); expect(s.calls.filter(x => x.path.endsWith('/revoke'))).toHaveLength(1);
});
it('mounts only selected current owned campaign inside existing Automatic outreach', async () => {
  const s = setup(); await s.client.refresh(); render(<BrowserEmailCampaigns client={s.client} />);
  expect(screen.queryByRole('region', { name: 'First-email opening policy' })).toBeNull(); fireEvent.click(button('Refresh campaigns'));
  const select = await screen.findByLabelText('Opening policy campaign'); fireEvent.change(select, { target: { value: id } });
  expect(screen.getByRole('region', { name: 'First-email opening policy' })).toBeTruthy(); expect(s.calls.some(x => x.path.includes('/opening/'))).toBe(false);
});
it('canonical opaque digest exactly equals actual parsed command payload hash', async () => {
  const s = setup(); await s.client.refresh(); const custody = new CampaignOpeningCustody(s.client, s.storage);
  const baseline = s.control().baseline!, raw = { campaignId: id, expectedCampaignRevision: 1, templateVersionId: id, templateContentHash: baseline.templateContentHash,
    variants: [{ id: 'one', text: phrase }], expiresAt: s.control().campaignExpiresAt };
  const held = await custody.exclusive(() => custody.prepare('approve', raw, () => true));
  const { commandId: _id, clientVersion: _version, ...payload } = campaignOpeningApproveCommandSchema.parse({ ...raw, commandId: held.commandId, clientVersion: '1.4.0' });
  expect(held.payloadSHA256).toBe(payloadHashOf(payload)); expect(JSON.stringify({ ...localStorage })).not.toContain(phrase);
});
it('lost response, lock release, reload and other campaign never replay/remint; receipt recovery is read-only', async () => {
  const s = setup(), view = await mount(s); await read(); enter(); s.send(async () => { throw Error('lost response'); });
  fireEvent.click(button('Approve opening policy once')); await waitFor(() => expect(button('Reconcile opening receipt only')).toHaveProperty('disabled', false));
  const retained = JSON.stringify({ ...localStorage }); view.unmount(); const otherClient = s.make(); await otherClient.refresh();
  const otherView = render(<BrowserCampaignOpening client={otherClient} campaignId={other} />);
  expect(button('Reconcile opening receipt only')).toBeTruthy(); fireEvent.click(button('Reconcile opening receipt only')); await screen.findByText(/outcome UNKNOWN/u);
  expect(JSON.stringify({ ...localStorage })).toBe(retained); expect(s.calls.filter(x => x.path.endsWith('/approve'))).toHaveLength(1); expect(screen.queryByRole('button', { name: /Retry/u })).toBeNull();
  otherView.unmount(); const reloaded = new CampaignOpeningDispatch(otherClient, s.storage); s.receipt({ state: 'accepted', result: { campaignId: id, policyId: other, policyRevision: 1 } });
  await reloaded.reconcile(() => true); expect(localStorage.length).toBe(0); expect(s.calls.filter(x => x.path.endsWith('/approve'))).toHaveLength(1);
});
it('accepted receipt plus unavailable current read retains IDs and later recovery sends no write', async () => {
  const s = setup(); await s.client.refresh(); const manager = new CampaignOpeningDispatch(s.client, s.storage), viewed = s.control(); let reads = 0;
  s.read(async () => ++reads === 1 ? json(viewed) : json({}, 503)); s.send(async () => json({ status: 'accepted', replayed: false, result: { campaignId: id, policyId: other, policyRevision: 1 } }));
  await expect(manager.approve({ campaignId: id, expectedCampaignRevision: 1, templateVersionId: id, templateContentHash: 'a'.repeat(64), variants: [{ id: 'one', text: phrase }], expiresAt: viewed.campaignExpiresAt }, viewed, () => true)).rejects.toThrow();
  expect(manager.custody.read()?.accepted).toEqual({ campaignId: id, policyId: other, policyRevision: 1 }); s.read(null); await manager.reconcile(() => true);
  expect(s.calls.filter(x => x.path.endsWith('/approve'))).toHaveLength(1); expect(s.calls.filter(x => x.path.endsWith('/receipt'))).toHaveLength(0); expect(localStorage.length).toBe(0);
});
it.each(['baseline', 'campaign', 'policy'] as const)('changed %s at pre-write read refuses without a UUID or command and clears copy', async mode => {
  const s = setup(); await mount(s); await read(); enter();
  s.patch(mode === 'baseline' ? { baseline: { ...s.control().baseline!, templateContentHash: 'b'.repeat(64) } } : mode === 'campaign' ? { campaignRevision: 2 } : { approvalState: 'unavailable' });
  fireEvent.click(button('Approve opening policy once')); await screen.findByText(/Opening control unavailable, refused or selection changed/u);
  expect(localStorage.length).toBe(0); expect(s.calls.some(x => x.path.endsWith('/approve'))).toBe(false); expect(screen.queryByLabelText('Approved opening lines')).toBeNull();
});
it.each(['unmount', 'selection', 'auth', 'role'] as const)('%s fences a late result without erasing UNKNOWN custody', async mode => {
  const s = setup(), view = await mount(s); await read(); enter(); const late = deferred<Response>(); s.send(() => late.promise);
  fireEvent.click(button('Approve opening policy once')); await waitFor(() => expect(s.calls.filter(x => x.path.endsWith('/approve'))).toHaveLength(1)); const original = JSON.stringify({ ...localStorage });
  if (mode === 'unmount') view.unmount();
  if (mode === 'selection') view.rerender(<BrowserCampaignOpening client={s.client} campaignId={other} />);
  if (mode === 'auth') act(() => s.client.invalidate(false));
  if (mode === 'role') { s.change({ role: 'salesperson' }); await act(async () => { await s.client.refresh().catch(() => {}); }); }
  await act(async () => late.resolve(json({ status: 'accepted', replayed: false, result: { campaignId: id, policyId: other, policyRevision: 1 } })));
  expect(JSON.stringify({ ...localStorage })).toBe(original); expect(screen.queryByText(/Separate current policy read loaded/u)).toBeNull();
});
it('cross-tab pending excludes simultaneous write and clears old copy on storage notification', async () => {
  const s = setup(); await mount(s); await read(); enter(); const otherClient = s.make(); await otherClient.refresh();
  const custody = new CampaignOpeningCustody(otherClient, s.storage), binding = custody.binding()!;
  await custody.exclusive(() => custody.prepare('revoke', { campaignId: other, expectedCampaignRevision: 1 }, () => true));
  act(() => window.dispatchEvent(new StorageEvent('storage', { key: binding.key })));
  expect(screen.queryByLabelText('Approved opening lines')).toBeNull(); expect(screen.getByRole('complementary', { name: 'Pending opening command' })).toBeTruthy();
  const manager = new CampaignOpeningDispatch(s.client, s.storage);
  await expect(manager.revoke({ ...s.control(), policy: { value: campaignOpeningPolicySchema.parse({ id, workspaceId: id, ownerUserId: id, campaignId: id, campaignRevision: 1, sequenceVersionId: id, templateVersionId: id, templateContentHash: 'a'.repeat(64), revision: 1, mode: 'approved_variant_selection_v1', firstEmailOnly: true, variants: [{ id: 'a', text: 'Approved' }], approvedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: s.control().campaignExpiresAt }), revokedAt: null, state: 'active' } }, () => true)).rejects.toThrow();
  expect(s.calls.some(x => x.path.endsWith('/revoke'))).toBe(false);
});
it('missing locks, failed storage and corrupt/expired custody never authorize replacement', async () => {
  const s = setup(); await s.client.refresh(); const custody = new CampaignOpeningCustody(s.client, s.storage), binding = custody.binding()!;
  localStorage.setItem(binding.key, 'corrupt'); expect(() => custody.read()).toThrow(); expect(localStorage.getItem(binding.key)).toBe('corrupt');
  localStorage.setItem(binding.key, JSON.stringify({ identity: binding.identity, expiresAt: '2020-01-01T00:00:00.000Z', commandId: id, action: 'approve', campaignId: id, expectedCampaignRevision: 1, payloadSHA256: 'a'.repeat(64) }));
  expect(() => custody.read()).toThrow(); expect(localStorage.getItem(binding.key)).not.toBeNull();
  Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true }); await expect(custody.exclusive(async () => {})).rejects.toThrow();
  const blocked = new CampaignOpeningCustody(s.client, { getItem: () => { throw Error('blocked'); }, setItem: vi.fn(), removeItem: vi.fn() }); expect(() => blocked.read()).toThrow();
  expect(campaignOpeningPendingSchema.safeParse({ prose: phrase }).success).toBe(false);
});
it('unavailable baseline never offers approval', async () => {
  const s = setup(); s.patch({ baseline: null, approvalState: 'unavailable' }); await mount(s); fireEvent.click(button('Read current opening policy'));
  await screen.findByText(/Full approved baseline unavailable/u); expect(screen.queryByRole('button', { name: 'Approve opening policy once' })).toBeNull();
});
it('synchronous double approval and another tab share one immutable UNKNOWN slot', async () => {
  const s = setup(); await mount(s); await read(); enter(); const late = deferred<Response>(); s.send(() => late.promise);
  const approve = button('Approve opening policy once'); fireEvent.click(approve); fireEvent.click(approve);
  await waitFor(() => expect(s.calls.filter(x => x.path.endsWith('/approve'))).toHaveLength(1));
  const second = s.make(); await second.refresh(); const manager = new CampaignOpeningDispatch(second, s.storage), viewed = s.control();
  const attempt = manager.approve({ campaignId: id, expectedCampaignRevision: 1, templateVersionId: id, templateContentHash: 'a'.repeat(64),
    variants: [{ id: 'one', text: phrase }], expiresAt: viewed.campaignExpiresAt }, viewed, () => true);
  const rejected = expect(attempt).rejects.toThrow(); await act(async () => late.resolve(json({}, 503))); await rejected;
  expect(s.calls.filter(x => x.path.endsWith('/approve'))).toHaveLength(1); expect(localStorage.length).toBe(1);
});
it('finite business refusal clears only its exact command and never silently retries', async () => {
  const s = setup(); await mount(s); await read(); enter(); s.send(async () => json({ status: 'refused', replayed: false, reason: 'already_configured' }));
  fireEvent.click(button('Approve opening policy once')); await screen.findByText(/Opening command refused: already_configured/u);
  expect(localStorage.length).toBe(0); expect(s.calls.filter(x => x.path.endsWith('/approve'))).toHaveLength(1);
  expect(screen.queryByLabelText('Approved opening lines')).toBeNull();
});
it('refused recovery is receipt-only, while wrong-target acceptance retains UNKNOWN', async () => {
  const s = setup(); await s.client.refresh(); const manager = new CampaignOpeningDispatch(s.client, s.storage);
  const held = await manager.custody.exclusive(() => manager.custody.prepare('approve', { campaignId: id, expectedCampaignRevision: 1 }, () => true));
  s.receipt({ state: 'accepted', result: { campaignId: other, policyId: other, policyRevision: 1 } });
  await expect(manager.reconcile(() => true)).rejects.toThrow('target mismatch'); expect(manager.custody.read()).toEqual(held);
  s.receipt({ state: 'refused', reason: 'expiry_invalid' }); expect(await manager.reconcile(() => true)).toEqual({ receipt: { state: 'refused', reason: 'expiry_invalid' }, current: null });
  expect(localStorage.length).toBe(0); expect(s.calls.every(x => x.path.endsWith('/receipt'))).toBe(true);
});
it('session lifetime clears in-memory copy and fences approval', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-29T12:00:00.000Z'));
  const s = setup(); s.change({ expiresAt: new Date(Date.now() + 500).toISOString() }); await mount(s); await readWithControlledClock(); enter();
  await act(async () => { await vi.advanceTimersByTimeAsync(499); });
  expect(screen.getByLabelText('Approved opening lines')).toHaveProperty('value', phrase);
  expect(s.client.current?.status).toBe('signed_in');
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(screen.queryByLabelText('Approved opening lines')).toBeNull();
  expect(screen.queryByRole('region', { name: 'First-email opening policy' })).toBeNull(); expect(s.calls.some(x => x.path.endsWith('/approve'))).toBe(false);
});
it('campaign lifetime clears copy while an otherwise current signed session remains usable', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-29T12:00:00.000Z'));
  const s = setup(); s.patch({ campaignExpiresAt: new Date(Date.now() + 350).toISOString() }); await mount(s); await readWithControlledClock(); enter();
  await act(async () => { await vi.advanceTimersByTimeAsync(349); });
  expect(screen.getByLabelText('Approved opening lines')).toHaveProperty('value', phrase);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(screen.getByText(/Policy or session lifetime elapsed/u)).toBeTruthy(); expect(screen.queryByLabelText('Approved opening lines')).toBeNull();
  expect(s.client.current?.status).toBe('signed_in'); expect(s.calls.some(x => x.path.endsWith('/approve'))).toBe(false);
});
