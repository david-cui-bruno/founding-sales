// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { z } from 'zod';
import { qualifiedResearchFirmSchema, type QualifiedResearchSelection } from '@fss/contracts';
import { BrowserApp } from '../../src/client/BrowserApp.tsx';
import { BrowserClient, type InvalidationChannel } from '../../src/client/BrowserClient.ts';
import { BrowserResearchQueue } from '../../src/client/BrowserResearchQueue.tsx';
import { RESEARCH_PENDING_KEY } from '../../src/client/ResearchPending.ts';

const id = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const selection: QualifiedResearchSelection = { discoveryCandidateId: id, discoveryRevision: 2, candidateId: other, candidateRevision: 3, runId: id };
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });
const proof = qualifiedResearchFirmSchema.parse({ selection, promotionId: other, source: { provider: 'first_party', release: 'fixture', recordId: 'record-one' }, firmName: 'Synthetic research Firm',
  website: 'https://example.test', locality: 'Boston', region: 'MA', policyVersion: 'native-firm-eligibility-v1', evidenceFingerprint: 'a'.repeat(64), validUntil: '2026-10-23T00:00:00.000Z',
  citations: ['firm_identity', 'service_area', 'residential_management'].map(kind => ({ kind, observationId: id, blockId: kind, url: 'https://example.test/proof', contentHash: 'b'.repeat(64), retrievedAt: '2026-10-22T12:00:00.000Z', quote: `Current ${kind} source block` })),
  emailFit: 'eligible', channelAuthority: 'not_granted', maintenanceNeed: 'not_established', firmId: id, ownerUserId: id, nextStep: 'prepare_discovery_conversation', question: 'How do you currently coordinate maintenance?' });
const target = { ...selection, kind: 'qualified_research', firmId: id, promotionId: other, evidenceFingerprint: proof.evidenceFingerprint };
const action = { actionId: 'research:fixture', kind: 'research', subject: proof.firmName, reason: 'qualified_research_ready', dueAt: '2026-10-22T12:00:00.000Z', state: 'open', target };
function setup() {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
  let session = { status: 'signed_in', workspaceId: id, userId: id, deviceId: id, role: 'admin', revision: 'revision-one', csrfToken: 'c'.repeat(40), expiresAt: new Date(Date.now() + 60_000).toISOString() };
  let lose = false, failRead = false, created = false, refuse = false;
  const commands: unknown[] = [], opens: unknown[] = [];
  let broadcast: (() => void) | undefined;
  const channel: InvalidationChannel = { postMessage: vi.fn(), addEventListener: (_type, listener) => { broadcast = listener; }, removeEventListener: () => {}, close: () => {} };
  const send = vi.fn<typeof fetch>(async (url, init) => {
    if (url === '/browser/session') return json(session);
    if (refuse) return json({}, 401);
    if (url === '/browser/api/today/actions/v4') return json({ version: 4, workspaceId: id, businessTimeZone: 'America/New_York', asOf: '2026-10-22T12:00:00.000Z', actions: [...(created ? [action] : []), { actionId: 'legacy', kind: 'reply', subject: 'Legacy action', reason: 'reply', dueAt: '2026-10-22T12:00:00.000Z', state: 'open', target: { kind: 'reply', firmId: id, messageId: id } }], promiseCoverage: { scope: 'current_authorized_work', truncated: false, nextAfterId: null } });
    if (String(url).startsWith('/browser/api/today?')) return json({ workspaceId: id, snapshotDate: '2026-10-22', businessTimeZone: 'America/New_York', cards: [] });
    if (url === '/browser/api/sourcing/research-firms/list') {
      const { firmId: _firmId, ownerUserId: _owner, nextStep: _step, question: _question, ...candidate } = proof;
      return json({ candidates: [candidate], nextAfterId: null });
    }
    if (url === '/browser/api/sourcing/research-firms/create') {
      const body: unknown = JSON.parse(String(init?.body));
      expect(storage.getItem(RESEARCH_PENDING_KEY)).not.toBeNull();
      commands.push(body); created = true;
      if (lose) throw new Error('Committed response lost');
      return json({ status: 'accepted', replayed: commands.length > 1, result: proof });
    }
    if (url === '/browser/api/sourcing/research-firms/read') { if (failRead) throw new Error('Read unavailable'); return json(proof); }
    if (url === '/browser/api/today/actions/open/v4') { opens.push(JSON.parse(String(init?.body))); return json({ version: 4, target, research: proof, automaticResearch: null }); }
    throw new Error('Unexpected route');
  });
  const randomUUID = vi.fn(() => id);
  const client = new BrowserClient({ fetch: send, storage, channel, navigate: vi.fn(), randomUUID });
  return { client, storage, commands, opens, send, randomUUID, lose: (value = true) => { lose = value; }, failRead: () => { failRead = true; },
    refuse: () => { refuse = true; }, change: (value: Partial<typeof session>) => { session = { ...session, ...value }; }, broadcast: () => { broadcast?.(); } };
}
afterEach(() => { cleanup(); vi.useRealTimers(); });
async function createFromList(): Promise<void> {
  const disclosure = screen.getByText('Qualified selection and existing research requests').closest('details')!;
  if (!disclosure.open) fireEvent.click(within(disclosure).getByText('Qualified selection and existing research requests'));
  const load = await screen.findByRole('button', { name: 'Load research candidates' });
  await waitFor(() => { expect(load.hasAttribute('disabled')).toBe(false); });
  fireEvent.click(load);
  fireEvent.click(await screen.findByRole('button', { name: 'Create research Firm' }));
}

