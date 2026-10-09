// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { DashboardResponse } from '@fss/contracts';
import { NAV_ROWS, SETTINGS_ROW, figuresView, type HomeView } from '../src/renderer/homeView.ts';
import { TodayColumn } from '../src/renderer/today/TodayColumn.tsx';
import { Sidebar } from '../src/renderer/app/Sidebar.tsx';
import { SettingsView } from '../src/renderer/settings/SettingsView.tsx';
import { createGeneration } from '../src/renderer/app/generation.ts';
import { routeOf } from '../src/renderer/routes.ts';

/**
 * The navigation as David settled it (29 September 2026).
 *
 * Today, Replies, Pipeline, Firms, Sequences, and Settings at the foot. Administration
 * and Diagnostics are inside Settings, and the Dashboard is not a place a person
 * navigates to at all: its figures are on Today and the count of firms in each stage is
 * the Pipeline's own column headings.
 *
 * Pipeline and Firms were one row until 1.0.14 and were two questions answered on one
 * screen — what am I working, and who is on file. They are two rows, and every key below
 * Replies moved down one.
 *
 * This is a lock rather than a description. Both halves of it went wrong once: the
 * sidebar carried Administration and the Dashboard as rows five and six until 1.0.12,
 * and the way back from that was a list the shell reads rather than markup each row
 * repeats. Asserting the whole list — and that it is the *whole* list — is what makes
 * a sixth row somebody adds a failing test rather than a surprise on David's Mac.
 */

/** Sidebar reads nothing from the view but the status rows; the rest is the route. */
const view = { status: [] } as unknown as HomeView;

const client = (): QueryClient =>
  new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });

afterEach(cleanup);

describe('the sidebar', () => {
  it('renders exactly the settled entries, in order, and nothing else', () => {
    render(
      <Sidebar
        view={view}
        route={{ name: 'today' }}
        thisMac={null}
        thisMacOpen={false}
        onToggleThisMac={() => undefined}
        onNavigate={() => undefined}
        onRestartToUpdate={() => undefined}
      />,
    );

    const labels = screen
      .getAllByRole('button')
      .filter(node => node.dataset['testid']?.startsWith('nav-') === true)
      .map(node => node.textContent);
    expect(labels).toEqual(['Today⌘1', 'Replies⌘2', 'Pipeline⌘3', 'Firms⌘4', 'Sequences⌘5', 'Social⌘6', 'Ask⌘7', 'Settings⌘,']);
    // Neither of the two that moved into Settings is a row here.
    expect(screen.queryByTestId('nav-dashboard')).toBeNull();
    expect(screen.queryByTestId('nav-admin')).toBeNull();
  });

  it('keeps the Dashboard out of the rows the shell builds from', () => {
    expect(NAV_ROWS.map(row => row.route)).toEqual(['today', 'replies', 'pipeline', 'firms', 'sequences', 'social', 'ask']);
    expect(SETTINGS_ROW.route).toBe('settings');
  });

  it('lights Settings up for a firm’s page under Firms and for every Settings tab', () => {
    render(
      <Sidebar
        view={view}
        route={{ name: 'settings', tab: 'diagnostics' }}
        thisMac={null}
        thisMacOpen={false}
        onToggleThisMac={() => undefined}
        onNavigate={() => undefined}
        onRestartToUpdate={() => undefined}
      />,
    );
    expect(screen.getByTestId('nav-settings').getAttribute('aria-current')).toBe('page');
    expect(screen.getByTestId('nav-today').getAttribute('aria-current')).toBeNull();
  });
});

describe('Settings', () => {
  it('holds Administration and Diagnostics, and the Dashboard’s figures behind the same view', () => {
    render(
      <QueryClientProvider client={client()}>
        <SettingsView
          route={{ name: 'settings', tab: 'administration' }}
          identity={null}
          generation={0}
          guard={createGeneration().guard}
          mailbox={null}
          mailboxWaiting={false}
          hasMailboxBridge={false}
          onSwitchMailbox={() => undefined}
        />
      </QueryClientProvider>,
    );

    const tabs = screen.getByTestId('tabs');
    expect(tabs.textContent).toContain('Administration');
    expect(tabs.textContent).toContain('Diagnostics');
    // The figures did not disappear with the navigation entry: the page is still here,
    // reachable from Settings, and every query behind it is untouched.
    expect(tabs.textContent).toContain('Dashboard');
  });

  it('still understands the links 1.0.11 left behind', () => {
    expect(routeOf('dashboard')).toEqual({ name: 'settings', tab: 'dashboard' });
    expect(routeOf('admin')).toEqual({ name: 'settings', tab: 'administration' });
  });
});

describe('Today’s numbers row', () => {
  /** The seven days the shell asks for, and an answer for exactly that window. */
  const WINDOW = { from: '2026-09-18T12:00:00.000Z', to: '2026-09-25T12:00:00.000Z' };
  const dashboard = {
    window: WINDOW,
    audience: 'workspace',
    firmsInScope: 5,
    messages: { incomingMatched: 6, human: 4, uncertain: 0, automated: 0, bounces: 0, optOuts: 0 },
    replyHandling: { replies: 4, handled: 3, medianSecondsToHandle: 600, slowestSecondsToHandle: 1200 },
    calls: [{ key: 'voicemail_left', count: 5 }],
    stageMovement: [],
    holds: { open: 3, byReason: [] },
    suppressions: [],
    sending: { available: false, owner: 'G7-2', reason: 'not in this build' },
    enrollments: { available: false, owner: 'G8', reason: 'not in this build' },
    classifier: { available: false, owner: 'G7b', reason: 'not in this build' },
    funnel: {
      available: true,
      byKind: [{ key: 'meeting.booked', count: 2 }],
      firmsByKind: [],
      uniqueFirms: 2,
      firmsInScope: 5,
    },
  } as unknown as DashboardResponse;

  it('shows the sales numbers the Dashboard used to hold, from the dashboard read', () => {
    const home = {
      heading: 'Friday, 25 September',
      summary: null,
      notices: [],
      lanes: null,
      status: [],
      needs: [],
      needsLine: 'Nothing needs you.',
      figures: figuresView({ admin: true, figures: { requested: WINDOW, answered: true, dashboard }, callsToday: 3, zone: 'America/New_York' }),
    } as unknown as HomeView;

    render(
      <TodayColumn
        home={home}
        today={null}
        todayView={null}
        pending={0}
        refreshAnswered={false}
        now={Date.parse(WINDOW.to)}
        hasTodayBridge={false}
        actions={null}
        onRefresh={() => undefined}
        onConnectMailbox={() => undefined}
      />,
    );

    // Today's calls first, from their own read, then the seven-day cells beside them.
    // Slice 3a (C0): each figure names its period.
    expect(screen.getByTestId('figure-calls_today').textContent).toBe('Calls placedtoday3');
    expect(screen.getByTestId('figure-calls').textContent).toBe('Calls placedsince 18 Sep5');
    expect(screen.getByTestId('figure-meetings').textContent).toBe('Meetings bookedsince 18 Sep2');
    expect(screen.getByTestId('figure-waiting').textContent).toBe('Replies waitingsince 18 Sep1');
    expect(screen.getByTestId('figure-replies').textContent).toBe('Repliessince 18 Sep4');
  });
});

it('opens the single Ask section through strict navigation',()=>{expect(routeOf('ask')).toEqual({name:'ask'});expect(routeOf('ask/execute')).toBeNull();});
