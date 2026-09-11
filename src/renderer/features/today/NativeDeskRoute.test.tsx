import { PresentationRoot } from '../../app/PresentationRoot';
// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render as testingRender,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeDeskRoute, type NativeDeskApi } from './NativeDeskRoute';
import { firstUseFixture, dailyFixture, nativeDeskFixture } from './nativeDesk.fixture';
import type { DailySnapshot } from '../../../shared/contracts/dailyContract';
afterEach(cleanup);
function fixtureApi(initial = dailyFixture()) {
  let snapshot = initial;
  const forbidden = vi.fn(async () => {
    throw Error('Unexpected command');
  });
  const api = {
    daily: { get: vi.fn(async () => structuredClone(snapshot)) },
    delegation: {
      status: vi.fn(async () => ({
        state: 'paused',
        workspaceId: 'ws',
        endpoint: null,
        configuration: null,
      })),
      getRequestedFollowup: forbidden,
      editRequestedFollowup: forbidden,
      approveRequestedFollowup: forbidden,
    },
    linkedin: {
      prepare: forbidden,
      get: forbidden,
      recover: forbidden,
      save: forbidden,
      begin: forbidden,
      copy: forbidden,
      open: forbidden,
      reportOutcome: forbidden,
    },
  } as unknown as NativeDeskApi;
  return {
    api,
    firstUse: firstUseFixture(),
    forbidden,
    set: (next: DailySnapshot) => {
      snapshot = next;
    },
  };
}
describe('Native Desk actual route', () => {
  it('mount, selection, focus and refresh only read local snapshots/configuration', async () => {
    const f = fixtureApi();
    render(<NativeDeskRoute onOpenImport={(): void => undefined} firstUse={f.firstUse} api={f.api} onOpenLead={vi.fn()} />);
    await screen.findByRole('heading', { name: /^Calls/ });
    fireEvent.click(screen.getByRole('button', { name: 'Email · Account A' }));
    expect(
      (screen.getByLabelText('Email body') as HTMLTextAreaElement).value,
    ).toBe('Saved note for a');
    fireEvent.focus(window);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(f.api.daily.get).toHaveBeenCalledTimes(3));
    expect(f.forbidden).not.toHaveBeenCalled();
    expect(screen.getByText(/Remote freshness unknown/)).toBeTruthy();
    expect(
      (
        screen.getByRole('button', {
          name: 'Approve email',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
  it('retains editor DOM, caret and selection across refresh and failed reads', async () => {
    const f = fixtureApi();
    render(<NativeDeskRoute onOpenImport={(): void => undefined} firstUse={f.firstUse} api={f.api} onOpenLead={vi.fn()} />);
    await screen.findByRole('button', { name: 'Email · Account A' });
    fireEvent.click(screen.getByRole('button', { name: 'Email · Account A' }));
    const editor = screen.getByLabelText('Email body') as HTMLTextAreaElement;
    editor.focus();
    fireEvent.change(editor, { target: { value: 'Local edit' } });
    editor.setSelectionRange(3, 3);
    fireEvent.focus(window);
    await waitFor(() => expect(f.api.daily.get).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText('Email body')).toBe(editor);
    expect(editor.selectionStart).toBe(3);
    expect(document.activeElement).toBe(editor);
    vi.mocked(f.api.daily.get).mockRejectedValueOnce(Error('offline'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await screen.findByText(/Refresh unavailable. Your current view/);
    expect(editor.value).toBe('Local edit');
    fireEvent.click(screen.getByRole('button', { name: 'Email · Account B' }));
    fireEvent.click(screen.getByRole('button', { name: 'Email · Account A' }));
    expect(
      (screen.getByLabelText('Email body') as HTMLTextAreaElement).value,
    ).toBe('Local edit');
  });
  it('preserves sessions and selected row across route close/reopen without commands', async () => {
    const f = fixtureApi();
    const view = render(<NativeDeskRoute onOpenImport={(): void => undefined} firstUse={f.firstUse} api={f.api} onOpenLead={vi.fn()} />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Email · Account B' }),
    );
    fireEvent.change(screen.getByLabelText('Email body'), {
      target: { value: 'Unsent local B' },
    });
    view.unmount();
    render(<NativeDeskRoute onOpenImport={(): void => undefined} firstUse={f.firstUse} api={f.api} onOpenLead={vi.fn()} />);
    expect(
      ((await screen.findByLabelText('Email body')) as HTMLTextAreaElement)
        .value,
    ).toBe('Unsent local B');
    expect(f.forbidden).not.toHaveBeenCalled();
  });
  it('keyboard navigation ignores modifiers and typing, Enter opens details and Escape closes', async () => {
    const f = fixtureApi();
    render(<NativeDeskRoute onOpenImport={(): void => undefined} firstUse={f.firstUse} api={f.api} onOpenLead={vi.fn()} />);
    const call = await screen.findByRole('button', {
      name: 'Call · Account A',
    });
    call.focus();
    fireEvent.keyDown(call, { key: 'j', ctrlKey: true });
    expect(document.activeElement).toBe(call);
    fireEvent.keyDown(call, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Email · Account A' }),
    );
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    const editor = screen.getByLabelText('Email body');
    editor.focus();
    fireEvent.keyDown(editor, { key: 'j' });
    expect(document.activeElement).toBe(editor);
    fireEvent.keyDown(editor, { key: 'Escape' });
    expect(screen.queryByLabelText('Email body')).toBeNull();
    expect(f.forbidden).not.toHaveBeenCalled();
  });
  it('retains the selected draft on repeated or composing Escape and handled input', async () => {
    const f = fixtureApi();
    render(<NativeDeskRoute onOpenImport={(): void => undefined} firstUse={f.firstUse} api={f.api} onOpenLead={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Email · Account A' }));
    const editor = screen.getByLabelText('Email body');
    fireEvent.change(editor, { target: { value: 'Preserved draft' } });
    fireEvent.keyDown(editor, { key: 'Escape', repeat: true });
    fireEvent.keyDown(editor, { key: 'Escape', isComposing: true });
    const handled = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    handled.preventDefault(); fireEvent(editor, handled);
    expect(screen.getByLabelText('Email body')).toBe(editor);
    expect((editor as HTMLTextAreaElement).value).toBe('Preserved draft');
    fireEvent.keyDown(editor, { key: 'Escape' });
    expect(screen.queryByLabelText('Email body')).toBeNull();
  });
  it('fails closed on changed workspace and retains legacy only for stored legacy mode', async () => {
    const f = fixtureApi(dailyFixture({ workflowMode: 'legacy' }));
    const view = render(
      <NativeDeskRoute onOpenImport={(): void => undefined} firstUse={f.firstUse}
        api={f.api}
        onOpenLead={vi.fn()}
        legacy={<p>Legacy today</p>}
      />,
    );
    await screen.findByText('Legacy today');
    expect(screen.queryByText('Saved draft continuations')).toBeNull();
    view.unmount();
    f.set(dailyFixture({ workflowMode: 'unknown' }));
    render(
      <NativeDeskRoute onOpenImport={(): void => undefined} firstUse={f.firstUse}
        api={f.api}
        onOpenLead={vi.fn()}
        legacy={<p>Legacy today</p>}
      />,
    );
    await screen.findByText(/Workflow mode unavailable/);
    expect(screen.queryByText('Legacy today')).toBeNull();
  });
  it('shows account evidence, company-only call hold, empty lanes and frozen campaign holds', async () => {
    const f = fixtureApi(dailyFixture({ answers: [] }));
    render(<NativeDeskRoute onOpenImport={(): void => undefined} firstUse={f.firstUse} api={f.api} onOpenLead={vi.fn()} />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Call · Account A' }),
    );
    expect(screen.getByText('12 managed buildings')).toBeTruthy();
    expect(screen.getByText(/Hypothesis: Unconfirmed workflow/)).toBeTruthy();
    expect(screen.getByText(/Call handoff unavailable/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Saved draft continuations 0' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Upcoming meetings 0' })).toBeTruthy();
  });
});

it('does not autosave while local configuration is held', async () => {
  const f = fixtureApi();
  render(<NativeDeskRoute onOpenImport={(): void => undefined} firstUse={f.firstUse} api={f.api} onOpenLead={vi.fn()} />);
  fireEvent.click(
    await screen.findByRole('button', { name: 'Email · Account A' }),
  );
  fireEvent.change(screen.getByLabelText('Email body'), {
    target: { value: 'Retained offline edit' },
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 900));
  });
  expect(f.forbidden).not.toHaveBeenCalled();
  expect(
    (screen.getByLabelText('Email body') as HTMLTextAreaElement).value,
  ).toBe('Retained offline edit');
});

function ownedFixture() {
  const snapshot = dailyFixture();
  snapshot.ownerStatus = snapshot.accounts.map(
    (a): DailySnapshot['ownerStatus'][number] => ({
      accountId: a.account.id,
      authority: {
        accountId: a.account.id,
        owner: 'worker',
        generation: 1,
        state: 'active',
      },
      executionVersion: 1,
      pendingCommands: [],
      status: 'owner_applied',
    }),
  );
  return nativeDeskFixture(snapshot);
}
it('first explicit approval saves canonical content once and retains pending receipt through refresh', async () => {
  const f = ownedFixture();
  render(<NativeDeskRoute onOpenImport={(): void => undefined} firstUse={f.firstUse} api={f.api} onOpenLead={vi.fn()} />);
  fireEvent.click(
    await screen.findByRole('button', { name: 'Email · Account A' }),
  );
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.change(screen.getByLabelText('Approval expiry'), {
    target: { value: '2099-09-10T12:00' },
  });
  const button = screen.getByRole('button', { name: 'Approve email' });
  expect((button as HTMLButtonElement).disabled).toBe(false);
  fireEvent.change(screen.getByLabelText('Email body'), {
    target: { value: 'Explicitly approved edit' },
  });
  fireEvent.mouseDown(button);
  fireEvent.mouseUp(button);
  fireEvent.click(button);
  await screen.findByText(/Approval: pending preflight/);
  expect(
    f.calls.filter((c) => c.method === 'approveRequestedFollowup'),
  ).toHaveLength(1);
  const command = f.calls.find((c) => c.method === 'approveRequestedFollowup')!
    .input as {
    draft: { revision: number; body: string };
    expectedRemoteDraftRevision: number;
  };
  expect(command.expectedRemoteDraftRevision).toBe(2);
  expect(command.draft.body).toBe('Explicitly approved edit');
  fireEvent.focus(window);
  await waitFor(() =>
    expect(f.calls.filter((c) => c.method === 'daily.get')).toHaveLength(2),
  );
  expect(
    f.calls.filter((c) => c.method === 'approveRequestedFollowup'),
  ).toHaveLength(1);
  expect(screen.getByRole('button', { name: 'Approve email' })).toBe(button);
});
it('scope change cancels old-session delayed save without losing its local text', async () => {
  const f = ownedFixture();
  render(<NativeDeskRoute onOpenImport={(): void => undefined} firstUse={f.firstUse} api={f.api} onOpenLead={vi.fn()} />);
  fireEvent.click(
    await screen.findByRole('button', { name: 'Email · Account A' }),
  );
  fireEvent.change(screen.getByLabelText('Email body'), {
    target: { value: 'Old scope only' },
  });
  f.setSnapshot(dailyFixture({ workspaceId: 'other' }));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(screen.queryByLabelText('Email body')).toBeNull());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 900));
  });
  expect(
    f.calls.filter((c) => c.method === 'editRequestedFollowup'),
  ).toHaveLength(0);
  f.setSnapshot(dailyFixture());
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(
    ((await screen.findByLabelText('Email body')) as HTMLTextAreaElement).value,
  ).toBe('Old scope only');
});
it('changed recipient keeps local text and disables approval until explicit review', async () => {
  const f = ownedFixture();
  render(<NativeDeskRoute onOpenImport={(): void => undefined} firstUse={f.firstUse} api={f.api} onOpenLead={vi.fn()} />);
  fireEvent.click(
    await screen.findByRole('button', { name: 'Email · Account A' }),
  );
  fireEvent.change(screen.getByLabelText('Email body'), {
    target: { value: 'Local private text' },
  });
  const next = f.snapshot();
  const answer = next.answers[0];
  if (answer.kind !== 'requested_followup') throw Error('fixture');
  answer.draft = {
    ...answer.draft,
    recipient: 'new@fixture.invalid',
    recipientBinding: {
      ...answer.draft.recipientBinding,
      email: 'new@fixture.invalid',
    },
  };
  f.setSnapshot(next);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await screen.findByText(/Recipient or context changed/);
  expect(
    (screen.getByLabelText('Email body') as HTMLTextAreaElement).value,
  ).toBe('Local private text');
  expect(
    (screen.getByRole('button', { name: 'Approve email' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 900));
  });
  expect(
    f.calls.filter((c) => c.method === 'editRequestedFollowup'),
  ).toHaveLength(0);
});

it('holds a saved requested draft when account context advances independently', async () => {
  const f = ownedFixture();
  const next = f.snapshot();
  next.accounts[0].account.version = 2;
  f.setSnapshot(next);
  render(<NativeDeskRoute onOpenImport={(): void => undefined} firstUse={f.firstUse} api={f.api} onOpenLead={vi.fn()} />);
  fireEvent.click(
    await screen.findByRole('button', { name: 'Email · Account A' }),
  );
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.change(screen.getByLabelText('Approval expiry'), {
    target: { value: '2099-09-10T12:00' },
  });
  expect(
    (screen.getByRole('button', { name: 'Approve email' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(screen.getByText(/Account context changed/)).toBeTruthy();
});

it.each(['configuration', 'account'] as const)(
  'holds offscreen edited account after %s refresh',
  async (kind) => {
    const f = ownedFixture();
    render(<NativeDeskRoute onOpenImport={(): void => undefined} firstUse={f.firstUse} api={f.api} onOpenLead={vi.fn()} />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Email · Account A' }),
    );
    fireEvent.change(screen.getByLabelText('Email body'), {
      target: { value: 'Offscreen edit' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Email · Account B' }));
    if (kind === 'configuration') {
      const config = await f.api.delegation.status();
      f.setConfiguration({ ...config, state: 'paused' } as typeof config);
    } else {
      const snapshot = structuredClone(f.snapshot());
      snapshot.accounts[0]!.account.version++;
      f.setSnapshot(snapshot);
    }
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 900));
    });
    expect(
      f.calls.filter((c) => c.method === 'editRequestedFollowup'),
    ).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Email · Account A' }));
    expect(
      (screen.getByLabelText('Email body') as HTMLTextAreaElement).value,
    ).toBe('Offscreen edit');
  },
);
it('teardown cancels delayed edits even when the same workspace immediately reopens', async () => {
  const f = ownedFixture();
  const view = render(<NativeDeskRoute onOpenImport={(): void => undefined} firstUse={f.firstUse} api={f.api} onOpenLead={vi.fn()} />);
  fireEvent.click(
    await screen.findByRole('button', { name: 'Email · Account A' }),
  );
  fireEvent.change(screen.getByLabelText('Email body'), {
    target: { value: 'Keep but do not send' },
  });
  view.unmount();
  render(<NativeDeskRoute onOpenImport={(): void => undefined} firstUse={f.firstUse} api={f.api} onOpenLead={vi.fn()} />);
  await screen.findByRole('button', { name: 'Email · Account A' });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 900));
  });
  expect(
    f.calls.filter((c) => c.method === 'editRequestedFollowup'),
  ).toHaveLength(0);
});
it.each(['active', 'paused', 'authority'] as const)(
  'accepting saved email recomputes its hold while preserving %s conditions',
  async (condition) => {
    const f = ownedFixture();
    render(<NativeDeskRoute onOpenImport={(): void => undefined} firstUse={f.firstUse} api={f.api} onOpenLead={vi.fn()} />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Email · Account A' }),
    );
    const next = structuredClone(f.snapshot());
    const answer = next.answers.find(
      (a) => a.kind === 'requested_followup' && a.accountId === 'a',
    )!;
    if (answer.kind !== 'requested_followup') throw Error('fixture');
    answer.draft = {
      ...answer.draft,
      revision: 2,
      body: 'Accepted saved body',
    };
    if (condition === 'authority') next.ownerStatus[0]!.authority = null;
    if (condition === 'paused') {
      const config = await f.api.delegation.status();
      f.setConfiguration({ ...config, state: 'paused' } as typeof config);
    }
    f.setSnapshot(next);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Use saved version and discard displayed edits',
      }),
    );
    expect(
      (screen.getByLabelText('Email body') as HTMLTextAreaElement).value,
    ).toBe('Accepted saved body');
    const preflight = screen.getByRole('button', {
      name: 'Owner preflight',
    }) as HTMLButtonElement;
    expect(preflight.disabled).toBe(condition !== 'active');
    fireEvent.click(preflight);
    if (condition === 'active')
      await waitFor(() =>
        expect(
          f.calls.filter((c) => c.method === 'getRequestedFollowup'),
        ).toHaveLength(1),
      );
    else
      expect(
        f.calls.filter((c) => c.method === 'getRequestedFollowup'),
      ).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('Email body'), {
      target: { value: 'Explicit edit after acceptance' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save edits' }));
    if (condition === 'active')
      await waitFor(() =>
        expect(
          f.calls.filter((c) => c.method === 'editRequestedFollowup'),
        ).toHaveLength(1),
      );
    else
      expect(
        f.calls.filter((c) => c.method === 'editRequestedFollowup'),
      ).toHaveLength(0);
  },
);
it('already-paused edit does not autosave after teardown and active same-workspace remount', async () => {
  const f = ownedFixture();
  const active = await f.api.delegation.status();
  f.setConfiguration({ ...active, state: 'paused' } as typeof active);
  const view = render(<NativeDeskRoute onOpenImport={(): void => undefined} firstUse={f.firstUse} api={f.api} onOpenLead={vi.fn()} />);
  fireEvent.click(
    await screen.findByRole('button', { name: 'Email · Account A' }),
  );
  fireEvent.change(screen.getByLabelText('Email body'), {
    target: { value: 'Retain paused text' },
  });
  view.unmount();
  f.setConfiguration(active);
  render(<NativeDeskRoute onOpenImport={(): void => undefined} firstUse={f.firstUse} api={f.api} onOpenLead={vi.fn()} />);
  await screen.findByLabelText('Email body');
  await act(async () => {
    await new Promise((r) => setTimeout(r, 900));
  });
  expect(
    f.calls.filter((c) => c.method === 'editRequestedFollowup'),
  ).toHaveLength(0);
  expect(
    (screen.getByLabelText('Email body') as HTMLTextAreaElement).value,
  ).toBe('Retain paused text');
  fireEvent.click(screen.getByRole('button', { name: 'Save edits' }));
  await waitFor(() =>
    expect(
      f.calls.filter((c) => c.method === 'editRequestedFollowup'),
    ).toHaveLength(1),
  );
});

const render = (ui: Parameters<typeof testingRender>[0], options?: Parameters<typeof testingRender>[1]) => testingRender(ui, { wrapper: PresentationRoot, ...options });

Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.open = true; } });
Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.open = false; } });
