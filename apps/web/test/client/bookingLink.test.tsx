// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { BrowserClient } from '../../src/client/BrowserClient.ts';
import { BrowserSettings } from '../../src/client/BrowserSettings.tsx';

const id = '00000000-0000-4000-8000-000000000001';
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });
const clients: BrowserClient[] = [];
function setup(role: 'admin' | 'salesperson', stored: string | null = null, refuse = false) {
  const session = { status: 'signed_in', workspaceId: id, userId: id, deviceId: id, role, revision: 'one', csrfToken: 'c'.repeat(40), expiresAt: new Date(Date.now() + 60000).toISOString() };
  const commands: Record<string, unknown>[] = [];
  const send = vi.fn<typeof fetch>(async (url, init) => {
    if (url === '/browser/session') return json(session);
    if (url === '/browser/api/calling/setup') return json({ callingProvider: { provider: 'tel', version: 0 }, telephonyBudget: { dailyCeilingCents: 0, maxMinutesPerCall: 30, unitPriceMicros: 14000, version: 0 }, spentTodayCents: 0, configured: false });
    if (url === '/browser/api/calling-identities') return json({ identities: [] });
    if (url === '/browser/api/settings/booking-link/read') return json({ settingKey: 'booking_link', current: { value: { url: stored }, version: stored === null ? 0 : 1 }, versions: [] });
    if (url === '/browser/api/settings/booking-link/update') {
      commands.push(JSON.parse(String(init?.body)));
      return json(refuse ? { status: 'refused', replayed: false, reason: 'invalid_value' } : { status: 'accepted', replayed: false, result: {} });
    }
    throw new Error(`Unexpected route ${String(url)}`);
  });
  const browser = new BrowserClient({ fetch: send, storage: sessionStorage, navigate: vi.fn(), randomUUID: () => id });
  clients.push(browser);
  return { browser, commands, send };
}
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.dispose(); sessionStorage.clear(); });
const show = async (browser: BrowserClient): Promise<void> => {
  await browser.refresh();
  render(<BrowserSettings client={browser} theme="light" onTheme={() => {}} onRefresh={() => {}} busy={false} />);
};

describe('the Settings booking link', () => {
  it('shows the saved link to an admin, saves a new one and clears it, with a fresh command each time', async () => {
    const scope = setup('admin', 'https://cal.example.test/old');
    await show(scope.browser);
    const input = await screen.findByLabelText<HTMLInputElement>('Booking link URL');
    await vi.waitFor(() => { expect(input.value).toBe('https://cal.example.test/old'); });
    fireEvent.change(input, { target: { value: 'https://cal.example.test/demo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save booking link' }));
    await screen.findByText('Booking link saved.');
    expect(scope.commands).toEqual([{ value: { url: 'https://cal.example.test/demo' }, commandId: expect.stringMatching(/^[0-9a-f-]{36}$/u) }]);
    fireEvent.click(screen.getByRole('button', { name: 'Clear booking link' }));
    await screen.findByText('Booking link cleared.');
    expect(scope.commands[1]).toMatchObject({ value: { url: null } });
    const ids = scope.commands.map(command => command['commandId']);
    expect(new Set(ids).size).toBe(2);
  });

  it('refuses a non-https link before any request leaves the browser', async () => {
    const scope = setup('admin');
    await show(scope.browser);
    const input = await screen.findByLabelText<HTMLInputElement>('Booking link URL');
    await vi.waitFor(() => { expect(input.disabled).toBe(false); });
    fireEvent.change(input, { target: { value: 'http://cal.example.test/demo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save booking link' }));
    expect(within(screen.getByRole('region', { name: 'Booking link' })).getByRole('status').textContent).toContain('public https link');
    expect(scope.commands).toHaveLength(0);
  });

  it('reports a server refusal without losing the session', async () => {
    const scope = setup('admin', null, true);
    await show(scope.browser);
    const input = await screen.findByLabelText<HTMLInputElement>('Booking link URL');
    await vi.waitFor(() => { expect(input.disabled).toBe(false); });
    fireEvent.change(input, { target: { value: 'https://cal.example.test/demo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save booking link' }));
    await screen.findByText('That link was refused. Use one public https link.');
    expect(scope.browser.current?.status).toBe('signed_in');
  });

  it('is not offered to a salesperson', async () => {
    const scope = setup('salesperson');
    await show(scope.browser);
    expect(screen.queryByLabelText('Booking link URL')).toBeNull();
    expect(scope.send.mock.calls.some(([url]) => String(url).includes('/settings/'))).toBe(false);
  });
});
