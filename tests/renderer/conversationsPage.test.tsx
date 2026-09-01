// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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

  it('round-trips the filter control to the api', async () => {
    const api = createApi();
    await renderRoute(api);

    fireEvent.click(screen.getByRole('button', { name: 'With transcript' }));

    expect(api.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ filter: 'with_transcript' }),
    );
    await screen.findByText('Kevin Landlord');
    expect(screen.getByRole('button', { name: 'With transcript' })
      .getAttribute('aria-pressed')).toBe('true');
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

  it('shows an empty state when no conversations exist', async () => {
    const api = createApi({
      list: vi.fn().mockResolvedValue({ rows: [], total: 0, nextCursor: null, revision: 0 }),
    });
    render(<ConversationsRoute api={api} onOpenLead={vi.fn()} />);

    await screen.findByText('No conversations yet');
  });
});
