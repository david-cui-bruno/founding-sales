// @vitest-environment jsdom
import {priorityFixturePage} from './support/priorityFixture.ts';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { FirmIdentityDto } from '@fss/contracts';
import { BrowserClient } from '../../src/client/BrowserClient.ts';
import { CallingQueue } from '../../src/client/CallingQueue.tsx';
import { CallingRecordedFirms } from '../../src/client/CallingRecordedFirms.tsx';

const id = '00000000-0000-4000-8000-000000000001';
const firm: FirmIdentityDto = { id, name: 'Fictional recorded company', website: 'https://fictional.example.test', locality: 'Providence', regionCode: 'RI', status: 'active', assignedUserId: id, stageKey: null, opportunityStatus: null, controlMode: null, openedAt: null, timeZone: 'America/New_York', timeZoneUnresolvedReason: null };
const clients: BrowserClient[] = [];
async function fixture(role: 'admin' | 'salesperson' = 'admin') {
  let records: readonly FirmIdentityDto[] = [firm], pending: Promise<Response> | null = null, failed = false;
  const send = vi.fn<typeof fetch>(async url => {
    if (url === '/browser/session') return Response.json({ status: 'signed_in', workspaceId: id, userId: id, deviceId: id, role, revision: 'one', csrfToken: 'c'.repeat(40), expiresAt: new Date(Date.now() + 60000).toISOString() });
    if (url === '/browser/api/firms?include=callingPreparation') return pending ?? Response.json(failed ? { invalid: 'not a company list' } : { firms: records });
    if (url === '/browser/api/sourcing/candidates/prospects/priority/list') return Response.json(priorityFixturePage({ prospects: [], hasMore: false }));
    if (url === '/browser/api/today/actions/v4') return Response.json({ version: 4, workspaceId: id, businessTimeZone: 'America/New_York', asOf: new Date().toISOString(), actions: [], promiseCoverage: { scope: 'current_authorized_work', truncated: false, nextAfterId: null } });
    throw Error('Unexpected effect or acquisition');
  });
  const client = new BrowserClient({ fetch: send, storage: localStorage, navigate: vi.fn(), randomUUID: () => id });
  clients.push(client); await client.refresh();
  return { client, send, fail: (value: boolean) => { failed = value; }, records: (value: readonly FirmIdentityDto[]) => { records = value; }, hold: () => {
    let finish!: (response: Response) => void;
    pending = new Promise<Response>(resolve => { finish = resolve; }); return finish;
  } };
}
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.dispose()); localStorage.clear(); });

it('offers recorded companies without Today cards and selects only the explicit existing Firm', async () => {
  const f = await fixture(), selected = vi.fn();
  render(<CallingQueue client={f.client} disabled={false} onSelect={selected} />);
  await screen.findByText(/No kept prospects/u);
  expect(f.send.mock.calls.some(([url]) => url === '/browser/api/firms?include=callingPreparation')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Recorded companies' }));
  fireEvent.click(await screen.findByRole('button', { name: /Fictional recorded company/u }));
  expect(selected).toHaveBeenCalledExactlyOnceWith({ subject: { kind: 'firm', firmId: id }, label: firm.name });
  expect(f.send.mock.calls.filter(([url]) => url === '/browser/api/firms?include=callingPreparation')).toHaveLength(1);
  expect(f.send.mock.calls.every(([url, init]) => String(url).includes('/session') || String(url)==='/browser/api/firms?include=callingPreparation' && init?.method === 'GET' || String(url).endsWith('/prospects/priority/list'))).toBe(true);
  expect(localStorage.length).toBe(0);
});
it('filters the bounded returned identities locally without a new request or inferred association', async () => {
  const f = await fixture(), selected = vi.fn();
  f.records(Array.from({ length: 200 }, (_, index) => ({ ...firm, id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, name: `Fictional company ${index}` })));
  render(<CallingRecordedFirms client={f.client} disabled={false} onSelect={selected} />);
  await screen.findByText(/first 200 recorded companies/u);
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Fictional company 199' } });
  expect(screen.getByRole('button', { name: /Fictional company 199/u })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Fictional company 0 /u })).toBeNull();
  expect(f.send.mock.calls.filter(([url]) => url === '/browser/api/firms?include=callingPreparation')).toHaveLength(1);
  expect(selected).not.toHaveBeenCalled();
});
it('keeps recorded company lookup available to a salesperson without raw-prospect administration', async () => {
  const f = await fixture('salesperson');
  render(<CallingQueue client={f.client} disabled={false} onSelect={vi.fn()} />);
  await screen.findByText(/No prepared conversations/u);
  expect(screen.getByRole('button', { name: 'Kept prospects' }).hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Recorded companies' }));
  expect(await screen.findByRole('button', { name: /Fictional recorded company/u })).toBeTruthy();
});
it('refreshes removed identities instead of keeping stale selectable rows', async () => {
  const f = await fixture(); render(<CallingRecordedFirms client={f.client} disabled={false} onSelect={vi.fn()} />);
  await screen.findByRole('button', { name: /Fictional recorded company/u });
  f.records([]); fireEvent.click(screen.getByRole('button', { name: 'Refresh recorded companies' }));
  await screen.findByText(/No matching recorded companies/u);
  expect(screen.queryByRole('button', { name: /Fictional recorded company/u })).toBeNull();
});
it('erases identities and refuses a delayed response after authentication loss', async () => {
  const f = await fixture(), finish = f.hold(), selected = vi.fn();
  render(<CallingRecordedFirms client={f.client} disabled={false} onSelect={selected} />);
  await waitFor(() => expect(f.send.mock.calls.some(([url]) => url === '/browser/api/firms?include=callingPreparation')).toBe(true));
  await act(async () => { f.client.invalidate(); finish(Response.json({ firms: [firm] })); });
  expect(screen.queryByText(firm.name)).toBeNull(); expect(selected).not.toHaveBeenCalled();
});
it('cannot resurrect a recorded list after returning to kept prospects', async () => {
  const f = await fixture(), finish = f.hold();
  render(<CallingQueue client={f.client} disabled={false} onSelect={vi.fn()} />);
  await screen.findByText(/No kept prospects/u);
  fireEvent.click(screen.getByRole('button', { name: 'Recorded companies' }));
  await waitFor(() => expect(f.send.mock.calls.some(([url]) => url === '/browser/api/firms?include=callingPreparation')).toBe(true));
  fireEvent.click(screen.getByRole('button', { name: 'Kept prospects' }));
  await act(async () => { finish(Response.json({ firms: [firm] })); });
  await screen.findByText(/No kept prospects/u); expect(screen.queryByText(firm.name)).toBeNull();
});
it('keeps a failed read distinct from an empty list and respects disabled selection', async () => {
  const f = await fixture(); f.fail(true);
  const view = render(<CallingRecordedFirms client={f.client} disabled={false} onSelect={vi.fn()} />);
  await screen.findByText(/Recorded companies are unavailable/u); expect(screen.queryByText(/No matching/u)).toBeNull();
  view.unmount(); f.fail(false);
  const selected = vi.fn(); render(<CallingRecordedFirms client={f.client} disabled onSelect={selected} />);
  const button = await screen.findByRole('button', { name: /Fictional recorded company/u });
  fireEvent.click(button); expect(button.hasAttribute('disabled')).toBe(true); expect(selected).not.toHaveBeenCalled();
});
