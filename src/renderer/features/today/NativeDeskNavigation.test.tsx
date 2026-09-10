import { PresentationRoot } from '../../app/PresentationRoot';
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render as testingRender, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TodayRoute, type TodayRouteApi } from './TodayRoute';
import { NativeDeskRoute } from './NativeDeskRoute';
import { dailyFixture, localSnapshot, nativeDeskFixture } from './nativeDesk.fixture';
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
    <TodayRoute firstUse={f.firstUse}
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
        firstUse: f.firstUse,
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
    <TodayRoute firstUse={f.firstUse}
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

const render = (ui: Parameters<typeof testingRender>[0], options?: Parameters<typeof testingRender>[1]) => testingRender(ui, { wrapper: PresentationRoot, ...options });

Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.open = true; } });
Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.open = false; } });

it('keeps established legacy callback DOM while local and daily refresh fail, with command holds intact', async () => {
  const f = nativeDeskFixture(dailyFixture({ workflowMode: 'legacy' }));
  const overview = vi.spyOn(f.api.localWorkspace, 'get').mockResolvedValue(localSnapshot({ workflowMode: 'legacy' }));
  const daily = vi.spyOn(f.api.daily, 'get');
  const renderLegacy = (readHeld: boolean) => <input aria-label="Legacy form" readOnly={readHeld} />;
  render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} onOpenLead={vi.fn()} renderLegacy={renderLegacy} />);
  const field = await screen.findByLabelText('Legacy form') as HTMLInputElement;
  fireEvent.change(field, { target: { value: 'Retained legacy draft' } });
  overview.mockRejectedValueOnce(new Error('Local unavailable'));
  daily.mockRejectedValueOnce(new Error('Daily unavailable'));
  await act(async () => { fireEvent.focus(window); });
  expect(screen.getByLabelText('Legacy form')).toBe(field);
  expect(field.value).toBe('Retained legacy draft');
  expect(field.readOnly).toBe(true);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Refresh workspace status' })); });
  expect(screen.getByLabelText('Legacy form')).toBe(field);
  expect(field.readOnly).toBe(false);
});
it.each(['fallback', 'callback'] as const)('supports established legacy %s without an optional local API', async variant => {
  const f = nativeDeskFixture(dailyFixture({ workflowMode: 'legacy' }));
  const { localWorkspace: omitted, ...api } = f.api; void omitted;
  const legacy = <input aria-label="Legacy form" />;
  render(<NativeDeskRoute firstUse={f.firstUse} api={api} onOpenLead={vi.fn()} legacy={legacy}
    renderLegacy={variant === 'callback' ? held => <input aria-label="Legacy form" readOnly={held} /> : undefined} />);
  const field = await screen.findByLabelText('Legacy form');
  await act(async () => { fireEvent.focus(window); });
  expect(screen.getByLabelText('Legacy form')).toBe(field);
  expect((field as HTMLInputElement).readOnly).toBe(false);
});
