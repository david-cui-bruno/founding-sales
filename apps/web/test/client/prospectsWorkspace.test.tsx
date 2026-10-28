// @vitest-environment jsdom
import '../../src/client/schemaRuntime.ts';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { automaticResearchFirmSchema, manualProspectSchema, qualifiedResearchFirmSchema } from '@fss/contracts';
import { BrowserClient } from '../../src/client/BrowserClient.ts';
import { BrowserProspectsWorkspace } from '../../src/client/BrowserProspectsWorkspace.tsx';
import { BrowserResearchQueue } from '../../src/client/BrowserResearchQueue.tsx';
import { AutomaticResearchProof } from '../../src/client/AutomaticResearchProof.tsx';

const id = '10000000-0000-4000-8000-000000000001';
const other = '10000000-0000-4000-8000-000000000002';
const at = '2026-10-25T12:00:00.000Z';
const target = { kind: 'automatic_research', publicationId: id, publicationRevision: 2, firmId: other, candidateId: id, candidateRevision: 3, runId: other, evidenceFingerprint: 'a'.repeat(64) } as const;
const proof = automaticResearchFirmSchema.parse({ target, source: { kind: 'search_hit', attemptId: other, sourceUrl: 'https://example.test/source' }, ownerUserId: id,
  firmName: 'Prepared synthetic Firm', website: 'https://example.test/', locality: 'Dallas', region: 'TX', policyVersion: 'automatic-research-v1', nativePolicyVersion: 'native-firm-eligibility-v1', checkedAt: at, validUntil: '2026-10-27T00:00:00.000Z',
  citations: ['firm_identity', 'service_area', 'residential_management'].map(kind => ({ kind, observationId: id, blockId: kind, url: `https://example.test/${kind}`, contentHash: 'b'.repeat(64), retrievedAt: at, quote: `Synthetic retained ${kind} passage` })),
  emailFit: 'eligible', channelAuthority: 'not_granted', maintenanceNeed: 'not_established', nextStep: 'prepare_discovery_conversation', question: 'How is maintenance coordinated?' });
