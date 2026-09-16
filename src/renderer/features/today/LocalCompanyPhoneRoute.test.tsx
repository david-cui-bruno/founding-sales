// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalAccountDetail } from './LocalAccountLibrary';
import { LocalCompanyPhoneRoute } from './LocalCompanyPhoneRoute';
import { dailyFixture, nativeDeskFixture } from './nativeDesk.fixture';
import type { LocalCompanyDetail, LocalWorkspaceApi } from '../../../shared/contracts/localWorkspaceContract';
import type { CompanyPhoneRouteReceipt } from '../../../shared/contracts/localCompanyPhoneRouteContract';
afterEach(cleanup);
const time = '2026-09-15T12:00:00.000Z', phone = '+14015723322';
// Shaped like the saved Lenox source from the 2026-09-16 walkthrough, where the Campaigns "Business phone route" dropdown stayed empty.
const lenoxQuote = 'Contact Us\n\n380 Broadway Providence, Rhode Island 02909\n\ninfo@lenoxmanagement.com\n\n401-572-3322';
const lenox = 'Lenox Management\n\nProperty management, leasing and REO services across Rhode Island and Southeastern Massachusetts since 2004.\n\n'
  + lenoxQuote + '\n\nOur in-house maintenance team coordinates repairs for the properties we manage.\n\nTenants\n\ntenants@lenoxmanagement.com\n\nTenant emergency line: 401-555-0199';
type Route = LocalCompanyDetail['snapshot']['routes'][number];
function fixture(excerpts: string[] = [lenox], routes: Route[] = [], withAdmit = true) {
  const snapshot = structuredClone(dailyFixture().accounts.find(item => item.account.id === 'a')!);
  snapshot.claims = []; snapshot.portfolio = []; snapshot.routes = routes;
  const sources = excerpts.map((excerpt, index) => ({ id: `source-${index + 1}`, url: `https://lenox-${index + 1}.example/`, fetchedAt: time, sha256: 'c'.repeat(64), excerpt, permitted: true }));
  const detail: LocalCompanyDetail = { scope: 'local_database', generatedAt: time, snapshot, sources, links: [] };
  let admittedRoute: Route | null = null;
  const admit = vi.fn<NonNullable<LocalWorkspaceApi['admitCompanyPhoneRoute']>>(async request => {
    const source = sources.find(item => item.id === request.sourceId)!;
    admittedRoute = { id: 'route-phone', accountId: request.accountId, version: 1, personId: null, channel: 'phone', value: request.phone, purpose: 'business', verification: 'published', evidenceIds: [source.id] };
    const receipt: CompanyPhoneRouteReceipt = { commandId: request.commandId, accountId: request.accountId, accountVersion: request.expectedAccountVersion + 1,
      route: { routeId: 'route-phone', routeVersion: 1, phone: request.phone, personId: null },
      publication: { sourceId: source.id, url: source.url, sha256: source.sha256, fetchedAt: source.fetchedAt, quote: request.quote }, selection: request.selection };
    return receipt;
  });
  const getCompany = vi.fn<LocalWorkspaceApi['getCompany']>(async () => ({ ...detail, snapshot: { ...detail.snapshot,
    account: { ...detail.snapshot.account, version: detail.snapshot.account.version + (admittedRoute ? 1 : 0) }, routes: admittedRoute ? [...routes, admittedRoute] : routes } }));
  const native = nativeDeskFixture();
  const base: LocalWorkspaceApi = { ...native.api.localWorkspace, getCompany };
  const api: LocalWorkspaceApi = withAdmit ? { ...base, admitCompanyPhoneRoute: admit } : base;
  const onEvidenceChanged = vi.fn();
  return { api, detail, sources, admit, getCompany, native, onEvidenceChanged, snapshot };
}
const step = () => screen.getByRole('region', { name: 'Phone route review' });
// Scoped to the phone step: on the real detail the inbox step has its own checkbox and source select.
const controls = () => ({
  select: within(step()).getByRole('combobox', { name: 'Saved source for the phone route' }) as HTMLSelectElement,
  number: within(step()).getByRole('textbox', { name: 'Business phone number' }) as HTMLInputElement,
  passage: within(step()).getByRole('textbox', { name: 'Exact source passage' }) as HTMLTextAreaElement,
  confirm: within(step()).getByRole('checkbox') as HTMLInputElement,
  admitButton: within(step()).getByRole('button', { name: 'Admit phone route' }) as HTMLButtonElement,
});

