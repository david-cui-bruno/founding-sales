import { PresentationRoot } from '../../app/PresentationRoot';
// @vitest-environment jsdom
import { cleanup, fireEvent, render as testingRender, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { dailyFixture, nativeDeskFixture } from './nativeDesk.fixture';
import { renderRoute, type RouteContext } from '../../app/routeRegistry';
import { appRoutes, routeFromHash } from '../../app/routes';
import { navigationItems } from '../../app/navigationItems';
afterEach(cleanup);
it.each(['today', 'accounts', 'campaigns'] as const)(
  'registers the real %s company workspace and reads only local snapshots and configuration',
  async (route) => {
    const f = nativeDeskFixture();
    render(
      renderRoute(route, {
        api: f.api,
        firstUse: f.firstUse,
      } as unknown as RouteContext),
    );
    await screen.findByRole('heading', {
      level: 1,
      name: route === 'today' ? 'Today' : route === 'accounts' ? 'Accounts' : 'Campaigns',
    });
    expect(
      (await screen.findByTestId('native-desk')).getAttribute('data-workflow-mode'),
    ).toBe('meeting_first');
    expect(f.calls.map((c) => c.method)).toEqual([
      'localWorkspace.get',
      'localWorkspace.getCommitments',
      'daily.get',
      'delegation.status',
    ]);
  },
);
it('keeps exactly the company-model routes reachable and lands removed legacy hashes on Today', () => {
  expect([...appRoutes]).toEqual(['today', 'accounts', 'campaigns', 'settings']);
  for (const route of appRoutes) {
    expect(routeFromHash(`#/${route}`)).toBe(route);
    expect(navigationItems.find((i) => i.route === route)?.enabled).toBe(true);
  }
  for (const legacy of ['leads', 'pipeline', 'conversations', 'learnings', 'friday', 'inbox', 'review']) {
    expect(routeFromHash(`#/${legacy}`)).toBe('today');
    expect(navigationItems.find((i) => i.route === legacy)).toBeUndefined();
  }
});
it('company call selection is not dispatch and offers no contact workspace to open', async () => {
  const snapshot = dailyFixture();
  snapshot.accounts[0].routes = [
    {
      id: 'phone',
      accountId: 'a',
      personId: 'real-person',
      channel: 'phone',
      value: '+12025550100',
      purpose: 'business',
      verification: 'confirmed',
      evidenceIds: ['source'],
      version: 1,
    },
  ];
  const f = nativeDeskFixture(snapshot);
  render(renderRoute('today', { api: f.api, firstUse: f.firstUse } as unknown as RouteContext));
  fireEvent.click(
    await screen.findByRole('button', { name: 'Call · Account A' }),
  );
  expect(screen.getByRole('heading', { level: 3, name: 'Phone route' })).toBeTruthy();
  expect(screen.getByText('+12025550100 · business · confirmed')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Open contact workspace' })).toBeNull();
  expect(f.calls.map((c) => c.method)).toEqual([
    'localWorkspace.get',
    'localWorkspace.getCommitments',
    'daily.get',
    'delegation.status',
  ]);
});

const render = (ui: Parameters<typeof testingRender>[0], options?: Parameters<typeof testingRender>[1]) => testingRender(ui, { wrapper: PresentationRoot, ...options });

Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.open = true; } });
Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.open = false; } });