const action = { actionId: `automatic-research:${id}`, kind: 'research', subject: proof.firmName, reason: 'automatic_research_ready', dueAt: at, state: 'open', target };
const legacy = { actionId: 'legacy', kind: 'reply', subject: 'Unrelated reply', reason: 'reply', dueAt: at, state: 'open', target: { kind: 'reply', firmId: id, messageId: id } };
const selection = { discoveryCandidateId: id, discoveryRevision: 1, candidateId: other, candidateRevision: 2, runId: id };
const qualified = qualifiedResearchFirmSchema.parse({ selection, promotionId: id, source: { provider: 'first_party', release: 'synthetic', recordId: 'record' }, firmName: 'Qualified synthetic Firm', website: proof.website, locality: 'Dallas', region: 'TX', policyVersion: 'native-firm-eligibility-v1', evidenceFingerprint: 'c'.repeat(64), validUntil: proof.validUntil, citations: proof.citations, emailFit: 'eligible', channelAuthority: 'not_granted', maintenanceNeed: 'not_established', firmId: other, ownerUserId: id, nextStep: proof.nextStep, question: proof.question });
const raw = manualProspectSchema.parse({ candidateId: id, revision: 4, observedName: 'Raw retained observation', website: null, locality: null, region: null, observedPhone: null, phoneBasis: 'unknown', sources: [{ label: 'Exact retained source', url: 'https://example.test/observed', observedAt: at }], sourceNotices: [{ label: 'Retained license', url: null }], retainedAt: at, state: 'new', unknowns: ['Identity unknown'], possibleDuplicateCount: 0, qualification: 'unverified', contactAuthority: 'not_granted' });
const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status });
function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>(yes => { resolve = yes; });
  return { promise, resolve };
}
const queue = (actions: unknown[] = [action, legacy]) => ({ version: 4, workspaceId: id, businessTimeZone: 'America/Chicago', asOf: at, actions, promiseCoverage: { scope: 'current_authorized_work', truncated: false, nextAfterId: null } });
function setup(kind: 'automatic' | 'qualified' = 'automatic') {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: vi.fn((key: string, value: string) => { values.set(key, value); }), removeItem: (key: string) => { values.delete(key); } };
  const session = { status: 'signed_in', workspaceId: id, userId: id, deviceId: id, role: 'admin', revision: 'one', csrfToken: 'c'.repeat(40), expiresAt: new Date(Date.now() + 120_000).toISOString() };
  const qualifiedTarget = { ...selection, kind: 'qualified_research', firmId: qualified.firmId, promotionId: qualified.promotionId, evidenceFingerprint: qualified.evidenceFingerprint };
  let response: unknown = kind === 'automatic' ? queue() : queue([{ ...action, subject: qualified.firmName, reason: 'qualified_research_ready', target: qualifiedTarget }]), failQueue = false, lost = false;
  let rows = [raw];
  let delayed: ReturnType<typeof deferred> | undefined;
  const requests: Array<{ url: string; body: unknown }> = [];
  const send = vi.fn<typeof fetch>(async (url, init) => {
    if (url === '/browser/session') return json(session);
    const body: unknown = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    requests.push({ url: String(url), body });
    if (url === '/browser/api/today/actions/v4?include=callingPreparation') { if (failQueue) throw Error('Read failed'); return json(response); }
    if (url === '/browser/api/today/actions/open/v4') return delayed ? await delayed.promise : json(kind === 'automatic' ? { version: 4, target, research: null, automaticResearch: proof } : { version: 4, target: qualifiedTarget, research: qualified, automaticResearch: null });
    if (url === '/browser/api/sourcing/candidates/prospects/list') return json({ prospects: rows, hasMore: body !== null && typeof body === 'object' && 'offset' in body && body.offset === 0 });
    if (url === '/browser/api/sourcing/candidates/prospects/feedback') {
      if (lost) throw Error('Lost feedback response');
      return json({ status: 'accepted', replayed: false, result: { candidateId: id, revision: raw.revision, state: 'kept' } });
    }
    if (url === '/browser/api/sourcing/research-firms/list') {
      const { firmId: _firm, ownerUserId: _owner, nextStep: _next, question: _question, ...candidate } = qualified;
      const more = body !== null && typeof body === 'object' && 'afterId' in body;
      return json({ candidates: more ? [] : [candidate], nextAfterId: more ? null : other });
    }
    throw Error(`Unexpected route ${String(url)}`);
  });
  const randomUUID = vi.fn(() => crypto.randomUUID());
  const client = new BrowserClient({ fetch: send, storage, navigate: vi.fn(), randomUUID });
  return { client, send, requests, storage, randomUUID, session, values, rows: (value: typeof rows) => { rows = value; }, fail: () => { failQueue = true; }, empty: () => { response = queue([legacy]); }, lose: () => { lost = true; }, delay: () => { delayed = deferred(); return delayed; } };
}
async function ready(): Promise<void> {
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh action queue' }).hasAttribute('disabled')).toBe(false));
}
beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(Date.parse(at)); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('prepared Prospects workspace, pure mounted composition', () => {
  it('reads prepared supply first without raw fetches, mutations, fake refill or callable claims', async () => {
    const s = setup(); await s.client.refresh(); render(<BrowserProspectsWorkspace client={s.client} />);
    await screen.findByText(proof.firmName); await ready();
    expect(screen.getByText('1 source-backed research items in this read · Not a callable count.')).toBeTruthy();
    expect(screen.queryByText(legacy.subject)).toBeNull();
    expect(screen.queryByRole('button', { name: /pause|refill|start calling/iu })).toBeNull();
    expect(screen.getByText('Qualified selection and existing research requests').closest('details')?.open).toBe(false);
    expect(s.requests).toEqual([{ url: '/browser/api/today/actions/v4?include=callingPreparation', body: undefined }]);
    expect(s.randomUUID).not.toHaveBeenCalled(); expect(s.storage.setItem).not.toHaveBeenCalled();
    await act(async () => { s.client.dispose(); });
  });
  it('opens exact source proof, focuses its heading, discloses lineage and returns to list without another request', async () => {
    const s = setup(); await s.client.refresh(); render(<BrowserProspectsWorkspace client={s.client} />); await ready();
    fireEvent.click(await screen.findByRole('button', { name: 'Review current research' }));
    const detail = await screen.findByRole('region', { name: 'Current automatic research proof' });
    expect(document.activeElement).toBe(within(detail).getByRole('heading', { name: proof.firmName }));
    const disclosure = within(detail).getByText('Source passages and exact research lineage').closest('details')!;
    expect(disclosure.open).toBe(false); fireEvent.click(within(detail).getByText('Source passages and exact research lineage'));
    expect(within(detail).getByRole('link', { name: proof.citations[0]!.url }).getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(within(detail).getByText(`Publication ${id} revision 2`)).toBeTruthy();
    expect(s.requests[1]).toEqual({ url: '/browser/api/today/actions/open/v4', body: { actionId: action.actionId, target } });
    const count = s.requests.length;
    fireEvent.click(screen.getByRole('button', { name: '← Back to prepared research' }));
    expect(screen.queryByRole('region', { name: 'Current automatic research proof' })).toBeNull();
    expect(screen.getByText(proof.firmName)).toBeTruthy(); expect(s.requests).toHaveLength(count);
    await act(async () => { s.client.dispose(); });
  });
  it('distinguishes failed refresh from a genuinely empty prepared selection', async () => {
    const s = setup(); await s.client.refresh(); render(<BrowserProspectsWorkspace client={s.client} />); await ready();
    s.fail(); fireEvent.click(screen.getByRole('button', { name: 'Refresh action queue' }));
    await screen.findByText(/This is not an empty result/u);
    expect(screen.queryByText(proof.firmName)).toBeNull(); expect(screen.queryByText(/No prepared research returned/u)).toBeNull();
    await act(async () => { s.client.dispose(); });
  });
  it('does not confuse unrelated Today actions or raw supply with prepared research', async () => {
    const s = setup(); s.empty(); await s.client.refresh(); render(<BrowserProspectsWorkspace client={s.client} />); await ready();
    expect(screen.getByText(/No prepared research returned/u)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retained review' })).toBeTruthy(); expect(s.requests).toHaveLength(1);
    await act(async () => { s.client.dispose(); });
  });
  it('keeps qualified selection and keyset pagination deliberate and source-specific', async () => {
    const s = setup(); await s.client.refresh(); render(<BrowserProspectsWorkspace client={s.client} />); await ready();
    fireEvent.click(screen.getByText('Qualified selection and existing research requests'));
    fireEvent.click(screen.getByRole('button', { name: 'Load research candidates' }));
    await screen.findByText(qualified.firmName);
    fireEvent.click(screen.getByText('Exact source context')); expect(screen.getByText('Source first_party · Release synthetic · Record record')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'More research candidates' }));
    await waitFor(() => expect(s.requests.filter(r => r.url.endsWith('/research-firms/list'))).toHaveLength(2));
    expect(s.requests.at(-1)?.body).toEqual({ afterId: other });
    expect(s.randomUUID).not.toHaveBeenCalled();
    await act(async () => { s.client.dispose(); });
  });
  it('retained review preserves unknown phones, exact feedback, pagination and UNKNOWN across navigation', async () => {
    const s = setup(); await s.client.refresh(); render(<BrowserProspectsWorkspace client={s.client} />); await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Retained review' }));
    await screen.findByRole('heading', { name: raw.observedName });
    expect(screen.getAllByText('Phone unknown · not extracted').length).toBeGreaterThan(0);
    expect(screen.getByText(/These are observations, not unique or callable Firms/u)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next prospect page' }));
    await waitFor(() => expect(s.requests.at(-1)?.body).toEqual({ state: 'all', offset: 50 }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Keep' }).hasAttribute('disabled')).toBe(false));
    s.lose(); fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    await screen.findByRole('button', { name: 'Reconcile same manual feedback' });
    const held = s.client.manualProspects.read(); expect(held?.payload).toMatchObject({ candidateId: id, expectedRevision: 4, state: 'kept' });
    fireEvent.click(screen.getByRole('button', { name: 'Prepared research' })); await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Retained review' }));
    await screen.findByRole('button', { name: 'Reconcile same manual feedback' });
    expect(s.requests.filter(r => r.url.endsWith('/feedback'))).toHaveLength(1); expect(s.client.manualProspects.read()).toEqual(held); expect(s.randomUUID).toHaveBeenCalledTimes(1);
    await act(async () => { s.client.dispose(); });
  });
  it('narrow retained row selection and Back preserve keyboard focus and exact identity', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const s = setup(); await s.client.refresh(); render(<BrowserProspectsWorkspace client={s.client} />); await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Retained review' })); await screen.findByRole('table');
    fireEvent.click(within(screen.getByRole('table')).getByRole('button'));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { name: raw.observedName })));
    fireEvent.click(screen.getByRole('button', { name: '← Back to retained review' }));
    await waitFor(() => expect(document.activeElement).toBe(within(screen.getByRole('table')).getByRole('button')));
    await act(async () => { s.client.dispose(); });
  });
  it.each(['navigate', 'invalidate'] as const)('late source proof cannot repopulate after %s', async kind => {
    const s = setup(); await s.client.refresh(); render(<BrowserProspectsWorkspace client={s.client} />); await ready();
    const late = s.delay(); fireEvent.click(await screen.findByRole('button', { name: 'Review current research' }));
    await waitFor(() => expect(s.requests.some(r => r.url.endsWith('/open/v4'))).toBe(true));
    if (kind === 'navigate') fireEvent.click(screen.getByRole('button', { name: 'Retained review' }));
    else await act(async () => { s.client.invalidate(false); });
    await act(async () => { late.resolve(json({ version: 4, target, research: null, automaticResearch: proof })); });
    expect(screen.queryByRole('region', { name: 'Current automatic research proof' })).toBeNull();
    if (kind === 'navigate') expect(screen.getByRole('heading', { name: raw.observedName })).toBeTruthy();
    else expect(screen.getByText(/Sign in to read/u)).toBeTruthy();
    await act(async () => { s.client.dispose(); });
  });
  it('unmount during pre-dispatch refresh prevents the abandoned read', async () => {
    const s = setup(); await s.client.refresh();
    const late = deferred(); s.send.mockImplementation(async () => await late.promise);
    const view = render(<BrowserResearchQueue client={s.client} />); view.unmount();
    await act(async () => { late.resolve(json(s.session)); });
    expect(s.send.mock.calls.filter(([url]) => url !== '/browser/session')).toHaveLength(0);
    s.client.dispose();
  });
  it('StrictMode abandoned operation cannot unlock or publish a replacement operation', async () => {
    const s = setup(); await s.client.refresh(); render(<StrictMode><BrowserProspectsWorkspace client={s.client} /></StrictMode>);
    await screen.findByText(proof.firmName); await ready();
    expect(s.requests).toEqual([{ url: '/browser/api/today/actions/v4?include=callingPreparation', body: undefined }]);
    await act(async () => { s.client.dispose(); });
  });
  it.each(['javascript:alert(1)', 'https://user:password@example.test/', 'not a URL'])('does not turn unsafe retained reference %s into an executable link', url => {
    render(<AutomaticResearchProof proof={{ ...proof, website: url, source: { ...proof.source, sourceUrl: url }, citations: proof.citations.map(citation => ({ ...citation, url })) }} />);
    fireEvent.click(screen.getByText('Source passages and exact research lineage'));
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });
});