describe('phone route review on the selected company detail (real detail tree, mock API)', () => {
  it('shows the phone route step right after the inbox step once the company detail is read, without calling the API', async () => {
    const f = fixture();
    // The research panel reads the selected company's detail only for the account the continuation has selected.
    expect(f.native.firstUse.selectAccount(f.native.firstUse.captureEpoch(), 'a')).toBe(true);
    render(<LocalAccountDetail account={f.snapshot} api={f.api} contactApi={f.native.api} continuation={f.native.firstUse} onOpenImport={vi.fn()} onOpenLead={vi.fn()} />);
    const inbox = await screen.findByRole('region', { name: 'Company draft' });
    const region = step();
    expect(region.querySelector('h3')?.textContent).toBe('Review phone route');
    expect(inbox.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(controls().number.value).toBe('401-572-3322');
    expect(f.admit).not.toHaveBeenCalled(); expect(f.getCompany).toHaveBeenCalledTimes(1);
    expect(f.native.calls.some(call => call.method === 'forbidden')).toBe(false);
  });
});

describe('phone route review step (real component, mock API)', () => {
  it('prefills the Lenox business line with the Contact Us passage and the source, lists the excluded tenant line, and admits exactly the displayed values only after the confirmation click', async () => {
    const f = fixture(); render(<LocalCompanyPhoneRoute api={f.api} detail={f.detail} onEvidenceChanged={f.onEvidenceChanged} />);
    const { select, number, passage, confirm, admitButton } = controls();
    expect(select.value).toBe('source-1'); expect(number.value).toBe('401-572-3322'); expect(passage.value).toBe(lenoxQuote);
    expect(number.readOnly).toBe(true); expect(passage.readOnly).toBe(true);
    expect(confirm.checked).toBe(false); expect(admitButton.disabled).toBe(true);
    expect(screen.queryAllByRole('radio')).toEqual([]);
    const excluded = screen.getByRole('list', { name: 'Excluded numbers' });
    expect(excluded.textContent).toContain('401-555-0199'); expect(excluded.textContent).toContain('“Tenant”');
    expect(screen.getByText('Filled from saved source https://lenox-1.example/ by matching its text, not verified. Saved as +14015723322.')).toBeTruthy();
    expect(within(step()).queryByRole('button', { name: /call|dial|verify|send/i })).toBeNull();
    fireEvent.click(confirm); expect(admitButton.disabled).toBe(false);
    expect(f.admit).not.toHaveBeenCalled();
    fireEvent.click(admitButton);
    await screen.findByText('Saved business phone route: +14015723322 (published)');
    expect(f.admit).toHaveBeenCalledTimes(1);
    expect(f.admit.mock.calls[0][0]).toEqual({ commandId: expect.stringMatching(/^[0-9a-f-]{36}$/), accountId: 'a', expectedAccountVersion: f.detail.snapshot.account.version,
      phone, sourceId: 'source-1', quote: lenoxQuote, selection: 'published_company_business_phone' });
    expect(f.getCompany).toHaveBeenCalledWith({ accountId: 'a' });
    expect(f.onEvidenceChanged).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Every phone number found in saved sources is already saved as the business line.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Admit phone route' })).toBeNull();
    expect(f.native.calls).toEqual([]);
  });
  it('keeps the exact command across a failed admission and a remount, retries it unchanged, and reports the change only on success', async () => {
    const f = fixture(); f.admit.mockRejectedValueOnce(Error('private cause'));
    const view = render(<LocalCompanyPhoneRoute api={f.api} detail={f.detail} onEvidenceChanged={f.onEvidenceChanged} />);
    fireEvent.click(controls().confirm); fireEvent.click(controls().admitButton);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).not.toContain('private cause'); expect(alert.textContent).toContain('unknown');
    expect(f.onEvidenceChanged).not.toHaveBeenCalled();
    view.unmount(); render(<LocalCompanyPhoneRoute api={f.api} detail={f.detail} onEvidenceChanged={f.onEvidenceChanged} />);
    expect(f.admit).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Review phone route again' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry phone route admission' }));
    await screen.findByText('Saved business phone route: +14015723322 (published)');
    expect(f.admit).toHaveBeenCalledTimes(2); expect(f.admit.mock.calls[1][0]).toEqual(f.admit.mock.calls[0][0]);
    expect(f.onEvidenceChanged).toHaveBeenCalledTimes(1);
  });
  it('recovers a saved route through "Review phone route again" without re-sending the command', async () => {
    const f = fixture(); f.admit.mockImplementationOnce(async request => { await f.admit.getMockImplementation()!(request); throw Error('lost reply'); });
    render(<LocalCompanyPhoneRoute api={f.api} detail={f.detail} onEvidenceChanged={f.onEvidenceChanged} />);
    fireEvent.click(controls().confirm); fireEvent.click(controls().admitButton);
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Review phone route again' }));
    await screen.findByText('Saved business phone route: +14015723322 (published)');
    expect(f.admit).toHaveBeenCalledTimes(1); expect(f.onEvidenceChanged).toHaveBeenCalledTimes(1);
  });
  it('preselects nothing when two candidates exist and fills the fields only from an explicit pick', () => {
    const f = fixture([lenox, 'Leasing office\n\n(401) 555-0150']); render(<LocalCompanyPhoneRoute api={f.api} detail={f.detail} />);
    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    expect(radios).toHaveLength(2); expect(radios.every(radio => !radio.checked)).toBe(true);
    const { select, number, passage, confirm, admitButton } = controls();
    expect(select.value).toBe(''); expect(number.value).toBe(''); expect(passage.value).toBe('');
    fireEvent.click(confirm); expect(admitButton.disabled).toBe(true);
    fireEvent.click(radios[1]);
    expect(controls().select.value).toBe('source-2'); expect(controls().number.value).toBe('(401) 555-0150'); expect(controls().passage.value).toBe('Leasing office\n\n(401) 555-0150');
    expect(controls().confirm.checked).toBe(false);
    fireEvent.change(controls().select, { target: { value: 'source-1' } });
    expect(controls().number.value).toBe('401-572-3322'); expect(controls().passage.value).toBe(lenoxQuote);
    expect(f.admit).not.toHaveBeenCalled();
  });
  it('lists excluded numbers with the matched word and never offers them', () => {
    const f = fixture(['Tenants\n\nTenant emergency line: 401-555-0199\n\nMaintenance requests: (401) 555-0100']);
    render(<LocalCompanyPhoneRoute api={f.api} detail={f.detail} />);
    expect(screen.getByText('No business line is offered from saved sources; every number found names an excluded line.')).toBeTruthy();
    const items = within(screen.getByRole('list', { name: 'Excluded numbers' })).getAllByRole('listitem').map(item => item.textContent);
    expect(items).toEqual(['401-555-0199 matched “Tenant” · https://lenox-1.example/', '(401) 555-0100 matched “Maintenance” · https://lenox-1.example/']);
    expect(screen.queryByRole('checkbox')).toBeNull(); expect(screen.queryByRole('combobox')).toBeNull(); expect(screen.queryByRole('button')).toBeNull();
  });
  it('says no phone number was found and offers nothing else when the saved sources have none', () => {
    const f = fixture(['Lenox Management\n\nContact Us\n\ninfo@lenoxmanagement.com']); render(<LocalCompanyPhoneRoute api={f.api} detail={f.detail} />);
    expect(screen.getByText('No phone number was found in saved sources.')).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull(); expect(screen.queryByRole('combobox')).toBeNull(); expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('list')).toBeNull();
  });
  it('says the review is unavailable when the build has no phone route admission, and calls nothing', () => {
    const f = fixture([lenox], [], false); render(<LocalCompanyPhoneRoute api={f.api} detail={f.detail} onEvidenceChanged={f.onEvidenceChanged} />);
    expect(screen.getByText('Phone route review is unavailable in this build.')).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull(); expect(screen.queryByRole('button')).toBeNull(); expect(screen.queryByRole('textbox')).toBeNull();
    expect(f.getCompany).not.toHaveBeenCalled(); expect(f.onEvidenceChanged).not.toHaveBeenCalled();
  });
  it('shows an existing saved business line and offers the review only for a different number', () => {
    const saved: Route = { id: 'route-saved', accountId: 'a', version: 1, personId: null, channel: 'phone', value: phone, purpose: 'business', verification: 'confirmed', evidenceIds: ['source-1'] };
    const same = fixture([lenox], [saved]); const first = render(<LocalCompanyPhoneRoute api={same.api} detail={same.detail} />);
    expect(screen.getByText('Saved business phone route: +14015723322 (confirmed)')).toBeTruthy();
    expect(screen.getByText('Every phone number found in saved sources is already saved as the business line.')).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull();
    first.unmount();
    const other = fixture([lenox, 'Leasing office\n\n(401) 555-0150'], [saved]); render(<LocalCompanyPhoneRoute api={other.api} detail={other.detail} />);
    expect(screen.getByText('Saved business phone route: +14015723322 (confirmed)')).toBeTruthy();
    expect(screen.queryAllByRole('radio')).toEqual([]);
    expect(controls().number.value).toBe('(401) 555-0150'); expect(controls().select.value).toBe('source-2');
  });
  it('re-suggests after an untouched observation change but clears a touched review instead of substituting a quotation', async () => {
    const f = fixture(); const view = render(<LocalCompanyPhoneRoute api={f.api} detail={f.detail} />);
    expect(controls().number.value).toBe('401-572-3322');
    const refreshed = structuredClone(f.detail); refreshed.snapshot.account.version++;
    view.rerender(<LocalCompanyPhoneRoute api={f.api} detail={refreshed} />);
    expect(controls().number.value).toBe('401-572-3322');
    fireEvent.click(controls().confirm); expect(controls().confirm.checked).toBe(true);
    const again = structuredClone(refreshed); again.snapshot.account.version++;
    view.rerender(<LocalCompanyPhoneRoute api={f.api} detail={again} />);
    await waitFor(() => expect(controls().confirm.checked).toBe(false));
    expect(controls().number.value).toBe(''); expect(controls().passage.value).toBe('');
    expect(f.admit).not.toHaveBeenCalled();
  });
});
