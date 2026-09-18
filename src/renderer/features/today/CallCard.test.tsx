// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CallCard, MANUAL_DIAL_NEXT_STEP } from './CallCard';
import { dailyFixture, fixtureNow } from './nativeDesk.fixture';
import { PHONE_DIAL_MODES } from './todayCopy';
import type { LocalCompanyDetail } from '../../../shared/contracts/localWorkspaceContract';
import type { PhoneSetupApi, PhoneSetupStatus } from '../../../shared/contracts/phoneSetupContract';

afterEach(cleanup);
const hash = 'a'.repeat(64);
function firm(): ReturnType<typeof dailyFixture>['accounts'][number] {
  const account = dailyFixture().accounts[0]!;
  return {
    ...account,
    account: { ...account.account, name: 'Fictional Harbor PM', domain: 'harbor.example.invalid' },
    claims: [
      { kind: 'fact', key: 'residential_scope', value: 'Residential and multifamily rentals', evidenceIds: ['site'] },
      { kind: 'hypothesis', key: 'pain', value: 'Unconfirmed workflow', evidenceIds: [] },
    ],
    routes: [
      { id: 'listed-phone', accountId: 'a', personId: null, channel: 'phone', value: '+14015550100', purpose: 'business', verification: 'listed', evidenceIds: ['places'], version: 1 },
      { id: 'site-phone', accountId: 'a', personId: null, channel: 'phone', value: '+14015550101', purpose: 'business', verification: 'published', evidenceIds: ['site'], version: 1 },
      { id: 'mail', accountId: 'a', personId: null, channel: 'email', value: 'office@harbor.example.invalid', purpose: 'business', verification: 'published', evidenceIds: ['site'], version: 1 },
    ],
    portfolio: [{ count: 340, measure: 'units', scope: 'managed', evidenceIds: ['site'] }],
  };
}
function detail(snapshot = firm()): LocalCompanyDetail {
  return {
    scope: 'local_database', generatedAt: fixtureNow, snapshot, links: [],
    sources: [
      { id: 'places', url: 'https://places.googleapis.com/v1/places:searchText', fetchedAt: fixtureNow, sha256: hash, permitted: true,
        excerpt: JSON.stringify({ id: 'place-1', displayName: 'Fictional Harbor PM', formattedAddress: '12 Harbor Way, Newport, RI 02840, USA', nationalPhoneNumber: '(401) 555-0100', websiteUri: 'https://harbor.example.invalid/' }) },
      { id: 'site', url: 'https://harbor.example.invalid/about', fetchedAt: fixtureNow, sha256: hash, permitted: true, excerpt: 'We manage 340 residential and multifamily rental units across Newport County.' },
    ],
  };
}
const text = (label: string) => screen.getByText(new RegExp(`^${label}:`)).textContent;

