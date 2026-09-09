// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { LinkedInApi } from '../../../shared/contracts/linkedInContract';
import { linkedInFixture } from '../today/nativeDesk.fixture';
import { LinkedInStep } from './LinkedInStep';
afterEach(cleanup);
it('manual begin/copy/open never records sent and outcome requires explicit selection', async () => {
  const item = linkedInFixture();
  const receipt = {
    commandId: '11111111-1111-4111-8111-111111111111',
    status: 'applied' as const,
    authorityGeneration: 1,
    aggregateVersion: 2,
    reason: null as null,
  };
  const api: LinkedInApi = {
    prepare: vi.fn(),
    get: vi.fn(),
    recover: vi.fn(async () => ({
      ...item.recovery,
      started: true,
      handoffId: 'handoff',
    })),
    save: vi.fn(),
    begin: vi.fn(async () => ({
      draftId: item.draft.id,
      revision: 1,
      receipt,
      handoffId: 'handoff',
      status: 'started' as const,
    })),
    open: vi.fn(async () => ({
      draftId: item.draft.id,
      revision: 1,
      status: 'opened' as const,
    })),
    copy: vi.fn(async () => ({
      draftId: item.draft.id,
      revision: 1,
      status: 'copied' as const,
    })),
    reportOutcome: vi.fn(async () => ({
      draftId: item.draft.id,
      revision: 1,
      receipt,
    })),
  };
  render(<LinkedInStep item={item} api={api} workspaceId="ws" />);
  expect(api.get).not.toHaveBeenCalled();
  expect(api.prepare).not.toHaveBeenCalled();
  expect(
    (
      screen.getByRole('button', {
        name: 'Record outcome',
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Begin manual step' }));
  await waitFor(() => expect(api.begin).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name: 'Copy note' }));
  await waitFor(() => expect(api.copy).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name: 'Open LinkedIn' }));
  await waitFor(() => expect(api.open).toHaveBeenCalledTimes(1));
  expect(api.reportOutcome).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Manual outcome'), {
    target: { value: 'not_sent' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Record outcome' }));
  await waitFor(() =>
    expect(api.reportOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'not_sent',
        draftId: item.draft.id,
        expectedRevision: 1,
      }),
    ),
  );
});
it('pending begin remains honest and never enables report', async () => {
  const item = linkedInFixture();
  const api = {
    begin: vi.fn(async () => ({
      draftId: item.draft.id,
      revision: 1,
      receipt: {
        commandId: 'id',
        status: 'pending',
        authorityGeneration: 1,
        aggregateVersion: 1,
        reason: null as null,
      },
      handoffId: null,
      status: 'pending',
    })),
  } as unknown as LinkedInApi;
  render(<LinkedInStep item={item} api={api} workspaceId="ws" />);
  fireEvent.click(screen.getByRole('button', { name: 'Begin manual step' }));
  await screen.findByText(/Owner approval pending/);
  fireEvent.change(screen.getByLabelText('Manual outcome'), {
    target: { value: 'human_reported_sent' },
  });
  expect(
    (
      screen.getByRole('button', {
        name: 'Record outcome',
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});
it('preserves note, selected outcome and reply text through close/reopen', () => {
  const item = linkedInFixture();
  const api = { get: vi.fn(), prepare: vi.fn() } as unknown as LinkedInApi;
  const view = render(<LinkedInStep item={item} api={api} workspaceId="ws" />);
  fireEvent.change(screen.getByLabelText('LinkedIn note'), {
    target: { value: 'Local note' },
  });
  fireEvent.change(screen.getByLabelText('Manual outcome'), {
    target: { value: 'reply' },
  });
  fireEvent.change(screen.getByLabelText('Reply text'), {
    target: { value: 'Observed reply' },
  });
  view.unmount();
  render(<LinkedInStep item={item} api={api} workspaceId="ws" />);
  expect(
    (screen.getByLabelText('LinkedIn note') as HTMLTextAreaElement).value,
  ).toBe('Local note');
  expect(
    (screen.getByLabelText('Manual outcome') as HTMLSelectElement).value,
  ).toBe('reply');
  expect(
    (screen.getByLabelText('Reply text') as HTMLTextAreaElement).value,
  ).toBe('Observed reply');
});
it('same-revision held state from daily snapshot blocks helpers', () => {
  const item = linkedInFixture();
  const api = {} as LinkedInApi;
  const view = render(<LinkedInStep item={item} api={api} workspaceId="ws" />);
  view.rerender(
    <LinkedInStep
      item={{ ...item, draft: { ...item.draft, state: 'held' } }}
      api={api}
      workspaceId="ws"
    />,
  );
  expect(
    (screen.getByRole('button', { name: 'Open LinkedIn' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});
it('reviews a newer saved LinkedIn revision without overwriting retained edits', () => {
  const item = linkedInFixture(),
    api = {} as LinkedInApi;
  const view = render(<LinkedInStep item={item} api={api} workspaceId="ws" />);
  fireEvent.change(screen.getByLabelText('LinkedIn note'), {
    target: { value: 'My local draft' },
  });
  const next = {
    ...item,
    draft: { ...item.draft, revision: 2, body: 'New saved version' },
    recovery: { ...item.recovery, revision: 2 },
  };
  view.rerender(<LinkedInStep item={next} api={api} workspaceId="ws" />);
  expect(
    (screen.getByLabelText('LinkedIn note') as HTMLTextAreaElement).value,
  ).toBe('My local draft');
  fireEvent.click(
    screen.getByRole('button', { name: 'Use saved LinkedIn version' }),
  );
  expect(
    (screen.getByLabelText('LinkedIn note') as HTMLTextAreaElement).value,
  ).toBe('New saved version');
});
it('does not begin after a newer context arrives during explicit save', async () => {
  const item = linkedInFixture();
  let resolve!: (draft: typeof item.draft) => void;
  const api = {
    save: vi.fn(
      () =>
        new Promise<typeof item.draft>((r) => {
          resolve = r;
        }),
    ),
    begin: vi.fn(),
  } as unknown as LinkedInApi;
  const view = render(<LinkedInStep item={item} api={api} workspaceId="ws" />);
  fireEvent.change(screen.getByLabelText('LinkedIn note'), {
    target: { value: 'My note' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Begin manual step' }));
  view.rerender(
    <LinkedInStep
      item={{ ...item, draft: { ...item.draft, contextRevision: 2 } }}
      api={api}
      workspaceId="ws"
    />,
  );
  await act(async () =>
    resolve({ ...item.draft, revision: 2, body: 'My note' }),
  );
  expect(api.begin).not.toHaveBeenCalled();
});
it.each(['applied', 'rejected'] as const)(
  'offers explicit retained pending outcome retry to %s without mount replay',
  async (status) => {
    const item = linkedInFixture();
    item.recovery.started = true;
    const api = {
      reportOutcome: vi.fn(
        async (input: Parameters<LinkedInApi['reportOutcome']>[0]) => ({
          draftId: item.draft.id,
          revision: 1,
          receipt: {
            commandId: input.commandId,
            status: 'pending',
            authorityGeneration: 1,
            aggregateVersion: 1,
            reason: null,
          },
        }),
      ),
    } as unknown as LinkedInApi;
    const view = render(
      <LinkedInStep item={item} api={api} workspaceId="ws" />,
    );
    fireEvent.change(screen.getByLabelText('Manual outcome'), {
      target: { value: 'not_sent' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Record outcome' }));
    await screen.findByText('Human outcome receipt: pending.');
    const original = vi.mocked(api.reportOutcome).mock.calls[0]![0];
    view.unmount();
    render(<LinkedInStep item={item} api={api} workspaceId="ws" />);
    expect(api.reportOutcome).toHaveBeenCalledTimes(1);
    vi.mocked(api.reportOutcome).mockResolvedValueOnce({
      draftId: item.draft.id,
      revision: 1,
      receipt: {
        commandId: original.commandId,
        status,
        authorityGeneration: 1,
        aggregateVersion: 2,
        reason: null,
      },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Retry retained outcome' }),
    );
    await screen.findByText(`Human outcome receipt: ${status}.`);
    expect(vi.mocked(api.reportOutcome).mock.calls[1]![0]).toEqual(original);
    expect(
      (
        screen.getByRole('button', {
          name: 'Record outcome',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  },
);
