// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BrowserApp } from '../../src/client/BrowserApp.tsx';
import { BrowserClient, PENDING_KEY } from '../../src/client/BrowserClient.ts';

const id = '00000000-0000-4000-8000-000000000001';
const session = { status: 'signed_in', workspaceId: id, userId: id, deviceId: id, role: 'admin', revision: 'revision-one', csrfToken: 'c'.repeat(40), expiresAt: '2026-10-23T00:00:00.000Z' };
const firm = { id, name: 'Synthetic Alpha Firm', website: null, locality: null, regionCode: null, status: 'active', assignedUserId: id, stageKey: null, opportunityStatus: null, controlMode: null, openedAt: null, timeZone: null, timeZoneUnresolvedReason: null, addressLine: null, postalCode: null, countryCode: 'US', timeZoneConfidence: null, timeZoneSource: null, contacts: [{ id, fullName: 'Fixture Person', title: 'Owner', status: 'active', isPrimary: true }], phoneRoutes: [], emailRoutes: [], aliases: [] };
const notes = { meetingId: id, revision: 0, debrief: '', speakerMappings: [], itemOverrides: [], sufficient: false, savedAt: null };
const outcomes = { meetingId: id, firmId: id, notes, analysisId: null, sourceHash: 'a'.repeat(64), state: 'empty', attendance: 'unconfirmed', overview: '', items: [], tasks: [], holds: [] };
const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 });
function setup() {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
  const commands: unknown[] = [];
  let loseResponse = false;
  const send = vi.fn<typeof fetch>(async (url, init) => {
    if (url === '/browser/session') return json(session);
    if (url === '/browser/sign-out') return json({ status: 'signed_out', csrfToken: 'a'.repeat(40) });
    if (String(url).startsWith('/browser/api/today')) return json({ workspaceId: id, snapshotDate: '2026-10-22', businessTimeZone: 'America/New_York', cards: [{ firmId: id, firmName: firm.name, lane: 'new_firm', dueAt: '2026-10-22T00:00:00.000Z', counts: { replies: 0, emailsDue: 0, callsDue: 0 } }] });
    if (url === '/browser/api/crm/firm-page-v3') return json({ version: 3, visibility: 'assigned_or_admin', read: { visibility: 'assigned_or_admin', firm }, opportunities: [], holds: [], followUpPermissions: [] });
    if (String(url).startsWith('/browser/api/meetings/outcomes')) return json(outcomes);
    if (url === '/browser/api/meetings/notes') {
      const command = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(storage.getItem(PENDING_KEY)).not.toBeNull();
      commands.push(command);
      if (loseResponse) throw new Error('lost');
      return json({ status: 'accepted', replayed: commands.length > 1, result: { ...notes, revision: 1, debrief: command['debrief'], sufficient: command['sufficient'], savedAt: '2026-10-22T01:00:00.000Z' } });
    }
    throw new Error('Unexpected route');
  });
  const client = new BrowserClient({ fetch: send, storage, navigate: vi.fn(), randomUUID: () => id });
  return { client, storage, commands, lose: () => { loseResponse = true; }, recover: () => { loseResponse = false; } };
}
afterEach(cleanup);
async function openNotes(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: 'Open firm' }));
  await screen.findByText('Fixture Person · Owner');
  fireEvent.change(screen.getByLabelText('Meeting ID'), { target: { value: id } });
  fireEvent.click(screen.getByRole('button', { name: 'Read meeting notes' }));
  await screen.findByLabelText('Your notes');
}

describe('BrowserApp real shared presentation', () => {
  it('shows Today, existing Firm and actual notes receipt, then clears all private views on logout', async () => {
    const { client, storage } = setup();
    render(<BrowserApp client={client} />);
    await openNotes();
    fireEvent.change(screen.getByLabelText('Your notes'), { target: { value: 'Fixture debrief' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save notes' }));
    await screen.findByText('Saved notes revision 1.');
    expect(storage.getItem(PENDING_KEY)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByRole('heading', { name: 'Sign in' });
    expect(screen.queryByText(firm.name)).toBeNull();
    expect(screen.queryByLabelText('Your notes')).toBeNull();
    expect(screen.getByText(/OFF \/ unavailable/u)).toBeTruthy();
  });
  it('locks an uncertain draft, reloads without replay, explicitly retries same command identity', async () => {
    const scope = setup();
    const rendered = render(<BrowserApp client={scope.client} />);
    await openNotes();
    fireEvent.change(screen.getByLabelText('Your notes'), { target: { value: 'Retained exact debrief' } });
    scope.lose();
    fireEvent.click(screen.getByRole('button', { name: 'Save notes' }));
    await screen.findByRole('button', { name: 'Retry save' });
    expect(scope.commands).toHaveLength(1);
    rendered.unmount();
    render(<BrowserApp client={scope.client} />);
    await openNotes();
    expect(scope.commands).toHaveLength(1);
    expect((screen.getByLabelText('Your notes') as HTMLTextAreaElement).value).toBe('Retained exact debrief');
    scope.recover();
    fireEvent.click(screen.getByRole('button', { name: 'Retry save' }));
    await screen.findByText('Saved notes revision 1 (existing receipt).');
    expect(scope.commands).toHaveLength(2);
    expect(scope.commands[0]).toEqual(scope.commands[1]);
  });
  it('clears mounted notes on manager invalidation without repopulation', async () => {
    const { client } = setup();
    render(<BrowserApp client={client} />);
    await openNotes();
    await act(async () => { client.invalidate(false); });
    await waitFor(() => { expect(screen.queryByLabelText('Your notes')).toBeNull(); });
    expect(screen.queryByText(firm.name)).toBeNull();
  });
});
