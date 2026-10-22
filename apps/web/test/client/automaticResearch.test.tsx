// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { automaticResearchFirmSchema, qualifiedResearchFirmSchema } from '@fss/contracts';
import { BrowserClient } from '../../src/client/BrowserClient.ts';
import { BrowserResearchQueue } from '../../src/client/BrowserResearchQueue.tsx';

const id = '10000000-0000-4000-8000-000000000001';
const other = '10000000-0000-4000-8000-000000000002';
const now = '2026-10-22T12:00:00.000Z';
const target = { kind: 'automatic_research', publicationId: id, publicationRevision: 3, firmId: other, candidateId: id, candidateRevision: 2, runId: other, evidenceFingerprint: 'a'.repeat(64) } as const;
const proof = automaticResearchFirmSchema.parse({ target, source: { kind: 'search_hit', attemptId: other, sourceUrl: 'https://example.test/source' }, ownerUserId: id, firmName: 'Automatic fixture Firm', website: 'https://example.test/', locality: 'Dallas', region: 'TX', policyVersion: 'automatic-research-v1', nativePolicyVersion: 'native-firm-eligibility-v1', checkedAt: now, validUntil: '2026-10-23T00:00:00.000Z',
  citations: ['firm_identity', 'service_area', 'residential_management'].map(kind => ({ kind, observationId: id, blockId: kind, url: `https://example.test/${kind}`, contentHash: 'b'.repeat(64), retrievedAt: now, quote: `Retained ${kind} passage` })), emailFit: 'eligible', channelAuthority: 'not_granted', maintenanceNeed: 'not_established', nextStep: 'prepare_discovery_conversation', question: 'What should we learn before discovery?' });