describe('Prospects to Calling exact navigation composition', () => {
  it('expired prepared proof cannot open a brief even while the session remains current', async () => {
    const s = setup(), open = vi.fn(); s.session.expiresAt = '2026-10-29T00:00:00.000Z';
    await s.client.refresh(); render(<BrowserProspectsWorkspace client={s.client} onOpenCalling={open} />); await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Review current research' }));
    const button = await screen.findByRole('button', { name: 'Open calling brief' });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-27T01:00:00.000Z'));
    try { fireEvent.click(button); expect(open).not.toHaveBeenCalled(); expect(s.client.current?.status).toBe('signed_in'); }
    finally { clock.mockRestore(); await act(async () => { s.client.dispose(); }); }
  });
  it.each(['automatic', 'qualified'] as const)('%s opened proof passes only its explicit canonical Firm ID without requests or writes', async kind => {
    const s = setup(kind), open = vi.fn(); await s.client.refresh(); render(<BrowserProspectsWorkspace client={s.client} onOpenCalling={open} />); await ready();
    expect(screen.queryByRole('button', { name: 'Open calling brief' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Review current research' }));
    const button = await screen.findByRole('button', { name: 'Open calling brief' });
    const requests = s.requests.length; fireEvent.click(button);
    expect(open).toHaveBeenCalledExactlyOnceWith({ kind: 'firm', firmId: kind === 'automatic' ? proof.target.firmId : qualified.firmId });
    expect(s.requests).toHaveLength(requests); expect(s.randomUUID).not.toHaveBeenCalled(); expect(s.storage.setItem).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /start phone|dial|call now/iu })).toBeNull();
    await act(async () => { s.client.dispose(); });
  });
  it.each(['back', 'destination', 'epoch', 'unmount'] as const)('same-turn %s revokes an old prepared-brief action before callback', async transition => {
    const s = setup(), open = vi.fn(); await s.client.refresh(); const view = render(<BrowserProspectsWorkspace client={s.client} onOpenCalling={open} />); await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Review current research' }));
    const stale = await screen.findByRole('button', { name: 'Open calling brief' });
    act(() => {
      if (transition === 'back') fireEvent.click(screen.getByRole('button', { name: '← Back to prepared research' }));
      else if (transition === 'destination') fireEvent.click(screen.getByRole('button', { name: 'Retained review' }));
      else if (transition === 'epoch') s.client.invalidate(false);
      else view.unmount();
      fireEvent.click(stale);
    });
    expect(open).not.toHaveBeenCalled(); await act(async () => { s.client.dispose(); });
  });
  it('returning to selection and starting a new read cannot reuse the previous proof action', async () => {
    const s = setup(), open = vi.fn(); await s.client.refresh(); render(<BrowserResearchQueue client={s.client} onOpenCalling={open} />); await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Review current research' }));
    const stale = await screen.findByRole('button', { name: 'Open calling brief' });
    fireEvent.click(screen.getByRole('button', { name: '← Back to prepared research' }));
    fireEvent.click(screen.getByText('Qualified selection and existing research requests'));
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'Load research candidates' })); fireEvent.click(stale); });
    expect(open).not.toHaveBeenCalled(); await act(async () => { s.client.dispose(); });
  });
  it('raw unknown-phone selection passes exact candidate and revision, never an invented Firm', async () => {
    const s = setup(), open = vi.fn(); await s.client.refresh(); render(<BrowserProspectsWorkspace client={s.client} onOpenCalling={open} />); await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Retained review' }));
    const button = await screen.findByRole('button', { name: 'Open calling brief' });
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
    const requests = s.requests.length; fireEvent.click(button);
    expect(open).toHaveBeenCalledExactlyOnceWith({ kind: 'candidate', candidateId: raw.candidateId, expectedCandidateRevision: raw.revision, prospectPage: { state: 'all', offset: 0 } });
    expect(s.requests).toHaveLength(requests); expect(s.randomUUID).not.toHaveBeenCalled(); expect(s.storage.setItem).not.toHaveBeenCalled();
    await act(async () => { s.client.dispose(); });
  });
  it.each(['selection', 'page', 'filter', 'refresh', 'destination', 'epoch'] as const)('same-turn raw %s refuses an old exact-record action', async transition => {
    const s = setup(), open = vi.fn(); s.rows([raw, { ...raw, candidateId: other, revision: 7 }]);
    await s.client.refresh(); render(<BrowserProspectsWorkspace client={s.client} onOpenCalling={open} />); await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Retained review' }));
    const stale = await screen.findByRole('button', { name: 'Open calling brief' });
    await waitFor(() => expect(stale.hasAttribute('disabled')).toBe(false));
    act(() => {
      if (transition === 'selection') fireEvent.click(screen.getByRole('button', { name: 'Next prospect' }));
      else if (transition === 'page') fireEvent.click(screen.getByRole('button', { name: 'Next prospect page' }));
      else if (transition === 'filter') fireEvent.change(screen.getByLabelText('Manual state'), { target: { value: 'kept' } });
      else if (transition === 'refresh') fireEvent.click(screen.getByRole('button', { name: 'Refresh retained worklist' }));
      else if (transition === 'destination') fireEvent.click(screen.getByRole('button', { name: 'Prepared research' }));
      else s.client.invalidate(false);
      fireEvent.click(stale);
    });
    expect(open).not.toHaveBeenCalled();
    if (transition === 'selection') {
      fireEvent.click(screen.getByRole('button', { name: 'Open calling brief' }));
      expect(open).toHaveBeenCalledExactlyOnceWith({ kind: 'candidate', candidateId: other, expectedCandidateRevision: 7, prospectPage: { state: 'all', offset: 0 } });
    }
    await act(async () => { s.client.dispose(); });
  });
});
