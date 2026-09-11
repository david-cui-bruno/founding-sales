// @vitest-environment jsdom

import { cleanup, act, fireEvent, render as testingRender, screen, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MutationReceipt } from '../../src/shared/contracts/commonContract';
import type {
  ConversationDetail,
  ConversationRow,
} from '../../src/shared/contracts/conversationsContract';
import {
  ConversationsRoute,
  type ConversationsApi,
} from '../../src/renderer/features/conversations/ConversationsRoute';

import { PresentationRoot } from '../../src/renderer/app/PresentationRoot';
const render = (ui: Parameters<typeof testingRender>[0], options?: Parameters<typeof testingRender>[1]) => testingRender(ui, { wrapper: PresentationRoot, ...options });
Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.open = true; } });
Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.open = false; } });

afterEach(() => {
  cleanup();
});

const callRow: ConversationRow = {
  activityId: 'activity-call',
  personId: 'person-kevin',
  salesCycleId: 'cycle-kevin',
  personName: 'Kevin Landlord',
  kind: 'call',
  direction: 'outbound',
  occurredAt: '2026-08-30T12:00:00.000Z',
  durationSeconds: 480,
  recordingAvailable: false,
  transcriptAvailable: false,
  summary: 'Discovery call about weekend showings.',
};

const voicemailRow: ConversationRow = {
  activityId: 'activity-voicemail',
  personId: 'person-maya',
  salesCycleId: null,
  personName: 'Maya Owner',
  kind: 'voicemail',
  direction: 'inbound',
  occurredAt: '2026-08-29T09:30:00.000Z',
  durationSeconds: null,
  recordingAvailable: true,
  transcriptAvailable: true,
  summary: null,
};

const callDetail: ConversationDetail = { ...callRow, transcript: null };

const voicemailDetail: ConversationDetail = {
  ...voicemailRow,
  transcript: {
    transcriptId: 'transcript-1',
    source: 'manual_paste',
    createdAt: '2026-08-29T10:00:00.000Z',
    utterances: [
      { id: 'utterance-1', sequence: 0, speaker: 'founder', text: 'Hi, this is the founder.' },
      { id: 'utterance-2', sequence: 1, speaker: 'lead', text: 'Please call me back.' },
      { id: 'utterance-3', sequence: 2, speaker: 'unknown', text: '[beep]' },
    ],
  },
};

const receipt: MutationReceipt = {
  revision: 9,
  affectedPersonIds: ['person-kevin'],
  affectedSalesCycleIds: ['cycle-kevin'],
};

function createApi(overrides: Partial<ConversationsApi> = {}): ConversationsApi {
  return {
    list: vi.fn().mockResolvedValue({
      rows: [callRow, voicemailRow], total: 2, nextCursor: null, revision: 4,
    }),
    get: vi.fn().mockImplementation((request: { activityId: string }) =>
      Promise.resolve(
        request.activityId === 'activity-call' ? callDetail : voicemailDetail,
      )),
    attachTranscript: vi.fn().mockResolvedValue(receipt),
    ...overrides,
  };
}

async function renderRoute(
  api: ConversationsApi,
  onOpenLead: (personId: string) => void = vi.fn(),
) {
  render(<ConversationsRoute api={api} onOpenLead={onOpenLead} />);
  await screen.findByText('Kevin Landlord');
}

async function openCallDetail() {
  fireEvent.click(screen.getByRole('button', { name: /Kevin Landlord/ }));
  const detail = await screen.findByRole('region', { name: 'Conversation detail' });
  await within(detail).findByText('Kevin Landlord');
  return detail;
}