describe('qualified research actual BrowserClient composition', () => {
  it('composes secondary research creation, IDs-only durable custody and exact action current proof', async () => {
    const scope = setup();
    render(<BrowserApp client={scope.client} />);
    const navigation = await screen.findByRole('navigation', { name: 'Workspace sections' });
    fireEvent.click(within(navigation).getByRole('button', { name: 'Prospects' }));
    fireEvent.click(screen.getByText('Qualified selection and existing research requests'));
    await createFromList();
    await screen.findByText(/Research Firm confirmed/u);
    expect(scope.commands).toEqual([{ ...selection, commandId: id }]);
    const held = JSON.parse(scope.storage.getItem(RESEARCH_PENDING_KEY) ?? 'null') as Record<string, unknown>;
    expect(held).toEqual({ identity: JSON.stringify([id, id, id, 'admin', 'revision-one']), commandId: id, selection, expiresAt: scope.client.current?.status === 'signed_in' ? scope.client.current.expiresAt : '', createdFirmId: id });
    expect(JSON.stringify(held)).not.toMatch(/Synthetic|quote|citation|https|csrf|email|question/u);
    fireEvent.click(screen.getByRole('button', { name: '← Back to prepared research' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review current research' }));
    await screen.findByText('Current firm_identity source block');
    expect(scope.opens).toEqual([{ actionId: action.actionId, target }]);
    expect(within(screen.getByRole('region', { name: 'Current research proof' })).getAllByText(/Retrieved 2026-10-22T12:00/u)).toHaveLength(3);
    expect(screen.getByText(/Discovery preparation question/u)).toBeTruthy();
    expect(scope.randomUUID).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/This action is unsupported in this browser/u)).toBeNull();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_001);
    await act(async () => { expect(scope.client.isCurrent(scope.client.epoch)).toBe(false); });
    expect(screen.queryByText('Current firm_identity source block')).toBeNull();
    expect(scope.storage.getItem(RESEARCH_PENDING_KEY)).toBeNull();
    clock.mockRestore();
    await act(async () => { scope.client.dispose(); });
  });
  it('reload retains uncertainty, never replays, then explicit retry uses identical UUID and payload', async () => {
    const scope = setup(); scope.lose();
    await scope.client.refresh();
    const first = render(<BrowserResearchQueue client={scope.client} />);
    await createFromList();
    await screen.findByRole('button', { name: 'Retry exact research command' });
    first.unmount();
    render(<BrowserResearchQueue client={scope.client} />);
    await screen.findByText(/Unresolved research request/u);
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Retry exact research command' }).hasAttribute('disabled')).toBe(false); });
    expect(scope.commands).toHaveLength(1);
    scope.lose(false);
    fireEvent.click(screen.getByRole('button', { name: 'Retry exact research command' }));
    await screen.findByText(/Research Firm confirmed/u);
    expect(scope.commands).toHaveLength(2); expect(scope.commands[1]).toEqual(scope.commands[0]);
    expect(scope.randomUUID).toHaveBeenCalledTimes(1);
    await act(async () => { scope.client.dispose(); });
  });
  it('current read failure retains confirmed canonical ID without a new command', async () => {
    const scope = setup(); scope.failRead(); await scope.client.refresh();
    render(<BrowserResearchQueue client={scope.client} />);
    await createFromList();
    await screen.findByText(/failed read does not prove creation absent/u);
    expect(scope.client.pendingResearch()?.createdFirmId).toBe(id);
    expect(screen.queryByRole('button', { name: 'Retry exact research command' })).toBeNull();
    expect(scope.randomUUID).toHaveBeenCalledTimes(1);
    await act(async () => { scope.client.dispose(); });
  });
  it('timer expiry clears mounted pending UI and custody without dispatch', async () => {
    vi.useFakeTimers();
    const scope = setup(); await scope.client.refresh(); scope.client.prepareResearch(selection);
    render(<BrowserResearchQueue client={scope.client} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_001); });
    expect(scope.client.current).toBeNull(); expect(scope.storage.getItem(RESEARCH_PENDING_KEY)).toBeNull();
    expect(screen.queryByText(/Unresolved research request/u)).toBeNull();
    expect(scope.commands).toHaveLength(0);
    await act(async () => { scope.client.dispose(); });
  });
  it.each(['revision', 'role', 'userId', 'deviceId', 'workspaceId'] as const)('refuses pending dispatch after %s change', async field => {
    const scope = setup(); await scope.client.refresh();
    const held = scope.client.prepareResearch(selection);
    scope.change({ [field]: field === 'role' ? 'salesperson' : field === 'revision' ? 'revision-two' : other });
    await expect(scope.client.request('/sourcing/research-firms/create', z.unknown(), { ...held.selection, commandId: held.commandId }, () => { scope.client.retainResearch(held); })).rejects.toMatchObject({ reason: 'session_changed' });
    expect(scope.storage.getItem(RESEARCH_PENDING_KEY)).toBeNull(); expect(scope.commands).toHaveLength(0);
    await act(async () => { scope.client.dispose(); });
  });
  it.each(['200', '401', 'network'] as const)('late %s cannot publish or disturb a replacement session', async outcome => {
    const scope = setup(); await scope.client.refresh();
    const session = scope.client.current;
    const held = scope.client.prepareResearch(selection);
    let release!: (value: Response) => void;
    let reject!: (error: Error) => void;
    const delayed = new Promise<Response>((resolve, refuse) => { release = resolve; reject = refuse; });
    scope.send.mockImplementation(async url => url === '/browser/session' ? json(session) : await delayed);
    const work = scope.client.request('/sourcing/research-firms/create', z.unknown(), { ...selection, commandId: held.commandId }, () => { scope.client.retainResearch(held); });
    const refused = expect(work).rejects.toMatchObject({ reason: 'session_changed' });
    await vi.waitFor(() => { expect(scope.send.mock.calls.some(([url]) => url === '/browser/api/sourcing/research-firms/create')).toBe(true); });
    scope.client.invalidate(false); await scope.client.refresh();
    const replacementEpoch = scope.client.epoch;
    if (outcome === 'network') reject(new Error('late network failure')); else release(json({ status: 'accepted', replayed: false, result: proof }, Number(outcome)));
    await refused;
    expect(scope.client.epoch).toBe(replacementEpoch); expect(scope.client.current).toEqual(session);
    expect(scope.storage.getItem(RESEARCH_PENDING_KEY)).toBeNull();
    scope.client.dispose();
  });
  it('refuses changed payload and unavailable durable storage before dispatch', async () => {
    const scope = setup(); await scope.client.refresh();
    const held = scope.client.prepareResearch(selection);
    expect(() => scope.client.prepareResearch({ ...selection, candidateRevision: 4 })).toThrow();
    expect(scope.client.prepareResearch(selection)).toEqual(held); expect(scope.randomUUID).toHaveBeenCalledTimes(1);
    scope.client.invalidate(false); await scope.client.refresh();
    vi.spyOn(scope.storage, 'setItem').mockImplementation(() => { throw new Error('Storage disabled'); });
    expect(() => scope.client.prepareResearch(selection)).toThrow('storage_unavailable');
    expect(scope.commands).toHaveLength(0); scope.client.dispose();
  });
  it('expiry discovered after idle refuses before even session-refresh dispatch', async () => {
    const scope = setup(); await scope.client.refresh(); const held = scope.client.prepareResearch(selection);
    const calls = scope.send.mock.calls.length;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_001);
    await expect(scope.client.request('/sourcing/research-firms/create', z.unknown(), { ...selection, commandId: held.commandId })).rejects.toMatchObject({ reason: 'session_changed' });
    expect(scope.send).toHaveBeenCalledTimes(calls); expect(scope.storage.getItem(RESEARCH_PENDING_KEY)).toBeNull();
    clock.mockRestore(); scope.client.dispose();
  });
  it('cross-tab invalidation and authentication refusal erase pending custody', async () => {
    const scope = setup(); await scope.client.refresh(); scope.client.prepareResearch(selection); scope.broadcast();
    expect(scope.storage.getItem(RESEARCH_PENDING_KEY)).toBeNull();
    await scope.client.refresh(); scope.client.prepareResearch(selection); scope.refuse();
    await expect(scope.client.request('/sourcing/research-firms/read', z.unknown(), { firmId: id })).rejects.toMatchObject({ reason: 'refused' });
    expect(scope.storage.getItem(RESEARCH_PENDING_KEY)).toBeNull();
    await act(async () => { scope.client.dispose(); });
  });
});
