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
import { firstUseFixture, dailyFixture, nativeDeskFixture, nativeDeskReviewFixture } from './nativeDesk.fixture';
import { createCallCampaignDraft, createLinkedInCampaignDraft } from '../../../shared/contracts/callCampaignDraft';
import type { DailySnapshot } from '../../../shared/contracts/dailyContract';
import type { Enrollment } from '../../../shared/contracts/campaignContract';
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
    render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} />);
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
    render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} />);
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
    const view = render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Email · Account B' }),
    );
    fireEvent.change(screen.getByLabelText('Email body'), {
      target: { value: 'Unsent local B' },
    });
    view.unmount();
    render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} />);
    expect(
      ((await screen.findByLabelText('Email body')) as HTMLTextAreaElement)
        .value,
    ).toBe('Unsent local B');
    expect(f.forbidden).not.toHaveBeenCalled();
  });
  it('keyboard navigation ignores modifiers and typing, Enter opens details and Escape closes', async () => {
    const f = fixtureApi();
    render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} />);
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
    render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} />);
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
  it('fails closed on changed workspace and holds worker actions for stored legacy mode without a legacy queue', async () => {
    const f = fixtureApi(dailyFixture({ workflowMode: 'legacy' }));
    const view = render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} />);
    await screen.findByText(/Legacy workflow is active/);
    expect(screen.queryByTestId('native-desk')).toBeNull();
    expect(screen.queryByTestId('today-route')).toBeNull();
    view.unmount();
    f.set(dailyFixture({ workflowMode: 'unknown' }));
    render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} />);
    await screen.findByText(/Workflow mode unavailable/);
    expect(screen.queryByText(/Legacy workflow is active/)).toBeNull();
  });
  it('shows account evidence, company-only call hold, empty lanes and frozen campaign holds', async () => {
    const f = fixtureApi(dailyFixture({ answers: [] }));
    render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} />);
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
  render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} />);
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
  render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} />);
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
  render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} />);
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
  render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} />);
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
  render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} />);
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
    render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} />);
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
  const view = render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} />);
  fireEvent.click(
    await screen.findByRole('button', { name: 'Email · Account A' }),
  );
  fireEvent.change(screen.getByLabelText('Email body'), {
    target: { value: 'Keep but do not send' },
  });
  view.unmount();
  render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} />);
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
    render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} />);
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
  const view = render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} />);
  fireEvent.click(
    await screen.findByRole('button', { name: 'Email · Account A' }),
  );
  fireEvent.change(screen.getByLabelText('Email body'), {
    target: { value: 'Retain paused text' },
  });
  view.unmount();
  f.setConfiguration(active);
  render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} />);
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

it('names the selected one-company campaign by its channel in the route-owned header and detail bar', async () => {
  const offer = 'Discuss a simpler maintenance follow-up workflow.';
  const linkedIn = createLinkedInCampaignDraft({ campaignId: 'LinkedIn campaign', versionId: 'li-version', stepId: 'li-step', accountId: 'a', offer });
  const call = createCallCampaignDraft({ campaignId: 'Call campaign', versionId: 'call-version', stepId: 'call-step', accountId: 'a', offer });
  const entry = (version: DailySnapshot['campaigns'][number]['version']): DailySnapshot['campaigns'][number] => ({ version, snapshotHash: 'a'.repeat(64), caps: [], enrollments: [] });
  const f = nativeDeskFixture(dailyFixture({ campaigns: [entry(linkedIn), entry({ ...linkedIn, id: 'li-approved', approvedAt: '2026-09-09T12:00:00.000Z' }), entry(call), ...nativeDeskReviewFixture().campaigns] }));
  const view = render(<NativeDeskRoute surface="campaigns" firstUse={f.firstUse} api={f.api} />);
  const header = await screen.findByText(/Review and enrollment are separate explicit actions/);
  const row = (id: string) => view.container.querySelector<HTMLButtonElement>(`[data-row-key="campaign:${id}"]`)!;
  const bar = () => view.container.querySelector('.native-desk__detail-bar span')?.textContent;
  fireEvent.click(row('li-version'));
  expect(bar()).toBe('Saved LinkedIn campaign draft');
  expect(header.textContent).toBe('Save an unapproved LinkedIn campaign draft for one worker-owned company. Review and enrollment are separate explicit actions. Neither sends a LinkedIn note.');
  fireEvent.click(row('li-approved'));
  expect(bar()).toBe('Reviewed LinkedIn campaign');
  // The exact call template keeps its existing labels.
  fireEvent.click(row('call-version'));
  expect(bar()).toBe('Saved call campaign draft');
  expect(header.textContent).toBe('Save an unapproved call campaign draft for one worker-owned company. Review and enrollment are separate explicit actions. Neither places a call.');
  // Anything other than the two exact templates stays an opaque read-only preview, and the surface names both templates.
  const both = 'Save an unapproved call campaign draft for one worker-owned company, or a LinkedIn campaign draft. Review and enrollment are separate explicit actions. Neither places a call or sends a LinkedIn note.';
  fireEvent.click(row('version'));
  expect(bar()).toBe('Read-only campaign preview');
  expect(header.textContent).toBe(both);
  fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
  expect(bar()).toBeUndefined();
  expect(header.textContent).toBe(both);
  expect(f.calls.some((c) => c.method === 'forbidden')).toBe(false);
});

