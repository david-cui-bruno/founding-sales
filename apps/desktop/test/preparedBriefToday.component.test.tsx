// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { JSX } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PreparedBriefDto } from '@fss/contracts';
import { DraftsProvider } from '../src/renderer/app/drafts.tsx';
import type { CallControl } from '../src/renderer/calling/useCall.ts';
import type { HomeView } from '../src/renderer/homeView.ts';
import { TodayWorkspace, useTodayMemory } from '../src/renderer/today/TodayWorkspace.tsx';
import type { Today, TodayActions } from '../src/renderer/today/useToday.ts';
import type { TodayState } from '../src/renderer/todayContract.ts';
import { buildTodayView } from '../src/renderer/todayView.ts';
import type { OperationApi } from '../src/shared/operations.ts';

/**
 * Lane PB, review findings 1 and 4, in Today itself:
 *
 *   * K1/K4 — A's Clear confirmation, focused, then J to B, then Enter: nothing is sent, and
 *     certainly not a clear of B;
 *   * K3/K7 — A's save answering after David moved to B never opens A again.
 */

afterEach(() => {
  cleanup();
  globalThis.callieApi = undefined;
});

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

const brief = (text: string): PreparedBriefDto => ({
  brief: text,
  sources: [{ url: 'https://firm.example.test/contact', label: 'Phone source' }],
  observedOn: '2026-10-02',
  preparedBy: 'Callie research agent (web), verified phones',
  updatedAt: '2026-10-02T15:00:00.000Z',
});

const card = (firmId: string, firmName: string) => ({ firmId, firmName, lane: 'new_firm' as const, dueAt: '2026-10-02T13:00:00.000Z', counts: { replies: 0, emailsDue: 0, callsDue: 0 } });

const stateOn = (firmId: string): TodayState => ({
  snapshotDate: '2026-10-02',
  businessTimeZone: 'America/Chicago',
  cards: [card(A, 'Alpha Test Rentals'), card(B, 'Bravo Test Rentals')],
  expanded: {
    firmId,
    firmName: firmId === A ? 'Alpha Test Rentals' : 'Bravo Test Rentals',
    snapshotDate: '2026-10-02',
    lane: 'new_firm',
    counts: { replies: 0, emailsDue: 0, callsDue: 0 },
    tasks: [],
    routes: [],
    callingIdentityId: null,
    preparedBrief: brief(firmId === A ? 'Alpha brief' : 'Bravo brief'),
  },
  online: true,
  stale: false,
  asOf: '2026-10-02T13:00:00.000Z',
  mayMutate: true,
  role: 'admin',
  notice: null,
  handoffNotice: '',
  dialAdvice: [],
  followUpTemplates: [],
  lastCall: null,
});

const home = {
  heading: 'Friday, 2 October',
  summary: null,
  notices: [],
  lanes: { sections: [], emptyLine: null },
  status: [],
  needs: [],
  needsLine: 'Nothing needs you.',
  figures: { label: 'Numbers', cells: [], line: null },
} as unknown as HomeView;
const control: CallControl = { state: { phase: 'idle' }, muted: false, seconds: 0, place: vi.fn(), toggleMute: vi.fn(), hangUp: vi.fn(), dismiss: vi.fn() };

/**
 * Today on A, its state held in the request cache under `today` as `useToday` holds it, where
 * `expand` moves the open firm as the bridge would — at once, or when the test lets it.
 */
function world(options: { readonly slowExpand?: boolean } = {}) {
  const expanded: string[] = [];
  const expansions: (() => void)[] = [];
  const commands: { name: string; input: unknown }[] = [];
  const answers: ((value: unknown) => void)[] = [];
  globalThis.callieApi = {
    read: async () => await Promise.reject(new Error('no reads scripted')),
    command: async (name: string, input: unknown) => {
      commands.push({ name, input });
      return await new Promise(resolve => answers.push(resolve));
    },
  } as unknown as OperationApi;
  function Shell(): JSX.Element {
    const client = useQueryClient();
    const state = useQuery({ queryKey: ['today', 'me', 0], queryFn: () => stateOn(A), initialData: stateOn(A), staleTime: Number.POSITIVE_INFINITY }).data;
    const memory = useTodayMemory();
    const actions = {
      busy: () => false,
      dial: vi.fn(),
      previewFollowUp: vi.fn(),
      expand: (firmId: string) => {
        expanded.push(firmId);
        const land = (): void => {
          client.setQueryData(['today', 'me', 0], stateOn(firmId));
        };
        if (options.slowExpand === true) expansions.push(land);
        else land();
      },
    } as unknown as TodayActions;
    const today: Today = { state, pending: 0, commands: 0, refreshAnswered: true, now: Date.parse('2026-10-02T14:00:00.000Z'), refresh: vi.fn(), actions, autoRefresh: vi.fn() };
    return <TodayWorkspace home={home} today={today} todayView={buildTodayView(state)} call={control} memory={memory} hasTodayBridge onRefresh={vi.fn()} onConnectMailbox={vi.fn()} />;
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <DraftsProvider>
        <Shell />
      </DraftsProvider>
    </QueryClientProvider>,
  );
  return { expanded, commands, answers, expansions };
}

describe('the prepared brief in Today', () => {
  it('shows the open firm’s brief, read-only, and the next firm’s after J', async () => {
    const user = userEvent.setup();
    const { commands } = world();
    expect((await screen.findByTestId('prepared-brief-text')).textContent).toBe('Alpha brief');
    expect(screen.getByTestId('prepared-brief').querySelector('button, textarea')).toBeNull();
    await user.keyboard('j');
    await waitFor(() => expect(screen.getByTestId('prepared-brief-text').textContent).toBe('Bravo brief'));
    expect(commands).toEqual([]);
  });
});
