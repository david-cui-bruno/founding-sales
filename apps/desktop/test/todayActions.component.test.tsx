// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState, type JSX } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DraftsProvider } from '../src/renderer/app/drafts.tsx';
import type { CallControl } from '../src/renderer/calling/useCall.ts';
import type { HomeView } from '../src/renderer/homeView.ts';
import { TodayWorkspace, useTodayMemory } from '../src/renderer/today/TodayWorkspace.tsx';
import type { Today, TodayActions } from '../src/renderer/today/useToday.ts';
import type { TodayState } from '../src/renderer/todayContract.ts';
import { setNavigator } from '../src/renderer/routes.ts';
import type { OperationApi } from '../src/shared/operations.ts';
import type { TodayActionsV2Response } from '@fss/contracts';
import { buildTodayView } from '../src/renderer/todayView.ts';

/** Today actions through the public workspace and a controlled Operations adapter. */

afterEach(cleanup);

const A = '11111111-1111-4111-8111-111111111111';
const B = '44444444-4444-4444-8444-444444444444';
const ROUTE_ID = '22222222-2222-4222-8222-222222222222';
const NAMES: Readonly<Record<string, string>> = { [A]: 'Elm Fork Test Rentals', [B]: 'Cedar Hollow Test Homes' };

const card = (firmId: string): TodayState['cards'][number] => ({
  firmId,
  firmName: NAMES[firmId] ?? '',
  lane: 'new_firm',
  dueAt: '2026-10-01T13:00:00.000Z',
  counts: { replies: 0, emailsDue: 0, callsDue: 0 },
});

const expandedFor = (firmId: string): NonNullable<TodayState['expanded']> => ({
  firmId,
  firmName: NAMES[firmId] ?? '',
  snapshotDate: '2026-10-01',
  lane: 'new_firm',
  counts: { replies: 0, emailsDue: 0, callsDue: 0 },
  tasks: [],
  routes: [{ routeId: ROUTE_ID, contactId: null, e164: '+12145550142', version: 1, eligibility: 'usable' }],
  callingIdentityId: null,
});

const initial = (): TodayState => ({
  snapshotDate: '2026-10-01',
  businessTimeZone: 'America/Chicago',
  cards: [card(A), card(B)],
  expanded: expandedFor(A),
  online: true,
  stale: false,
  asOf: '2026-10-01T13:00:00.000Z',
  mayMutate: true,
  role: 'admin',
  notice: null,
  handoffNotice: '',
  dialAdvice: [{ routeId: ROUTE_ID, callable: true, reasons: [], e164: '+12145550142', firmLocalTime: '09:40' }],
  followUpTemplates: [],
});

const home = {
  heading: 'Thursday, 1 October',
  summary: null,
  notices: [],
  lanes: { sections: [], emptyLine: null },
  status: [],
  needs: [],
  needsLine: 'Nothing needs you.',
  figures: { label: 'Numbers', cells: [], line: null },
} as unknown as HomeView;

const callOf = (phase: CallControl['state']): CallControl => ({
  state: phase,
  muted: false,
  seconds: 12,
  place: vi.fn(),
  toggleMute: vi.fn(),
  hangUp: vi.fn(),
  dismiss: vi.fn(),
});

/** Every expansion asked for, each answered only when the test says so. */
const asked: { firmId: string; answer: () => void }[] = [];

function Harness({ call }: { readonly call: CallControl }): JSX.Element {
  const [state, setState] = useState<TodayState>(initial);
  const memory = useTodayMemory();
  const actions = {
    busy: () => false,
    dial: vi.fn(),
    expand: (firmId: string) => {
      asked.push({ firmId, answer: () => setState(current => ({ ...current, expanded: expandedFor(firmId) })) });
    },
  } as unknown as TodayActions;
  const today: Today = {
    state,
    pending: 0,
    commands: 0,
    refreshAnswered: true,
    now: Date.parse('2026-10-01T14:00:00.000Z'),
    refresh: vi.fn(),
    actions,
    autoRefresh: vi.fn(),
  };
  return (
    <TodayWorkspace
      home={home}
      today={today}
      todayView={buildTodayView(state)}
      call={call}
      memory={memory}
      hasTodayBridge
      onRefresh={vi.fn()}
      onConnectMailbox={vi.fn()}
    />
  );
}

