// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { EmailDraft, OutreachApi, OutreachStatus } from '../../../shared/contracts/outreachContract';
import { OutboundComposer } from './OutboundComposer';

afterEach(cleanup);
const status: OutreachStatus = { model: 'ready', modelName: 'fixture-model', gmail: 'ready', accountEmail: 'founder@example.com', senderName: 'Fictional Founder', postalAddress: '123 Fictional St' };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  const drafts = new Map<string, EmailDraft>();
  const sent: string[] = [];
  const api: OutreachApi = {
    status: vi.fn(async () => status), configure: vi.fn(async () => status), connectGmail: vi.fn(async () => status), disconnectGmail: vi.fn(async () => status),
    openDraft: vi.fn(async ({ personId, contactMethodId }) => {
      const id = `${personId}:${contactMethodId}`;
      if (!drafts.has(id)) drafts.set(id, { id, personId, contactMethodId, salesCycleId: `cycle-${personId}`, recipient: `${personId}@example.com`, subject: 'Property context', body: `Hello ${personId}`, revision: 1, status: 'draft', generation: 'model', messageId: null, notice: null, updatedAt: '2026-09-08T12:00:00.000Z' });
      return { ...drafts.get(id)! };
    }),
    saveDraft: vi.fn(async ({ draftId, expectedRevision, subject, body }) => {
      const previous = drafts.get(draftId)!;
      if (previous.revision !== expectedRevision) throw new Error('stale');
      const saved: EmailDraft = { ...previous, subject, body, revision: expectedRevision + 1, generation: 'edited' };
      drafts.set(draftId, saved); return { ...saved };
    }),
    generateDraft: vi.fn(async ({ draftId }) => ({ ...drafts.get(draftId)! })),
    sendDraft: vi.fn(async ({ draftId, expectedRevision }) => {
      const previous = drafts.get(draftId)!;
      if (previous.revision !== expectedRevision) throw new Error('stale');
      sent.push(previous.body);
      const saved: EmailDraft = { ...previous, status: 'sent', revision: expectedRevision + 1, messageId: 'fixture-message' };
      drafts.set(draftId, saved); return { ...saved };
    }),
  };
  return { api, drafts, sent };
}
const editor = (api: OutreachApi, personId = 'avery', onClose = vi.fn()) => <OutboundComposer channel="email" recipientLabel={`${personId}@example.com`} personId={personId} contactMethodId="email" api={api} onClose={onClose} />;
const body = () => screen.getByLabelText('Message') as HTMLTextAreaElement;

it('opens the owned persisted draft without sending and shows exact account/footer preview', async () => {
  const { api, sent } = fixture(); render(editor(api));
  await waitFor(() => expect(body().value).toBe('Hello avery'));
  expect(screen.getByText('founder@example.com')).toBeTruthy();
  expect(screen.getByText('Fictional Founder\n123 Fictional St\nTo stop these emails, reply "stop".', { exact: true, normalizer: value => value })).toBeTruthy();
  expect(sent).toEqual([]);
});

