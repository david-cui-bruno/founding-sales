// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { BrowserClient } from '../../src/client/BrowserClient.ts';
import { BrowserMeetingPreparation } from '../../src/client/BrowserMeetingPreparation.tsx';

const firmId = '10000000-0000-4000-8000-000000000001';
const meetingId = '10000000-0000-4000-8000-000000000002';
const other = '10000000-0000-4000-8000-000000000003';
const at = '2026-10-22T12:00:00.000Z';
const meeting = { meetingId, startsAt: at, endsAt: at, state: 'booked' };
const item = (text: string, provenance = 'observed', sourceUrl: string | null = 'https://example.test/evidence') => ({ label: null, text, source: 'research_fact', provenance, sourceUrl, at });
const section = (...items: ReturnType<typeof item>[]) => ({ items, omitted: 0 });
const brief = () => ({ meetingId, firmId, meeting: { title: 'Synthetic meeting', attendeeName: 'Synthetic person', startsAt: at, endsAt: at, state: 'booked', locationType: null }, generatedAt: at, sections: { whyThisDemo: section(), firm: section(item('Company evidence')), conversations: section(item('Earlier interaction')), objections: section(item('Possible issue', 'unverified', 'javascript:alert(1)')), commitments: section(), workflow: section(), openQuestions: section(...[1, 2, 3, 4].map(n => item(`Question ${n}`, 'inferred'))), objective: section(item('Confirm useful next step', 'inferred')) } });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function deferred() { let resolve!: (value: Response) => void; const promise = new Promise<Response>(yes => { resolve = yes; }); return { promise, resolve }; }
function setup() {
  const storage = { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() };
  let answer: unknown = brief();
  let wait: ReturnType<typeof deferred> | undefined;
  let status = 200;
  const send = vi.fn<typeof fetch>(async url => {
    if (url === '/browser/session') return json({ status: 'signed_in', workspaceId: firmId, userId: firmId, deviceId: firmId, role: 'admin', revision: 'one', csrfToken: 'c'.repeat(40), expiresAt: new Date(Date.now() + 120_000).toISOString() });
    if (String(url).startsWith('/browser/api/meetings/firm?')) return json({ meetings: [meeting] });
    if (String(url).startsWith('/browser/api/meetings/brief?')) return wait ? await wait.promise : json(answer, status);
    throw new Error('Unexpected route');
  });
  const client = new BrowserClient({ fetch: send, storage, navigate: vi.fn(), randomUUID: vi.fn(() => other) });
  return { client, send, storage, answer: (value: unknown) => { answer = value; }, refuse: () => { status = 403; }, delay: () => { wait = deferred(); return wait; } };
}
async function open() {
  fireEvent.click(screen.getByRole('button', { name: 'Load existing meetings' }));
  const button = await screen.findByRole('button', { name: 'Open preparation' });
  await waitFor(() => { expect(button.hasAttribute('disabled')).toBe(false); });
  fireEvent.click(button);
}
afterEach(cleanup);
describe('read-only meeting preparation with actual BrowserClient', () => {
  it('explicitly opens exact v2 identity, bounded sourced sections and no storage or commands', async () => {
    const s = setup(); await s.client.refresh(); render(<BrowserMeetingPreparation client={s.client} firmId={firmId} />);
    expect(s.send).toHaveBeenCalledTimes(1);
    await open();
    const view = await screen.findByRole('article', { name: 'Current meeting brief' });
    expect(within(view).getByText('Synthetic meeting')).toBeTruthy();
    expect(within(view).getByText(/Synthetic person/u)).toBeTruthy();
    expect(within(view).getByText('Possible issue')).toBeTruthy();
    expect(within(view).getByText(/unverified · Source: research_fact/u)).toBeTruthy();
    expect(within(view).queryByText('Question 4')).toBeNull();
    expect(within(view).getAllByRole('link').every(link => link.getAttribute('href') === 'https://example.test/evidence')).toBe(true);
    expect(s.send.mock.calls.some(([url]) => url === `/browser/api/meetings/brief?meetingId=${meetingId}&version=2&include=meeting_tasks`)).toBe(true);
    expect(s.send.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
    expect(s.storage.setItem).not.toHaveBeenCalled();
    await act(async () => { s.client.dispose(); });
    expect(screen.queryByRole('article')).toBeNull();
  });
  it.each(['firm', 'meeting', 'refusal', 'empty'] as const)('handles %s without invented evidence', async mode => {
    const s = setup(); const value = brief();
    if (mode === 'firm') value.firmId = other;
    if (mode === 'meeting') value.meetingId = other;
    if (mode === 'empty') for (const key of Object.keys(value.sections) as (keyof typeof value.sections)[]) value.sections[key] = section();
    s.answer(value); if (mode === 'refusal') s.refuse();
    await s.client.refresh(); render(<BrowserMeetingPreparation client={s.client} firmId={firmId} />); await open();
    if (mode === 'empty') { await screen.findByRole('article'); expect(screen.getAllByText('Unknown: no available evidence.')).toHaveLength(5); }
    else { await waitFor(() => { expect(screen.getByRole('button', { name: 'Load existing meetings' }).hasAttribute('disabled')).toBe(mode === 'refusal'); }); expect(screen.queryByRole('article')).toBeNull(); }
    await act(async () => { s.client.dispose(); });
  });
  it('firm transition cancels late work without unlocking a newer request', async () => {
    const s = setup(); await s.client.refresh(); const ui = render(<BrowserMeetingPreparation client={s.client} firmId={firmId} />);
    const old = s.delay(); await open();
    ui.rerender(<BrowserMeetingPreparation client={s.client} firmId={other} />);
    const newer = s.delay(); await open();
    await act(async () => { old.resolve(json(brief())); });
    expect(screen.queryByRole('article')).toBeNull();
    expect(screen.getByRole('button', { name: 'Load existing meetings' }).hasAttribute('disabled')).toBe(true);
    await act(async () => { newer.resolve(json({ ...brief(), firmId: other })); });
    await screen.findByRole('article'); await act(async () => { s.client.dispose(); });
  });
  it('logout clears busy state and ignores late private responses', async () => {
    const s = setup(); await s.client.refresh(); render(<BrowserMeetingPreparation client={s.client} firmId={firmId} />);
    const held = s.delay(); await open();
    await act(async () => { s.client.invalidate(); held.resolve(json(brief())); });
    expect(screen.queryByRole('article')).toBeNull(); expect(screen.queryByRole('button', { name: 'Open preparation' })).toBeNull();
    await act(async () => { s.client.dispose(); });
  });
  it('does not dispatch an old firm read after a delayed session refresh', async () => {
    const s = setup(); await s.client.refresh(); const ui = render(<BrowserMeetingPreparation client={s.client} firmId={firmId} />);
    const held = deferred();
    const session = s.client.current;
    s.send.mockImplementationOnce(async () => await held.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Load existing meetings' }));
    ui.rerender(<BrowserMeetingPreparation client={s.client} firmId={other} />);
    await act(async () => { held.resolve(json(session)); });
    expect(s.send.mock.calls.some(([url]) => String(url).includes('/browser/api/'))).toBe(false);
    expect(screen.getByRole('button', { name: 'Load existing meetings' }).hasAttribute('disabled')).toBe(false);
    await act(async () => { s.client.dispose(); });
  });
  it.each(['javascript:alert(1)', 'data:text/html,private', 'https://name:password@example.test/', '//example.test/', 'not a url'])('does not link unsafe source %s', async source => {
    const s = setup(); const value = brief();
    value.sections.firm = section(item('Unlinked evidence', 'observed', source)); s.answer(value);
    await s.client.refresh(); render(<BrowserMeetingPreparation client={s.client} firmId={firmId} />); await open();
    await screen.findByRole('article');
    expect(within(screen.getByRole('region', { name: 'Company and person facts' })).queryByRole('link')).toBeNull();
    await act(async () => { s.client.dispose(); });
  });
});