const action = { actionId: `automatic-research:${id}`, kind: 'research', subject: proof.firmName, reason: 'automatic_research_ready', dueAt: now, state: 'open', target };
const selection = { discoveryCandidateId: id, discoveryRevision: 1, candidateId: other, candidateRevision: 2, runId: id };
const manual = qualifiedResearchFirmSchema.parse({ selection, promotionId: id, source: { provider: 'first_party', release: 'fixture', recordId: 'manual' }, firmName: 'Manual fixture Firm', website: proof.website, locality: 'Dallas', region: 'TX', policyVersion: 'native-firm-eligibility-v1', evidenceFingerprint: 'c'.repeat(64), validUntil: proof.validUntil, citations: proof.citations, emailFit: 'eligible', channelAuthority: 'not_granted', maintenanceNeed: 'not_established', firmId: other, ownerUserId: id, nextStep: proof.nextStep, question: proof.question });
const manualTarget = { ...selection, kind: 'qualified_research', firmId: other, promotionId: id, evidenceFingerprint: manual.evidenceFingerprint };
const manualAction = { ...action, actionId: 'manual:fixture', subject: manual.firmName, reason: 'qualified_research_ready', target: manualTarget };
const legacy = { actionId: 'legacy', kind: 'reply', subject: 'Legacy reply', reason: 'reply', dueAt: now, state: 'open', target: { kind: 'reply', firmId: id, messageId: id } };
const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status });
function deferred() {
  let resolve!: (response: Response) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<Response>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup() {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  let session = { status: 'signed_in', workspaceId: id, userId: id, deviceId: id, role: 'admin', revision: 'one', csrfToken: 'c'.repeat(40), expiresAt: new Date(Date.now() + 120_000).toISOString() };
  let openResponse: unknown = { version: 4, target, research: null, automaticResearch: proof };
  let queueWait: ReturnType<typeof deferred> | undefined;
  let openWait: ReturnType<typeof deferred> | undefined;
  const opens: unknown[] = [], commands: unknown[] = [];
  let refused = false;
  const send = vi.fn<typeof fetch>(async (url, init) => {
    if (url === '/browser/session') return json(session);
    if (refused) return json({}, 401);
    if (url === '/browser/api/sourcing/research-firms/list') {
      const { firmId: _firmId, ownerUserId: _owner, nextStep: _next, question: _question, ...candidate } = manual;
      return json({ candidates: [candidate], nextAfterId: null });
    }
    if (url === '/browser/api/sourcing/research-firms/create') { commands.push(JSON.parse(String(init?.body))); return json({ status: 'accepted', replayed: false, result: manual }); }
    if (url === '/browser/api/sourcing/research-firms/read') return json(manual);
    if (url === '/browser/api/today/actions/v4') return queueWait === undefined ? json({ version: 4, workspaceId: id, businessTimeZone: 'America/Chicago', asOf: now, actions: [action, manualAction, legacy], promiseCoverage: { scope: 'current_authorized_work', truncated: false, nextAfterId: null } }) : await queueWait.promise;
    if (url === '/browser/api/today/actions/open/v4') {
      const body = JSON.parse(String(init?.body)) as { actionId: string };
      opens.push(body);
      if (body.actionId === manualAction.actionId) return json({ version: 4, target: manualTarget, research: manual, automaticResearch: null });
      return openWait === undefined ? json(openResponse) : await openWait.promise;
    }
    throw new Error(`Unexpected route ${String(url)}`);
  });
  const randomUUID = vi.fn(() => id);
  const client = new BrowserClient({ fetch: send, storage, navigate: vi.fn(), randomUUID });
  return { client, send, values, randomUUID, opens, commands, refuse: () => { refused = true; }, change: (value: Partial<typeof session>) => { session = { ...session, ...value }; }, answer: (value: unknown) => { openResponse = value; }, delayOpen: () => { openWait = deferred(); return openWait; }, delayQueue: () => { queueWait = deferred(); return queueWait; } };
}
async function ready(): Promise<void> {
  await waitFor(() => { expect(screen.getByRole('button', { name: 'Refresh action queue' }).hasAttribute('disabled')).toBe(false); });
}
function openAutomatic(): void { fireEvent.click(screen.getAllByRole('button', { name: 'Review current research' })[0]!); }
afterEach(cleanup);

describe('automatic research actual BrowserClient and queue', () => {
  it('reads and opens exact V4 proof, preserves manual/legacy controls and reloads without mutation', async () => {
    const scope = setup(); await scope.client.refresh();
    const first = render(<BrowserResearchQueue client={scope.client} />);
    await screen.findByText(proof.firmName); await ready(); openAutomatic();
    const section = await screen.findByRole('region', { name: 'Current automatic research proof' });
    expect(scope.opens).toEqual([{ actionId: action.actionId, target }]);
    for (const text of [`Publication ${id} revision 3`, `Candidate ${id} revision 2 · Run ${other}`, `Evidence fingerprint ${target.evidenceFingerprint}`]) expect(within(section).getByText(text)).toBeTruthy();
    expect(within(section).getByText(/Source search_hit · Attempt/u)).toBeTruthy();
    expect(within(section).getByText(/Email fit: eligible, not channel permission/u)).toBeTruthy();
    expect(within(section).getAllByText(/Retrieved/u)).toHaveLength(3);
    expect(within(section).getByRole('link', { name: proof.citations[0]!.url }).getAttribute('href')).toBe(proof.citations[0]!.url);
    expect(screen.getByText(/This action is unsupported/u)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Load research candidates' })).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Review current research' })[1]!);
    await screen.findByRole('region', { name: 'Current research proof' });
    expect(scope.opens[1]).toEqual({ actionId: manualAction.actionId, target: manualTarget });
    first.unmount(); render(<BrowserResearchQueue client={scope.client} />);
    await screen.findByText(proof.firmName); await ready();
    expect(screen.queryByRole('region', { name: 'Current automatic research proof' })).toBeNull();
    openAutomatic(); await screen.findByRole('region', { name: 'Current automatic research proof' });
    expect(scope.randomUUID).not.toHaveBeenCalled(); expect(scope.values.size).toBe(0);
    expect(scope.send.mock.calls.every(([url]) => ['/browser/session', '/browser/api/today/actions/v4', '/browser/api/today/actions/open/v4'].includes(String(url)))).toBe(true);
    await act(async () => { scope.client.dispose(); });
  });
  it.each(['null', 'publication', 'revision', 'candidate', 'run', 'fingerprint', 'proof-target', 'mixed'] as const)('refuses %s current-proof mismatch with no fallback', async mismatch => {
    const scope = setup();
    const changed = { ...target, ...(mismatch === 'publication' ? { publicationId: other } : mismatch === 'revision' ? { publicationRevision: 4 } : mismatch === 'candidate' ? { candidateRevision: 3 } : mismatch === 'run' ? { runId: id } : { evidenceFingerprint: 'f'.repeat(64) }) };
    scope.answer(mismatch === 'null' ? { version: 4, target: null, research: null, automaticResearch: null } : { version: 4, target: mismatch === 'proof-target' || mismatch === 'mixed' ? target : changed, research: mismatch === 'mixed' ? manual : null, automaticResearch: mismatch === 'proof-target' ? { ...proof, target: changed } : proof });
    await scope.client.refresh(); render(<BrowserResearchQueue client={scope.client} />);
    await screen.findByText(proof.firmName); await ready(); openAutomatic();
    await screen.findByRole('status');
    expect(screen.queryByRole('region', { name: 'Current automatic research proof' })).toBeNull();
    expect(scope.opens).toHaveLength(1); expect(scope.randomUUID).not.toHaveBeenCalled();
    await act(async () => { scope.client.dispose(); });
  });
  it.each(['200', '401', 'network'] as const)('late %s cannot publish or unlock a new epoch operation', async outcome => {
    const scope = setup(); await scope.client.refresh(); render(<BrowserResearchQueue client={scope.client} />);
    await screen.findByText(proof.firmName); await ready();
    const old = scope.delayOpen(); openAutomatic();
    await waitFor(() => { expect(scope.opens).toHaveLength(1); });
    await act(async () => { scope.client.invalidate(false); scope.change({ userId: other, revision: 'two' }); await scope.client.refresh(); });
    expect(screen.queryByText(proof.firmName)).toBeNull();
    const newer = scope.delayQueue(); fireEvent.click(screen.getByRole('button', { name: 'Refresh action queue' }));
    await waitFor(() => { expect(scope.send.mock.calls.filter(([url]) => url === '/browser/api/today/actions/v4')).toHaveLength(2); });
    await act(async () => { if (outcome === 'network') old.reject(new Error('Late failure')); else old.resolve(json({ version: 4, target, research: null, automaticResearch: proof }, Number(outcome))); });
    expect(screen.getByRole('button', { name: 'Refresh action queue' }).hasAttribute('disabled')).toBe(true);
    expect(screen.queryByRole('region', { name: 'Current automatic research proof' })).toBeNull();
    expect(scope.client.current?.status).toBe('signed_in'); expect(scope.client.epoch).toBe(1);
    await act(async () => { newer.resolve(json({ version: 4, workspaceId: id, businessTimeZone: 'America/Chicago', asOf: now, actions: [], promiseCoverage: { scope: 'current_authorized_work', truncated: false, nextAfterId: null } })); });
    await screen.findByText('No current actions.'); await ready();
    await act(async () => { scope.client.dispose(); });
  });
  it('retains the existing manual create command and current read under the additive queue', async () => {
    const scope = setup(); await scope.client.refresh(); render(<BrowserResearchQueue client={scope.client} />);
    await screen.findByText(proof.firmName); await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Load research candidates' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Create research Firm' }));
    await screen.findByText(/Research Firm confirmed/u);
    expect(scope.commands).toEqual([{ ...selection, commandId: id }]);
    expect(scope.client.pendingResearch()?.createdFirmId).toBe(manual.firmId);
    expect(scope.randomUUID).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Read current research Firm' })).toBeTruthy();
    await act(async () => { scope.client.dispose(); });
  });
  it.each(['logout', '401'] as const)('%s clears mounted automatic proof and queue', async reason => {
    const scope = setup(); await scope.client.refresh(); render(<BrowserResearchQueue client={scope.client} />);
    await screen.findByText(proof.firmName); await ready(); openAutomatic(); await screen.findByRole('region', { name: 'Current automatic research proof' });
    if (reason === 'logout') await act(async () => { await scope.client.signOut().catch(() => {}); });
    else { scope.refuse(); fireEvent.click(screen.getByRole('button', { name: 'Refresh action queue' })); await waitFor(() => { expect(scope.client.current).toBeNull(); }); }
    expect(screen.queryByText(proof.firmName)).toBeNull();
    expect(screen.queryByRole('region', { name: 'Current automatic research proof' })).toBeNull();
    expect(scope.values.size).toBe(0);
    await act(async () => { scope.client.dispose(); });
  });
  it('revocation clears visible proof, queue and private projections immediately', async () => {
    const scope = setup(); await scope.client.refresh(); render(<BrowserResearchQueue client={scope.client} />);
    await screen.findByText(proof.firmName); await ready(); openAutomatic(); await screen.findByRole('region', { name: 'Current automatic research proof' });
    scope.change({ role: 'salesperson' });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh action queue' }));
    await waitFor(() => { expect(scope.client.current).toBeNull(); });
    expect(screen.queryByText(proof.firmName)).toBeNull(); expect(screen.queryByRole('region', { name: 'Current automatic research proof' })).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    await act(async () => { scope.client.dispose(); });
  });
});