it('keeps unconfigured drafts editable and persists edits on close/reopen without a send', async () => {
  const { api, drafts, sent } = fixture();
  vi.mocked(api.status).mockResolvedValue({ ...status, gmail: 'unconfigured', model: 'unconfigured', accountEmail: null });
  const close = vi.fn(); const view = render(editor(api, 'avery', close));
  await waitFor(() => expect(body().value).toBe('Hello avery'));
  expect(screen.getByRole('link', { name: /Connections/ })).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(body(), { target: { value: 'My exact edit' } });
  fireEvent.click(screen.getByRole('button', { name: 'Close draft' }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(drafts.get('avery:email')?.body).toBe('My exact edit');
  view.unmount(); render(editor(api));
  await waitFor(() => expect(body().value).toBe('My exact edit'));
  expect(sent).toEqual([]);
});

it('flushes the latest edits before one explicit send and never replays unknown', async () => {
  const { api, sent } = fixture(); const gate = deferred<EmailDraft>();
  vi.mocked(api.sendDraft).mockImplementationOnce(async request => { const saved = await api.openDraft({ personId: 'avery', contactMethodId: 'email' }); sent.push(saved.body); expect(request.expectedRevision).toBe(saved.revision); return gate.promise; });
  render(editor(api)); await waitFor(() => expect(body().value).toBe('Hello avery'));
  fireEvent.change(body(), { target: { value: 'Final explicit text' } });
  const send = screen.getByRole('button', { name: 'Send' }); fireEvent.click(send); fireEvent.click(send);
  await waitFor(() => expect(sent).toEqual(['Final explicit text']));
  await act(async () => gate.resolve({ ...(await api.openDraft({ personId: 'avery', contactMethodId: 'email' })), status: 'unknown' }));
  expect(screen.getByText(/Check.*Sent/)).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole('button', { name: /Retry.*send/i })).toBeNull();
});

it('flushes old-person edits on unmount without replacing a new recipient from a late save', async () => {
  const { api, drafts } = fixture(); const gate = deferred<void>();
  vi.mocked(api.saveDraft).mockImplementationOnce(async input => { await gate.promise; const previous = drafts.get(input.draftId)!;
    const saved: EmailDraft = { ...previous, subject: input.subject, body: input.body, revision: input.expectedRevision + 1 }; drafts.set(input.draftId, saved); return saved; });
  const view = render(editor(api)); await waitFor(() => expect(body().value).toBe('Hello avery'));
  fireEvent.change(body(), { target: { value: 'Avery edit' } });
  view.rerender(editor(api, 'blair'));
  await waitFor(() => expect(body().value).toBe('Hello blair'));
  fireEvent.change(body(), { target: { value: 'Blair edit' } });
  await act(async () => gate.resolve());
  expect(body().value).toBe('Blair edit');
  await waitFor(() => expect(drafts.get('avery:email')?.body).toBe('Avery edit'));
});

it('ignores an earlier open response after changing person', async () => {
  const { api } = fixture(); const gate = deferred<EmailDraft>();
  const original = await api.openDraft({ personId: 'avery', contactMethodId: 'email' });
  vi.mocked(api.openDraft).mockImplementationOnce(() => gate.promise);
  const view = render(editor(api)); view.rerender(editor(api, 'blair'));
  await waitFor(() => expect(body().value).toBe('Hello blair'));
  await act(async () => gate.resolve(original));
  expect(body().value).toBe('Hello blair');
});

it('previews the draft-bound sender and footer, not a different current configuration', async () => {
  const { api, drafts } = fixture();
  const draft = await api.openDraft({ personId: 'avery', contactMethodId: 'email' });
  drafts.set(draft.id, { ...draft, senderEmail: 'bound@example.com', footer: 'Bound Sender\n456 Bound St\nTo stop these emails, reply "stop".' });
  render(editor(api)); await waitFor(() => expect(body().value).toBe('Hello avery'));
  expect(screen.getByText('bound@example.com')).toBeTruthy();
  expect(screen.queryByText('founder@example.com')).toBeNull();
  expect(screen.getByText(/456 Bound St/)).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
});

it('saves newer edits typed during an earlier save before close, without replacing the editor', async () => {
  const { api, drafts } = fixture(); const gate = deferred<void>();
  const save = api.saveDraft;
  vi.mocked(api.saveDraft).mockImplementationOnce(async input => {
    await gate.promise;
    const old = drafts.get(input.draftId)!;
    const result = { ...old, subject: input.subject, body: input.body, revision: input.expectedRevision + 1 };
    drafts.set(input.draftId, result); return result;
  });
  const close = vi.fn(); render(editor(api, 'avery', close)); await waitFor(() => expect(body().value).toBe('Hello avery'));
  fireEvent.change(body(), { target: { value: 'Earlier' } }); fireEvent.blur(body());
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  fireEvent.change(body(), { target: { value: 'Latest exact prose' } });
  fireEvent.click(screen.getByRole('button', { name: 'Close draft' })); expect(close).not.toHaveBeenCalled();
  await act(async () => gate.resolve());
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(body().value).toBe('Latest exact prose'); expect(drafts.get('avery:email')?.body).toBe('Latest exact prose');
  expect(save).toHaveBeenCalledTimes(2);
});

it('never sends after a failed edit flush and retains recoverable exact prose', async () => {
  const { api } = fixture(); vi.mocked(api.saveDraft).mockRejectedValueOnce(new Error('secret database path'));
  render(editor(api)); await waitFor(() => expect(body().value).toBe('Hello avery'));
  fireEvent.change(body(), { target: { value: 'Must not lose this' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await screen.findByRole('alert'); expect(api.sendDraft).not.toHaveBeenCalled(); expect(body().value).toBe('Must not lose this');
  expect(screen.queryByText(/secret database path/)).toBeNull();
});

it('accepts a newly created same-contact draft only on explicit reopen after sending', async () => {
  const { api } = fixture(); const view = render(editor(api));
  await waitFor(() => expect(body().value).toBe('Hello avery'));
  fireEvent.click(screen.getByRole('button', { name: 'Send' })); await screen.findByText(/Accepted by Gmail/);
  view.unmount();
  const previous = await api.openDraft({ personId: 'avery', contactMethodId: 'email' });
  vi.mocked(api.openDraft).mockResolvedValueOnce({ ...previous, id: 'new-draft', status: 'draft', revision: 1, subject: 'New email', body: 'A new reviewed conversation' });
  render(editor(api)); await waitFor(() => expect(body().value).toBe('A new reviewed conversation'));
  expect(api.sendDraft).toHaveBeenCalledOnce();
});
it('recovers a lost save reply on reopen without losing local prose or resending', async () => {
  const { api, drafts } = fixture();
  vi.mocked(api.saveDraft).mockImplementationOnce(async input => {
    drafts.set(input.draftId, { ...drafts.get(input.draftId)!, subject: input.subject, body: input.body, revision: input.expectedRevision + 1 });
    throw new Error('Reply lost after save');
  });
  const view = render(editor(api)); await waitFor(() => expect(body().value).toBe('Hello avery'));
  fireEvent.change(body(), { target: { value: 'Persisted before lost reply' } }); fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
  await screen.findByRole('alert'); view.unmount();
  render(editor(api)); await waitFor(() => expect(api.openDraft).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  expect(body().value).toBe('Persisted before lost reply'); expect(api.sendDraft).not.toHaveBeenCalled();
});
it('requires explicit conflict acknowledgement before replacing a changed saved draft', async () => {
  const { api, drafts } = fixture(); const view = render(editor(api));
  await waitFor(() => expect(body().value).toBe('Hello avery'));
  drafts.set('avery:email', { ...drafts.get('avery:email')!, body: 'Changed elsewhere', revision: 2 });
  fireEvent.change(body(), { target: { value: 'My unsaved local text' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save draft' })); await screen.findByRole('alert'); view.unmount();
  const reopened = render(editor(api)); await waitFor(() => expect(api.openDraft).toHaveBeenCalledTimes(2));
  expect(body().value).toBe('My unsaved local text'); expect(drafts.get('avery:email')?.body).toBe('Changed elsewhere');
  expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.blur(body()); expect(drafts.get('avery:email')?.body).toBe('Changed elsewhere');
  fireEvent.click(screen.getByRole('button', { name: 'Save my displayed edits' }));
  await waitFor(() => expect(drafts.get('avery:email')?.body).toBe('My unsaved local text'));
  reopened.unmount(); expect(api.sendDraft).not.toHaveBeenCalled();
});
it('announces accepted email for bound workspace refresh without announcing unknown sends', async () => {
  const { api } = fixture(); const listener = vi.fn(); window.addEventListener('callie:email-sent', listener);
  try {
    render(editor(api)); await waitFor(() => expect(body().value).toBe('Hello avery'));
    fireEvent.click(screen.getByRole('button', { name: 'Send' })); await screen.findByText(/Accepted by Gmail/);
    expect(listener).toHaveBeenCalledOnce(); expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({ personId: 'avery', salesCycleId: 'cycle-avery' });
  } finally { window.removeEventListener('callie:email-sent', listener); }
});