describe('CallCard', () => {
  it('shows every field from the saved evidence, reads the listing once for the city, state and sources, and offers no control that dials', async () => {
    const account = firm();
    const api = { getCompany: vi.fn(async () => detail(account)) };
    render(<CallCard account={account} api={api} />);
    const card = screen.getByRole('region', { name: 'Call card' });
    expect(screen.getByRole('heading', { level: 3, name: 'Fictional Harbor PM' })).toBeTruthy();
    expect(screen.getByText('+14015550100').closest('p')!.textContent).toBe('+14015550100 · listed in a business directory');
    expect(screen.getByText('+14015550101').closest('p')!.textContent).toBe('+14015550101 · published on the firm\'s own site');
    expect(screen.queryByText(/office@harbor/)).toBeNull();
    expect(text('Website')).toBe('Website: https://harbor.example.invalid/');
    expect(text('Portfolio')).toBe('Portfolio: 340 managed units');
    expect(text('Residential')).toBe('Residential: Residential and multifamily rentals');
    expect(text('Location')).toBe('Location: reading the saved listing…');
    await waitFor(() => expect(text('Location')).toBe('Location: Newport, RI'));
    expect(text('Source')).toBe('Source: https://places.googleapis.com/v1/places:searchText · https://harbor.example.invalid/about');
    expect(api.getCompany).toHaveBeenCalledTimes(1);
    expect(api.getCompany).toHaveBeenCalledWith({ accountId: 'a' });
    // The only control is the explicit show-number fallback. Nothing here dials, links or navigates.
    expect([...card.querySelectorAll('button, a, input, select')].map(node => node.textContent)).toEqual(['Show number']);
    expect(card.querySelector('a[href^="tel:"]')).toBeNull();
    expect(card.textContent).toContain('Reading this card places no call.');
  });

  it('keeps honest unavailable states: a failed detail read, a detail for another firm, a firm with no phone, and missing evidence', async () => {
    const account = firm();
    const failing = { getCompany: vi.fn(async () => { throw Error('/Users/founder/private detail failure'); }) };
    const view = render(<CallCard account={account} api={failing} />);
    await waitFor(() => expect(text('Location')).toBe('Location: unavailable (local company detail could not be read)'));
    expect(text('Source')).toBe('Source: unavailable');
    expect(screen.queryByText(/private detail/)).toBeNull();
    view.unmount();
    const other = { getCompany: vi.fn(async () => detail({ ...firm(), account: { ...firm().account, id: 'b' } })) };
    render(<CallCard account={account} api={other} />);
    await waitFor(() => expect(text('Location')).toBe('Location: unavailable (local company detail could not be read)'));
    cleanup();
    const phoneless: ReturnType<typeof firm> = { ...firm(), routes: [], portfolio: [], claims: [] };
    const api = { getCompany: vi.fn(async () => detail(phoneless)) };
    render(<CallCard account={{ ...phoneless, account: { ...phoneless.account, domain: null } }} api={api} />);
    expect(screen.getByText('No business phone is saved for this firm.')).toBeTruthy();
    expect(text('Website')).toBe('Website: not recorded');
    expect(text('Portfolio')).toBe('Portfolio: count not found');
    expect(text('Residential')).toBe('Residential: scope not found');
    expect(text('Location')).toBe('Location: not read (no saved business phone)');
    expect(api.getCompany).not.toHaveBeenCalled();
    cleanup();
    render(<CallCard account={firm()} />);
    expect(text('Location')).toBe('Location: unavailable (local company detail could not be read)');
    expect(text('Source')).toBe('Source: unavailable');
  });

  describe('show-number fallback (D6)', () => {
    const setup = (state: PhoneSetupStatus['state']): PhoneSetupApi => ({
      status: vi.fn<PhoneSetupApi['status']>(async () => state === 'configured'
        ? { state, candidateFingerprint: 'fictional-helper', confirmedAt: fixtureNow }
        : state === 'needs_confirmation' ? { state, candidateFingerprint: 'fictional-helper', confirmedAt: null }
          : { state, candidateFingerprint: null, confirmedAt: null }),
      confirm: async () => { throw Error('No setup mutation from the call card'); },
      clear: async () => { throw Error('No setup mutation from the call card'); },
    });
    const reveal = () => fireEvent.click(screen.getByRole('button', { name: 'Show number' }));

    it.each(['unconfigured', 'unavailable', 'needs_confirmation'] as const)(
      'shows the number, a copy control and the plain reason when the helper cannot dial (%s)', async state => {
        const account = firm();
        const phone = setup(state);
        const copy = vi.fn(async () => undefined);
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
        render(<CallCard account={account} api={{ getCompany: vi.fn(async () => detail(account)) }} phoneSetup={phone} />);
        expect(phone.status).not.toHaveBeenCalled();
        expect(copy).not.toHaveBeenCalled();
        reveal();
        await screen.findByText(`Callie cannot dial from this Mac: ${PHONE_DIAL_MODES[state].reason}. Dial it yourself and log the outcome below.`);
        expect(phone.status).toHaveBeenCalledTimes(1);
        // The hand-dialed call has somewhere to go now: the card names the control that logs it.
        expect(screen.getByText(MANUAL_DIAL_NEXT_STEP)).toBeTruthy();
        expect(screen.getByTestId('dial-number').textContent).toBe('+14015550100');
        const card = screen.getByRole('region', { name: 'Call card' });
        expect(card.querySelector('a[href^="tel:"]')).toBeNull();
        expect(copy).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Copy number' }));
        expect(copy).toHaveBeenCalledWith('+14015550100');
        await screen.findByText('Number copied. Copying is not a call.');
      });

    it('keeps the handoff below primary and the number visible when the helper can dial', async () => {
      const account = firm();
      const phone = setup('configured');
      render(<CallCard account={account} api={{ getCompany: vi.fn(async () => detail(account)) }} phoneSetup={phone} />);
      reveal();
      await screen.findByText(PHONE_DIAL_MODES.configured.card);
      expect(screen.queryByText(/Callie cannot dial from this Mac/)).toBeNull();
      expect(screen.queryByText(MANUAL_DIAL_NEXT_STEP)).toBeNull();
      expect(screen.getByTestId('dial-number').textContent).toBe('+14015550100');
      expect(screen.getByRole('button', { name: 'Copy number' })).toBeTruthy();
    });

    it('is honest when phone setup cannot be read at all, and offers nothing for a firm with no phone', async () => {
      const account = firm();
      const failing: PhoneSetupApi = { status: vi.fn(async () => { throw Error('/Users/founder/private phone failure'); }),
        confirm: async () => { throw Error('no'); }, clear: async () => { throw Error('no'); } };
      const view = render(<CallCard account={account} api={{ getCompany: vi.fn(async () => detail(account)) }} phoneSetup={failing} />);
      reveal();
      await screen.findByText(`Callie cannot dial from this Mac: ${PHONE_DIAL_MODES.unreadable.reason}. Dial it yourself and log the outcome below.`);
      expect(screen.queryByText(/private phone failure/)).toBeNull();
      expect(screen.getByTestId('dial-number').textContent).toBe('+14015550100');
      view.unmount();
      // No phoneSetup api at all is the same honest unreadable state, never a silent success.
      render(<CallCard account={account} api={{ getCompany: vi.fn(async () => detail(account)) }} />);
      reveal();
      await screen.findByText(`Callie cannot dial from this Mac: ${PHONE_DIAL_MODES.unreadable.reason}. Dial it yourself and log the outcome below.`);
      cleanup();
      const phoneless: ReturnType<typeof firm> = { ...firm(), routes: [] };
      render(<CallCard account={phoneless} phoneSetup={setup('configured')} />);
      expect(screen.queryByRole('button', { name: 'Show number' })).toBeNull();
    });
  });

  it('says when the saved sources carry no listing', async () => {
    const account: ReturnType<typeof firm> = { ...firm(), routes: firm().routes.filter(route => route.id !== 'listed-phone') };
    const site = detail(account);
    const api = { getCompany: vi.fn(async () => ({ ...site, sources: site.sources.filter(source => source.id === 'site') })) };
    render(<CallCard account={account} api={api} />);
    await waitFor(() => expect(text('Location')).toBe('Location: not found in the saved sources'));
    expect(text('Source')).toBe('Source: https://harbor.example.invalid/about');
  });
});
