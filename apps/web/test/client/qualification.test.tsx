// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { qualificationViewSchema } from '@fss/contracts';
import { BrowserClient } from '../../src/client/BrowserClient.ts';
import { BrowserQualification, QualificationEvidenceLink } from '../../src/client/BrowserQualification.tsx';
import { BrowserQualificationRecovery } from '../../src/client/BrowserQualificationRecovery.tsx';
import { QUALIFICATION_PENDING_KEY, canReviewQualification } from '../../src/client/QualificationPending.ts';

const id = '10000000-0000-4000-8000-000000000001', runId = '10000000-0000-4000-8000-000000000002';
const firmId = '10000000-0000-4000-8000-000000000003', other = '10000000-0000-4000-8000-000000000004';
const date = '2026-10-23T12:00:00.000Z';
const view = qualificationViewSchema.parse({ candidateId: id, runId, candidateRevision: 7, status: 'review', reason: null, admissionReason: null,
  requestedAt: date, deadlineAt: date, observations: [{ id: runId, url: 'https://example.test/evidence', contentHash: 'a'.repeat(64), relevantTextHash: 'b'.repeat(64), retrievedAt: date, publishedAt: null, publishedAtBlockId: null, firstParty: true, truncated: false, blocks: [{ id: 'identity', text: 'Synthetic residential management Firm' }] }],
  facts: [{ kind: 'firm_identity', value: 'Synthetic residential management Firm', observationId: runId, blockId: 'identity' }],
  verdict: { decision: 'review', rank: 'fit_only', reasons: [], evidenceIds: [runId], unknowns: ['maintenance_need_unconfirmed'], policyVersion: 'fixture' }, openingQuestion: null, admission: null, history: [] });
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });
function deferred() { let resolve!: (response: Response) => void, reject!: (error: Error) => void; const promise = new Promise<Response>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function setup() {
  const data = new Map<string, string>();
  const storage = { getItem: vi.fn((key: string) => data.get(key) ?? null), setItem: vi.fn((key: string, value: string) => { data.set(key, value); }), removeItem: vi.fn((key: string) => { data.delete(key); }) };
  let session = { status: 'signed_in', workspaceId: id, userId: id, deviceId: id, role: 'admin', revision: 'revision-one', csrfToken: 'c'.repeat(40), expiresAt: new Date(Date.now() + 120_000).toISOString() };
  let answer: unknown = view, lose = false, status = 200;
  let delayedRead: ReturnType<typeof deferred> | undefined, delayedSession: ReturnType<typeof deferred> | undefined;
  let result: unknown;
  const commands: { path: string; body: unknown }[] = [], reads: unknown[] = [];
  const send = vi.fn<typeof fetch>(async (url, init) => {
    if (url === '/browser/session') return delayedSession === undefined ? json(session) : await delayedSession.promise;
    expect(init?.headers).toMatchObject({ 'x-callie-session': session.revision, 'x-callie-csrf': session.csrfToken });
    if (url === '/browser/api/sourcing/qualification/read') { reads.push(JSON.parse(String(init?.body))); return delayedRead === undefined ? json(answer) : await delayedRead.promise; }
    expect(['/browser/api/sourcing/qualification/request', '/browser/api/sourcing/qualification/admit']).toContain(url);
    expect(storage.getItem(QUALIFICATION_PENDING_KEY)).not.toBeNull();
    commands.push({ path: String(url), body: JSON.parse(String(init?.body)) });
    if (lose) throw new Error('Response lost');
    return json(result ?? { status: 'accepted', replayed: commands.length > 1, result: String(url).endsWith('/request') ? { runId } : { firmId, routeId: other, alreadyAdmitted: false } }, status);
  });
  const randomUUID = vi.fn(() => crypto.randomUUID());
  const makeClient = () => new BrowserClient({ storage, fetch: send, randomUUID, navigate: vi.fn() });
  const client = makeClient();
  return { client, makeClient, storage, commands, reads, send, randomUUID,
    answer: (value: unknown) => { answer = value; }, lose: (value = true) => { lose = value; },
    response: (value: unknown, code = 200) => { result = value; status = code; },
    change: (value: Partial<typeof session>) => { session = { ...session, ...value }; },
    delayRead: () => { delayedRead = deferred(); return delayedRead; },
    delaySession: () => { delayedSession = deferred(); return { ...delayedSession, session }; } };
}
function panel(client: BrowserClient) { return <><BrowserQualificationRecovery client={client} /><BrowserQualification client={client} candidateId={id} expectedRevision={7} /></>; }
async function read(): Promise<void> { fireEvent.click(screen.getByRole('button', { name: 'Read qualification' })); await screen.findByText(/Latest run/u); }
async function idle(): Promise<void> { await waitFor(() => { expect(screen.getByRole('button', { name: 'Read qualification' }).hasAttribute('disabled')).toBe(false); }); }
afterEach(cleanup);

describe('bounded browser qualification', () => {
  it('explicitly reads exact raw envelope and shows dated evidence, unknowns and safe links without storage or polling', async () => {
    const s = setup(); await s.client.refresh(); render(panel(s.client)); expect(s.reads).toHaveLength(0); expect(s.commands).toHaveLength(0);
    await read(); await idle(); expect(s.reads).toEqual([{ candidateId: id }]);
    expect(screen.getByText('Unknown maintenance_need_unconfirmed')).toBeTruthy(); expect(screen.getByText(/Synthetic residential management Firm/u)).toBeTruthy();
    const link = screen.getByRole('link'); expect(link.getAttribute('rel')).toBe('noopener noreferrer'); expect(link.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(s.storage.setItem).not.toHaveBeenCalled(); expect(s.randomUUID).not.toHaveBeenCalled(); await act(async () => { s.client.dispose(); });
  });
  it.each(['business_phone_unresolved', 'target_geography_unsupported', 'identity_unresolved', 'evidence_needs_refresh', 'invalid_evidence'])('does not offer admission for %s', async unknown => {
    const s = setup(); s.answer({ ...view, verdict: { ...view.verdict, unknowns: ['maintenance_need_unconfirmed', unknown] } }); await s.client.refresh(); render(panel(s.client)); await read();
    expect(screen.queryByRole('button', { name: 'Admit reviewed qualification' })).toBeNull(); expect(s.commands).toHaveLength(0); await act(async () => { s.client.dispose(); });
  });
  it('freshly revalidates exact latest run before reviewed admission and displays exact Firm', async () => {
    const s = setup(); await s.client.refresh(); render(panel(s.client)); await read(); await idle();
    fireEvent.click(screen.getByRole('button', { name: 'Admit reviewed qualification' })); await screen.findByText(/Admission recorded for exact Firm/u);
    expect(s.reads).toHaveLength(2); expect(s.commands).toEqual([{ path: '/browser/api/sourcing/qualification/admit', body: { candidateId: id, expectedRevision: 7, qualificationRunId: runId, mode: 'reviewed', commandId: expect.any(String) } }]);
    expect(screen.getByText(new RegExp(`Admitted exact Firm ${firmId}`, 'u'))).toBeTruthy();
    const retained = s.storage.getItem(QUALIFICATION_PENDING_KEY)!; expect(retained).not.toMatch(/Synthetic|https|csrf|quote|evidence|residential/u); await act(async () => { s.client.dispose(); });
  });
  it.each(['run', 'revision', 'candidate', 'unknown', 'evidence'])('rejects changed %s after reviewed-admission wait without minting', async change => {
    const s = setup(); await s.client.refresh(); render(panel(s.client)); await read(); await idle();
    s.answer(change === 'run' ? { ...view, runId: other } : change === 'revision' ? { ...view, candidateRevision: 8 } : change === 'candidate' ? { ...view, candidateId: other } : change === 'unknown' ? { ...view, verdict: { ...view.verdict, unknowns: ['business_phone_unresolved'] } } : { ...view, openingQuestion: 'Changed evidence interpretation' });
    fireEvent.click(screen.getByRole('button', { name: 'Admit reviewed qualification' })); await screen.findByText(/Qualification unavailable or refused/u);
    expect(screen.queryByText(/Synthetic residential management Firm/u)).toBeNull(); expect(screen.queryByRole('link')).toBeNull(); expect(screen.queryByRole('button', { name: 'Admit reviewed qualification' })).toBeNull();
    expect(s.commands).toHaveLength(0); expect(s.randomUUID).not.toHaveBeenCalled(); await act(async () => { s.client.dispose(); });
  });
  it.each(['network', '503', 'malformed'])('clears reviewed private evidence before %s freshness wait and leaves it cleared on failure', async failure => {
    const s = setup(); await s.client.refresh(); render(panel(s.client)); await read(); await idle();
    const delayed = s.delayRead(); fireEvent.click(screen.getByRole('button', { name: 'Admit reviewed qualification' }));
    expect(screen.queryByText(/Synthetic residential management Firm/u)).toBeNull(); expect(screen.queryByRole('link')).toBeNull(); expect(screen.queryByRole('button', { name: 'Admit reviewed qualification' })).toBeNull();
    await waitFor(() => { expect(s.reads).toHaveLength(2); });
    await act(async () => { if (failure === 'network') delayed.reject(new Error('Unavailable')); else delayed.resolve(json({}, failure === '503' ? 503 : 200)); });
    await screen.findByText(/Qualification unavailable or refused/u);
    expect(screen.queryByText(/Synthetic residential management Firm/u)).toBeNull(); expect(screen.queryByRole('link')).toBeNull(); expect(screen.queryByRole('button', { name: 'Admit reviewed qualification' })).toBeNull();
    expect(s.commands).toHaveLength(0); expect(s.randomUUID).not.toHaveBeenCalled(); await act(async () => { s.client.dispose(); });
  });
  it.each(['request', 'admit'] as const)('retains lost %s response across actual client reload and explicitly reconciles same UUID/payload only', async kind => {
    const s = setup(); s.lose(); await s.client.refresh(); const first = render(panel(s.client));
    if (kind === 'admit') { await read(); await idle(); }
    fireEvent.click(screen.getByRole('button', { name: kind === 'request' ? 'Request qualification' : 'Admit reviewed qualification' }));
    await screen.findByText(/Qualification unavailable or refused/u); expect(s.commands).toHaveLength(1); const retained = s.storage.getItem(QUALIFICATION_PENDING_KEY);
    first.unmount(); const reloaded = s.makeClient(); await reloaded.refresh(); render(panel(reloaded));
    expect(s.storage.getItem(QUALIFICATION_PENDING_KEY)).toBe(retained); expect(s.commands).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Request qualification' }).hasAttribute('disabled')).toBe(true);
    expect(() => reloaded.qualification.prepare({ kind: 'request', candidateId: other, expectedRevision: 1 })).toThrow();
    s.lose(false); fireEvent.click(screen.getByRole('button', { name: 'Reconcile exact qualification command' }));
    await waitFor(() => { expect(screen.queryByRole('button', { name: 'Reconcile exact qualification command' })).toBeNull(); });
    expect(s.commands).toHaveLength(2); expect(s.commands[1]).toEqual(s.commands[0]); expect(s.randomUUID).toHaveBeenCalledTimes(1);
    await act(async () => { reloaded.dispose(); s.client.dispose(); });
  });
  it('fails closed on custody write/read failure without dispatch or replacement UUID', async () => {
    const s = setup(); await s.client.refresh(); render(panel(s.client)); s.storage.setItem.mockImplementation(() => { throw new Error('Quota'); });
    fireEvent.click(screen.getByRole('button', { name: 'Request qualification' })); await screen.findByText(/Qualification unavailable or refused/u); expect(s.commands).toHaveLength(0);
    s.storage.getItem.mockImplementation(() => { throw new Error('Storage refused'); });
    expect(() => s.client.qualification.prepare({ kind: 'request', candidateId: id, expectedRevision: 7 })).toThrow(); expect(s.randomUUID).toHaveBeenCalledTimes(1); await act(async () => { s.client.dispose(); });
  });
  it('keeps malformed response uncertain but accepts only definitive refused envelope', async () => {
    const s = setup(); s.response({ status: 'accepted', result: { runId } }); await s.client.refresh(); render(panel(s.client));
    fireEvent.click(screen.getByRole('button', { name: 'Request qualification' })); await screen.findByText(/Qualification unavailable or refused/u);
    expect(s.client.qualification.read()?.receipt).toBeUndefined();
    s.response({ status: 'refused', replayed: true, reason: 'candidate_changed' }); fireEvent.click(screen.getByRole('button', { name: 'Reconcile exact qualification command' }));
    await screen.findByText(/Command definitively refused/u); expect(s.client.qualification.read()?.receipt).toEqual({ kind: 'refused' }); expect(s.randomUUID).toHaveBeenCalledTimes(1); await act(async () => { s.client.dispose(); });
  });
  it('fences delayed read after candidate replacement and logout', async () => {
    const s = setup(); await s.client.refresh(); const component = render(<BrowserQualification client={s.client} candidateId={id} expectedRevision={7} />);
    const delayed = s.delayRead(); fireEvent.click(screen.getByRole('button', { name: 'Read qualification' })); await waitFor(() => { expect(s.reads).toHaveLength(1); });
    component.rerender(<BrowserQualification client={s.client} candidateId={other} expectedRevision={8} />);
    await idle();
    await act(async () => { delayed.resolve(json(view)); }); expect(screen.queryByText(/Synthetic residential/u)).toBeNull();
    await act(async () => { s.client.invalidate(); }); expect(screen.queryByText(/Latest run/u)).toBeNull(); expect(s.storage.getItem(QUALIFICATION_PENDING_KEY)).toBeNull();
  });
  it('resets recovery busy on client replacement and fences the old pending response', async () => {
    const first = setup(), second = setup(); await first.client.refresh(); await second.client.refresh();
    first.client.qualification.prepare({ kind: 'request', candidateId: id, expectedRevision: 7 });
    second.client.qualification.prepare({ kind: 'request', candidateId: other, expectedRevision: 8 });
    const delayed = first.delaySession(); const component = render(<BrowserQualificationRecovery client={first.client} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reconcile exact qualification command' }));
    expect(screen.getByRole('button', { name: 'Reconcile exact qualification command' }).hasAttribute('disabled')).toBe(true);
    component.rerender(<BrowserQualificationRecovery client={second.client} />);
    expect(screen.getByRole('button', { name: 'Reconcile exact qualification command' }).hasAttribute('disabled')).toBe(false);
    await act(async () => { delayed.resolve(json(delayed.session)); });
    expect(first.commands).toHaveLength(0); expect(second.commands).toHaveLength(0);
    expect(second.client.qualification.read()?.receipt).toBeUndefined();
    await act(async () => { first.client.dispose(); second.client.dispose(); });
  });
  it('fences predispatch session change and clears retained unknown custody', async () => {
    const s = setup(); await s.client.refresh(); render(panel(s.client)); const delayed = s.delaySession();
    fireEvent.click(screen.getByRole('button', { name: 'Request qualification' })); await waitFor(() => { expect(s.client.qualification.read()).not.toBeNull(); });
    await act(async () => { delayed.resolve(json({ ...delayed.session, revision: 'replaced', role: 'sales' })); });
    expect(s.commands).toHaveLength(0); expect(s.storage.getItem(QUALIFICATION_PENDING_KEY)).toBeNull(); expect(s.client.current).toBeNull();
  });
  it.each(['role', 'revision', 'expiry', 'auth'] as const)('clears durable custody on %s invalidation', async mode => {
    const s = setup(); await s.client.refresh(); s.client.qualification.prepare({ kind: 'request', candidateId: id, expectedRevision: 7 });
    if (mode === 'expiry') { const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_001); expect(s.client.isCurrent(s.client.epoch)).toBe(false); clock.mockRestore(); }
    else if (mode === 'auth') s.client.invalidate();
    else { s.change(mode === 'role' ? { role: 'sales' } : { revision: 'new' }); await expect(s.client.refresh()).rejects.toThrow(); }
    expect(s.storage.getItem(QUALIFICATION_PENDING_KEY)).toBeNull(); s.client.dispose();
  });
  it('has no unsafe evidence navigation and policy accepts only native reviewable unknowns', () => {
    const component = render(<QualificationEvidenceLink url="javascript:alert(1)" />); expect(screen.queryByRole('link')).toBeNull();
    component.rerender(<QualificationEvidenceLink url="https://user:secret@example.test/" />); expect(screen.queryByRole('link')).toBeNull();
    expect(canReviewQualification(view, id, 7)).toBe(true); expect(canReviewQualification(view, id, 8)).toBe(false);
  });
});