it('lists saved one-company campaigns by company, channel and plain state, and explains an empty route dropdown on the real route', async () => {
  const offer = 'Discuss a simpler maintenance follow-up workflow.';
  const approvedAt = '2026-09-09T12:00:00.000Z';
  const call = createCallCampaignDraft({ campaignId: '4b1f0d6e-0000-4000-8000-000000000001', versionId: 'call-version', stepId: 'call-step', accountId: 'a', offer });
  const linkedIn = createLinkedInCampaignDraft({ campaignId: '4b1f0d6e-0000-4000-8000-000000000002', versionId: 'li-version', stepId: 'li-step', accountId: 'b', offer });
  const enrollment: Enrollment = { id: 'enrollment', accountId: 'a', selectedRouteId: 'phone', selectedRouteVersion: 1, personId: null, campaignVersionId: 'call-enrolled',
    currentStepId: 'call-step', version: 1, state: 'held', executionContextId: 'context', contextRevision: 1, startedAt: approvedAt };
  const entry = (version: DailySnapshot['campaigns'][number]['version'], enrollments: Enrollment[] = []): DailySnapshot['campaigns'][number] => ({ version, snapshotHash: 'a'.repeat(64), caps: [], enrollments });
  // Account a has no route at all on the worker's copy of its record, so the enrollment dropdown is empty.
  const f = nativeDeskFixture(dailyFixture({ campaigns: [entry(call), entry({ ...call, id: 'call-approved', approvedAt }), entry({ ...call, id: 'call-enrolled', approvedAt }, [enrollment]), entry(linkedIn), ...nativeDeskReviewFixture().campaigns] }));
  const view = render(<NativeDeskRoute surface="campaigns" firstUse={f.firstUse} api={f.api} />);
  await screen.findByText(/Review and enrollment are separate explicit actions/);
  const row = (id: string) => view.container.querySelector<HTMLButtonElement>(`[data-row-key="campaign:${id}"]`)!;
  const label = (id: string) => [row(id).querySelector('strong')?.textContent, row(id).querySelector('span')?.textContent];
  expect(label('call-version')).toEqual(['Account A · Call campaign', 'Version 1 · Draft']);
  expect(label('call-approved')).toEqual(['Account A · Call campaign', 'Version 1 · Approved']);
  expect(label('call-enrolled')).toEqual(['Account A · Call campaign', 'Version 1 · Enrolled']);
  expect(label('li-version')).toEqual(['Account B · LinkedIn campaign', 'Version 1 · Draft']);
  // Anything other than the two exact templates keeps its saved id and recorded approval state; the browser oracle asserts both.
  expect(label('version')).toEqual(['Fixture campaign', 'Version 1 · not approved']);
  expect(screen.queryByText(call.campaignId)).toBeNull();
  fireEvent.click(row('call-approved'));
  const select = screen.getByLabelText<HTMLSelectElement>('Business phone route');
  expect([...select.options].map((option) => option.text)).toEqual(['Select a business phone route']);
  const status = screen.getByText('No published business phone route is saved for this company on the worker\'s copy of its record. On Accounts, open the company and use "Review phone route" to confirm the number from a saved source, then on Campaigns use "Send updated saved record to worker". Enrollment stays unavailable until then.');
  expect(status.getAttribute('role')).toBe('status');
  expect(f.calls.some((c) => c.method === 'forbidden')).toBe(false);
});

const render = (ui: Parameters<typeof testingRender>[0], options?: Parameters<typeof testingRender>[1]) => testingRender(ui, { wrapper: PresentationRoot, ...options });

Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.open = true; } });
Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.open = false; } });
