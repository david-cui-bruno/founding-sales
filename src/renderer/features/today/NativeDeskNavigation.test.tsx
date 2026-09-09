// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TodayRoute, type TodayRouteApi } from './TodayRoute';
import { dailyFixture, nativeDeskFixture } from './nativeDesk.fixture';
import { renderRoute, type RouteContext } from '../../app/routeRegistry';
import { routeFromHash } from '../../app/routes';
import { navigationItems } from '../../app/navigationItems';
afterEach(cleanup);
it('actual Today selects stored meeting_first without mounting legacy read or command APIs', async () => {
  const f = nativeDeskFixture();
  const get = vi.fn(async () => {
    throw Error('Legacy mounted');
  });
  render(
    <TodayRoute
      api={{ get } as unknown as TodayRouteApi}
      workspaceApi={f.api}
      onOpenLead={vi.fn()}
    />,
  );
  expect(
    (await screen.findByTestId('native-desk')).getAttribute(
      'data-workflow-mode',
    ),
  ).toBe('meeting_first');
  expect(get).not.toHaveBeenCalled();
  expect(f.calls.map((c) => c.method)).toEqual([
    'localWorkspace.get',
    'localWorkspace.getCommitments',
    'daily.get',
    'delegation.status',
  ]);
});
it.each(['accounts', 'campaigns'] as const)(
  'registers the real %s snapshot surface',
  async (route) => {
    const f = nativeDeskFixture();
    render(
      renderRoute(route, {
        api: f.api,
        openLead: vi.fn(),
      } as unknown as RouteContext),
    );
    await screen.findByRole('heading', {
      level: 1,
      name: route === 'accounts' ? 'Accounts' : 'Campaigns',
    });
    await screen.findByTestId('native-desk');
    expect(f.calls.map((c) => c.method)).toEqual([
      'localWorkspace.get',
    'localWorkspace.getCommitments',
    'daily.get',
      'delegation.status',
    ]);
  },
);
it('keeps every historical route and review alias reachable', () => {
  for (const route of [
    'today',
    'leads',
    'pipeline',
    'conversations',
    'learnings',
    'friday',
    'inbox',
    'settings',
  ]) {
    expect(routeFromHash(`#/${route}`)).toBe(route);
    expect(navigationItems.find((i) => i.route === route)?.enabled).toBe(true);
  }
  expect(routeFromHash('#/review')).toBe('inbox');
});
it('company call selection is not dispatch, and only a real linked person can open legacy workspace', async () => {
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
  const f = nativeDeskFixture(snapshot),
    open = vi.fn();
  render(
    <TodayRoute
      api={{} as TodayRouteApi}
      workspaceApi={f.api}
      onOpenLead={open}
    />,
  );
  fireEvent.click(
    await screen.findByRole('button', { name: 'Call · Account A' }),
  );
  expect(open).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole('button', { name: 'Open contact workspace' }),
  );
  expect(open).toHaveBeenCalledWith('real-person');
  expect(f.calls.map((c) => c.method)).toEqual([
    'localWorkspace.get',
    'localWorkspace.getCommitments',
    'daily.get',
    'delegation.status',
  ]);
});