const MESSAGE = '55555555-5555-4555-8555-555555555555';
const read: TodayActionsV2Response = { promiseCoverage:{scope:"current_authorized_work",truncated:false,nextAfterId:null},version: 2, workspaceId: A, businessTimeZone: 'America/Chicago', asOf: '2026-10-01T14:00:00.000Z', actions: [{ actionId: `reply-message:${MESSAGE}`, kind: 'reply', subject: 'Elm Fork Test Rentals', reason: 'substantive_reply', dueAt: '2026-09-30T14:00:00.000Z', state: 'overdue', target: { kind: 'reply', firmId: A, messageId: MESSAGE } }] };
let currentRead: TodayActionsV2Response | null;
let currentTarget: typeof read.actions[number]['target'] | null;
const navigated = vi.fn();
beforeEach(() => {
  currentRead = read;
  currentTarget = read.actions[0]!.target;
  setNavigator(navigated, () => undefined);
  navigated.mockClear();
  globalThis.callieApi = {
    read: async (operation: string) => operation === 'today.actionsV2' ? currentRead
      : operation === 'today.openActionV2' ? { version: 2, target: currentTarget }
      : operation === 'recordings.recoveries' ? { items: [], truncated: false }
      : operation === 'calling.status' ? { provider: 'twilio', cadence: { unansweredAttempts: 0, nextAttempt: 1, limit: 4, parked: false, refusal: null } }
      : { calls: [] },
    command: async () => { throw new Error('Action navigation never sends a command'); },
  } as unknown as OperationApi;
});
afterEach(() => { globalThis.callieApi = undefined; });
function show() {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><DraftsProvider><Harness call={callOf({ phase: 'idle' })} /></DraftsProvider></QueryClientProvider>);
}
it('opens the exact current overdue reply from Today without resolving it', async () => {
  show();
  fireEvent.click(await screen.findByRole('button', { name: /Open reply/ }));
  await vi.waitFor(() => expect(navigated).toHaveBeenCalledWith({ name: 'replies', messageId: MESSAGE }));
  expect(screen.getByText('Overdue reply')).toBeTruthy();
});

it('describes uncertain mail as reply review rather than a substantive reply', async () => {
  currentRead = { ...read, actions: read.actions.map(action => action.kind==='reply'?({ ...action, state: 'open', reason: 'reply_review' }):action) };
  show();
  expect(await screen.findByText('Reply needs review')).toBeTruthy();
  expect(screen.queryByText('Substantive reply')).toBeNull();
});

it('drops a resolved or stale action when the current open read refuses its old target', async () => {
  show();
  const button = await screen.findByRole('button', { name: /Open reply/ });
  currentTarget = null;
  currentRead = { ...read, actions: [] };
  fireEvent.click(button);
  expect(await screen.findByText('No actions need you.')).toBeTruthy();
  expect(navigated).not.toHaveBeenCalled();
  expect(screen.getByRole('status').textContent).toContain('This action changed');
});
it('distinguishes unavailable actions from an empty current queue', async () => {
  currentRead = null;
  show();
  expect(await screen.findByText(/Actions are unavailable/)).toBeTruthy();
  expect(screen.queryByText('No actions need you.')).toBeNull();
});
it('opens the exact booked meeting from Today', async () => {
  const meetingId = '66666666-6666-4666-8666-666666666666';
  const target = { kind: 'meeting' as const, firmId: A, meetingId, startsAt: '2026-10-02T14:00:00.000Z' };
  currentRead = { ...read, actions: [{ actionId: `meeting:${meetingId}`, kind: 'call', subject: 'Elm Fork Test Rentals', reason: 'upcoming_call', dueAt: target.startsAt, state: 'open', target }] };
  currentTarget = target;
  show();
  fireEvent.click(await screen.findByRole('button', { name: 'Open call' }));
  await vi.waitFor(() => expect(navigated).toHaveBeenCalledWith({ name: 'firm', firmId: A, meetingId }));
});
it('opens settings with the mailbox that actually needs reconnecting', async () => {
  const mailboxId = '66666666-6666-4666-8666-666666666666';
  const target = { kind: 'settings' as const, tab: 'administration' as const, section: 'sending-admin' as const, mailboxId };
  currentRead = { ...read, actions: [{ actionId: `mailbox:${mailboxId}:1:revoked`, kind: 'problem', subject: 'Mailbox needs reconnecting', reason: 'mailbox_disconnected', dueAt: read.asOf, state: 'open', target }] };
  currentTarget = target;
  show();
  fireEvent.click(await screen.findByRole('button', { name: 'Open settings' }));
  await vi.waitFor(() => expect(navigated).toHaveBeenCalledWith({ name: 'settings', tab: 'administration', section: 'sending-admin', mailboxId }));
});
