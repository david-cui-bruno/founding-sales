// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CallCard } from './CallCard';
import { dailyFixture, fixtureNow } from './nativeDesk.fixture';
import type { LocalCompanyDetail } from '../../../shared/contracts/localWorkspaceContract';

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
    expect(card.querySelectorAll('button, a, input, select')).toHaveLength(0);
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

  it('says when the saved sources carry no listing', async () => {
    const account: ReturnType<typeof firm> = { ...firm(), routes: firm().routes.filter(route => route.id !== 'listed-phone') };
    const site = detail(account);
    const api = { getCompany: vi.fn(async () => ({ ...site, sources: site.sources.filter(source => source.id === 'site') })) };
    render(<CallCard account={account} api={api} />);
    await waitFor(() => expect(text('Location')).toBe('Location: not found in the saved sources'));
    expect(text('Source')).toBe('Source: https://harbor.example.invalid/about');
  });
});