describe('ConversationsRoute', () => {
  it('renders the conversation list with availability pills', async () => {
    const api = createApi();
    await renderRoute(api);

    expect(api.list).toHaveBeenCalledWith(
      expect.objectContaining({ query: '', filter: 'all', cursor: null }),
    );
    expect(screen.getByText('Maya Owner')).toBeDefined();
    const voicemailButton = screen.getByRole('button', { name: /Maya Owner/ });
    expect(within(voicemailButton).getByText('Transcript')).toBeDefined();
    expect(within(voicemailButton).getByText('Recording')).toBeDefined();
    const callButton = screen.getByRole('button', { name: /Kevin Landlord/ });
    expect(within(callButton).queryByText('Transcript')).toBeNull();
  });

  it('carries no filter chips: search is the only list control', async () => {
    const api = createApi();
    await renderRoute(api);

    expect(screen.queryByRole('button', { name: 'With transcript' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'With recording' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Filter conversations' })).toBeNull();
    expect(
      screen.getByRole('searchbox', { name: 'Search conversations' }),
    ).toBeDefined();
  });

  it('describes the route under the page title', async () => {
    const api = createApi();
    await renderRoute(api);

    expect(
      screen.getByText('Calls and voicemails, with transcripts'),
    ).toBeDefined();
  });

  it('round-trips the search query to the api', async () => {
    const api = createApi();
    await renderRoute(api);

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search conversations' }), {
      target: { value: 'maya' },
    });

    expect(api.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: 'maya' }),
    );
  });

  it('loads the detail when a row is selected', async () => {
    const api = createApi();
    await renderRoute(api);

    const detail = await openCallDetail();

    expect(api.get).toHaveBeenCalledWith({ activityId: 'activity-call' });
    expect(within(detail).getByText('Discovery call about weekend showings.')).toBeDefined();
    expect(within(detail).getByText('No transcript attached')).toBeDefined();
  });

  it('opens the lead from the detail header', async () => {
    const api = createApi();
    const onOpenLead = vi.fn();
    await renderRoute(api, onOpenLead);
    const detail = await openCallDetail();

    fireEvent.click(within(detail).getByRole('button', { name: 'Open lead' }));

    expect(onOpenLead).toHaveBeenCalledWith('person-kevin');
  });

  it('renders transcript utterances with the founder visually distinct', async () => {
    const api = createApi();
    await renderRoute(api);

    fireEvent.click(screen.getByRole('button', { name: /Maya Owner/ }));
    const detail = await screen.findByRole('region', { name: 'Conversation detail' });
    await within(detail).findByText('Hi, this is the founder.');

    expect(within(detail).getByText('Please call me back.')).toBeDefined();
    expect(within(detail).getByText('[beep]')).toBeDefined();
    const founderUtterance = within(detail)
      .getByText('Hi, this is the founder.')
      .closest('li');
    expect(founderUtterance?.className).toContain('utterance--founder');
    const leadUtterance = within(detail)
      .getByText('Please call me back.')
      .closest('li');
    expect(leadUtterance?.className).not.toContain('utterance--founder');
  });

  it('enables attach when no transcript exists and disables it when one does', async () => {
    const api = createApi();
    await renderRoute(api);

    const detail = await openCallDetail();
    const attachButton = within(detail)
      .getByRole('button', { name: 'Attach transcript' }) as HTMLButtonElement;
    expect(attachButton.disabled).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: /Maya Owner/ }));
    await within(detail).findByText('Hi, this is the founder.');
    const disabledButton = within(detail)
      .getByRole('button', { name: 'Attach transcript' }) as HTMLButtonElement;
    expect(disabledButton.disabled).toBe(true);
  });

  it('submits pasted text from the dialog and refreshes the workspace', async () => {
    const api = createApi();
    await renderRoute(api);
    const detail = await openCallDetail();
    const listCallsBefore = (api.list as ReturnType<typeof vi.fn>).mock.calls.length;

    fireEvent.click(within(detail).getByRole('button', { name: 'Attach transcript' }));
    const dialog = await screen.findByRole('dialog', { name: 'Attach transcript' });
    const attach = within(dialog).getByRole('button', { name: 'Attach' }) as HTMLButtonElement;
    expect(attach.disabled).toBe(true);

    fireEvent.change(within(dialog).getByLabelText('Transcript text'), {
      target: { value: 'me: Thanks for the call.\nKevin: Happy to chat.' },
    });
    expect(within(dialog).getByText(/2 utterances/)).toBeDefined();
    expect(attach.disabled).toBe(false);

    fireEvent.click(attach);

    expect(api.attachTranscript).toHaveBeenCalledWith({
      activityId: 'activity-call',
      personId: 'person-kevin',
      rawText: 'me: Thanks for the call.\nKevin: Happy to chat.',
    });
    await screen.findAllByText('Kevin Landlord');
    expect(screen.queryByRole('dialog', { name: 'Attach transcript' })).toBeNull();
    expect(api.get).toHaveBeenCalledTimes(2);
    expect((api.list as ReturnType<typeof vi.fn>).mock.calls.length)
      .toBeGreaterThan(listCallsBefore);
  });

  it('holds transcript pending through close paths and retains verbatim text after rejection', async () => {
    let reject!: (error: Error) => void;
    const api = createApi({ attachTranscript: vi.fn(() => new Promise<MutationReceipt>((_, fail) => { reject = fail; })) });
    await renderRoute(api);
    const detail = await openCallDetail();
    fireEvent.click(within(detail).getByRole('button', { name: 'Attach transcript' }));
    const dialog = screen.getByRole('dialog');
    const rawText = 'me:  hello  \nKevin: Yes';
    fireEvent.change(within(dialog).getByLabelText('Transcript text'), { target: { value: rawText } });
    const save = within(dialog).getByRole('button', { name: 'Attach' });
    act(() => { save.click(); save.click(); });
    expect(api.attachTranscript).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.getByRole('dialog')).toBe(dialog);
    await act(async () => { reject(new Error('private failure')); });
    expect(within(dialog).getByRole('alert').textContent).toBe('Transcript attachment was not confirmed. Your text is still here. Check this conversation before attaching again.');
    expect((within(dialog).getByLabelText('Transcript text') as HTMLTextAreaElement).value).toBe(rawText);
    expect(dialog.tagName).toBe('DIALOG');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps captured IDs while pending and never refreshes after unmount', async () => {
    let resolve!: (value: MutationReceipt) => void;
    const api = createApi({ attachTranscript: vi.fn(() => new Promise<MutationReceipt>(yes => { resolve = yes; })) });
    const view = render(<ConversationsRoute api={api} onOpenLead={vi.fn()} />);
    await screen.findByText('Kevin Landlord');
    const detail = await openCallDetail();
    fireEvent.click(within(detail).getByRole('button', { name: 'Attach transcript' }));
    fireEvent.change(screen.getByLabelText('Transcript text'), { target: { value: 'me: original' } });
    fireEvent.click(screen.getByRole('button', { name: 'Attach' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: /Maya Owner/ }));
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(api.attachTranscript).toHaveBeenCalledWith({ activityId: 'activity-call', personId: 'person-kevin', rawText: 'me: original' });
    view.unmount();
    await act(async () => resolve({ revision: 2, affectedPersonIds: ['person-kevin'], affectedSalesCycleIds: [] }));
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.list).toHaveBeenCalledTimes(1);
  });
  it('does not reinterpret an accepted transcript receipt when refresh fails', async () => {
    const api = createApi();
    await renderRoute(api);
    const detail = await openCallDetail();
    api.get = vi.fn(async () => { throw new Error('refresh failed'); });
    api.list = vi.fn(async () => { throw new Error('refresh failed'); });
    fireEvent.click(within(detail).getByRole('button', { name: 'Attach transcript' }));
    fireEvent.change(screen.getByLabelText('Transcript text'), { target: { value: 'me: accepted text' } });
    fireEvent.click(screen.getByRole('button', { name: 'Attach' }));
    await act(async () => {});
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.attachTranscript).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/attachment was not confirmed/)).toBeNull();
  });

  it('surfaces an attach rejection inside the dialog', async () => {
    const api = createApi({
      attachTranscript: vi.fn().mockRejectedValue(new Error('TRANSCRIPT_ALREADY_ATTACHED')),
    });
    await renderRoute(api);
    const detail = await openCallDetail();

    fireEvent.click(within(detail).getByRole('button', { name: 'Attach transcript' }));
    const dialog = await screen.findByRole('dialog', { name: 'Attach transcript' });
    fireEvent.change(within(dialog).getByLabelText('Transcript text'), {
      target: { value: 'me: hello' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Attach' }));

    expect(await within(dialog).findByRole('alert')).toBeDefined();
    expect(screen.getByRole('dialog', { name: 'Attach transcript' })).toBeDefined();
  });

  it('shows an error surface with retry when the list fails to load', async () => {
    const listMock = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue({ rows: [callRow], total: 1, nextCursor: null, revision: 1 });
    const api = createApi({ list: listMock });
    render(<ConversationsRoute api={api} onOpenLead={vi.fn()} />);

    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await screen.findByText('Kevin Landlord');
  });

  it('splits the empty state: compact list one-liner, full detail explanation', async () => {
    const api = createApi({
      list: vi.fn().mockResolvedValue({ rows: [], total: 0, nextCursor: null, revision: 0 }),
    });
    render(<ConversationsRoute api={api} onOpenLead={vi.fn()} />);

    await screen.findByText('No calls yet');
    const detail = screen.getByRole('region', { name: 'Conversation detail' });
    expect(within(detail).getByText('No conversations yet')).toBeDefined();
    expect(
      within(detail).getByText(/logged from the lead inspector appear here/),
    ).toBeDefined();
    expect(screen.queryByText('Select a conversation')).toBeNull();
    expect(screen.queryByRole('button', { name: /Attach transcript/ })).toBeNull();
  });

  it('asks for a selection in the detail pane when rows exist but none is open', async () => {
    const api = createApi();
    await renderRoute(api);

    const detail = screen.getByRole('region', { name: 'Conversation detail' });
    expect(within(detail).getByText('Select a conversation')).toBeDefined();
    expect(screen.queryByText('No calls yet')).toBeNull();
  });

  it('is axe-clean', async () => {
    const api = createApi();
    await renderRoute(api);
    await openCallDetail();

    const results = await axe.run(document.body, {
      rules: {
        'color-contrast': { enabled: false },
        region: { enabled: false },
      },
    });

    expect(results.violations).toEqual([]);
  });
});
