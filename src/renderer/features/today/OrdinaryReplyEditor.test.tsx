// @vitest-environment jsdom
// Intended destination: src/renderer/features/today/OrdinaryReplyEditor.test.tsx.
// Transparent renderer fixture only. No backend persistence or receipt is fabricated.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { dailyAnswerSchema, type DailyAnswer } from '../../../shared/contracts/dailyContract';
import type { CalliePreloadApi } from '../../../shared/preload';
import { DailyAnswerDetail } from './DailyAnswers';
import { nativeDeskFixture } from './nativeDesk.fixture';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('offers explicit ordinary reply editing only after showing the exact saved conversation and held draft', () => {
  const received = 'Hi Alex,\n\n  Please retain <original> wording.\n\tThanks.  ';
  const saved = 'Saved unsent response · café\n\nExact <text> stays literal.  \n';
  const item: Extract<DailyAnswer, { kind: 'reply' }> = {
    kind: 'reply', accountId: 'account-a', capability: 'held', reason: 'reply_capability_unverified', stale: false,
    thread: { revision: 1, contextRevision: 'context-a', signals: [], thread: {
      accountId: 'account-a', provider: 'gmail', mailboxSubject: 'mailbox-a', providerThreadId: 'thread-a',
      messages: [{ id: 'message-a', threadId: 'thread-a', rfcMessageId: null, references: [],
        from: ['mira@larkspur.example'], to: ['alex@callie-demo.example'], cc: [],
        date: '2026-09-15T13:15:00.000Z', subject: 'Question about shared enquiries',
        bodyParts: [{ mimeType: 'text/plain', text: received, truncated: false }] }],
    } },
    draft: { id: 'draft-a', accountId: 'account-a', threadId: 'thread-a', mailboxSubject: 'mailbox-a',
      threadRevision: 1, contextRevision: 'context-a', revision: 1, recipient: 'mira@larkspur.example',
      sender: 'alex@callie-demo.example', subject: 'Re: Shared enquiries', body: saved,
      evidenceIds: [], generation: 'edited', updatedAt: '2026-09-15T14:00:00.000Z' },
  };
  expect(dailyAnswerSchema.safeParse(item).success).toBe(true);
  const before = structuredClone(item);
  const f = nativeDeskFixture();
  const edit = vi.fn<CalliePreloadApi['delegation']['editReplyDraft']>(async () => { throw Error('Unexpected edit on render'); });
  const reconcile = vi.fn<CalliePreloadApi['delegation']['reconcileReplyDraft']>(async () => { throw Error('Unexpected owner reconciliation on render'); });
  const api = { ...f.api.delegation, editReplyDraft: edit, reconcileReplyDraft: reconcile } satisfies CalliePreloadApi['delegation'];
  const network = vi.fn((): never => { throw Error('Unexpected network effect'); });
  vi.stubGlobal('fetch', network); vi.stubGlobal('XMLHttpRequest', network); vi.stubGlobal('WebSocket', network);
  expect(typeof api.editReplyDraft).toBe('function'); expect(typeof api.reconcileReplyDraft).toBe('function');
  render(<DailyAnswerDetail item={item} workspaceId="workspace-a" api={api}
    company="Larkspur Studio" accountDetails={<p>Saved company context.</p>} />);
  const conversation = screen.getByRole('region', { name: 'Saved conversation' });
  const draftHeading = screen.getByRole('heading', { name: /^Saved reply draft$/ });
  expect(conversation.compareDocumentPosition(draftHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(conversation.querySelector('pre')?.textContent).toBe(received);
  expect(within(conversation).getByText(/1 saved message.*Remote freshness is unknown/)).toBeTruthy();
  expect(within(conversation).getByText(/Latest saved message/).closest('details')?.open).toBe(true);
  expect(screen.getByText('To mira@larkspur.example')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Re: Shared enquiries' })).toBeTruthy();
  expect(Array.from(document.querySelectorAll('pre')).find(node => node.textContent === saved)?.textContent).toBe(saved);
  expect(screen.getByRole('status').textContent).toMatch(/Reply approval held/);
  expect(screen.queryByRole('button', { name: /approve|send|generate/i })).toBeNull();
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(item).toEqual(before); expect(edit).not.toHaveBeenCalled(); expect(reconcile).not.toHaveBeenCalled();
  expect(network).not.toHaveBeenCalled(); expect(f.calls).toEqual([]);
  // First intended causal RED: current real DailyAnswerDetail has no ordinary edit action.
  expect(screen.getByRole('button', { name: /^Edit saved reply$/ })).toHaveProperty('disabled', false);
});

import { type AccountReplyDraft, type ReplyDraftResult, boundReplyDraftResult } from '../../../shared/contracts/mailThreadContract';
import { setDailySessionScope } from './dailySessionScope';
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function editingFixture() {
  const f = nativeDeskFixture();
  const draft: AccountReplyDraft = { id: 'ordinary', accountId: 'a', mailboxSubject: 'mailbox', threadId: 'thread',
    threadRevision: 1, contextRevision: 'context', revision: 1, recipient: 'person@example.test', sender: 'founder@example.test',
    subject: 'Original subject', body: 'Original saved reply', evidenceIds: [], generation: 'edited', updatedAt: '2026-09-15T12:00:00.000Z' };
  const item: Extract<DailyAnswer, { kind: 'reply' }> = { kind: 'reply', accountId: 'a', stale: false, capability: 'held', reason: 'reply_capability_unverified', draft,
    thread: { revision: 1, contextRevision: 'context', signals: [], thread: { accountId: 'a', mailboxSubject: 'mailbox', provider: 'gmail', providerThreadId: 'thread',
      messages: [{ id: 'message', threadId: 'thread', rfcMessageId: null, references: [], from: ['person@example.test'], to: ['founder@example.test'], cc: [],
        date: '2026-09-15T11:00:00.000Z', subject: 'Received question', bodyParts: [{ mimeType: 'text/plain', text: 'Exact received text\n  ', truncated: false }] }] } } };
  let current: ReplyDraftResult = { draft, stale: false, capability: 'held' };
  const edit = vi.fn<CalliePreloadApi['delegation']['editReplyDraft']>(async request => {
    current = boundReplyDraftResult(request).parse({ draft: { ...draft, revision: request.expectedRevision + 1,
      subject: request.subject, body: request.body, updatedAt: '2026-09-15T12:01:00.000Z' }, stale: false, capability: 'held' });
    return structuredClone(current);
  });
  const reconcile = vi.fn<CalliePreloadApi['delegation']['reconcileReplyDraft']>(async () => structuredClone(current));
  const api = { ...f.api.delegation, editReplyDraft: edit, reconcileReplyDraft: reconcile };
  setDailySessionScope(api, 'workspace');
  const view = (next = item, actionHold?: string) => <DailyAnswerDetail item={next} workspaceId="workspace" api={api} actionHold={actionHold} />;
  return { f, api, draft, item, edit, reconcile, view, current: () => current,
    setCurrent: (value: ReplyDraftResult) => { current = value; } };
}
const replyBody = () => screen.getByRole('textbox', { name: 'Reply body' });
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
it('public panel saves exact text explicitly and retains acknowledged/local text through close/remount without received-message mutation', async () => {
  const f = editingFixture(), original = structuredClone(f.item); const rendered = render(f.view());
  click('Edit saved reply'); const subject = 'Manual · café'; const body = 'Hello,\n\n  Exact <literal> text.\n\tTrailing spaces.  \n';
  fireEvent.change(screen.getByRole('textbox', { name: 'Reply subject' }), { target: { value: subject } });
  fireEvent.change(replyBody(), { target: { value: body } }); expect(f.edit).not.toHaveBeenCalled(); expect(f.reconcile).not.toHaveBeenCalled();
  click('Save edits'); await waitFor(() => expect(f.edit).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.getByText('Saved reply revision 2.')).toBeTruthy());
  expect(f.edit.mock.calls[0][0]).toEqual({ accountId: 'a', draftId: 'ordinary', expectedRevision: 1, expectedThreadRevision: 1, expectedContextRevision: 'context', subject, body });
  click('Close editor'); expect(screen.queryByRole('textbox')).toBeNull(); rendered.unmount(); render(f.view()); click('Edit saved reply');
  expect(replyBody()).toHaveProperty('value', body); expect(screen.getByRole('textbox', { name: 'Reply subject' })).toHaveProperty('value', subject);
  fireEvent.change(replyBody(), { target: { value: body + 'Unsubmitted\n ' } }); click('Close editor'); click('Edit saved reply');
  expect(replyBody()).toHaveProperty('value', body + 'Unsubmitted\n '); expect(f.edit).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('region', { name: 'Saved conversation' }).querySelector('pre')?.textContent).toBe('Exact received text\n  ');
  expect(f.item).toEqual(original); expect(f.f.calls).toEqual([]); expect(f.reconcile).not.toHaveBeenCalled();
  expect(screen.getByRole('status').textContent).toMatch(/Reply approval held/); expect(screen.queryByRole('button', { name: /approve|send|generate/i })).toBeNull();
});
it('public lost acknowledgement retains exact retry after predecessor reconcile and explicit display reset', async () => {
  const f = editingFixture(); f.edit.mockRejectedValue(Error('Lost')); render(f.view()); click('Edit saved reply');
  fireEvent.change(replyBody(), { target: { value: 'A\n  ' } }); click('Save edits'); await screen.findByRole('alert'); const original = f.edit.mock.calls[0][0];
  fireEvent.change(replyBody(), { target: { value: 'B' } }); click('Reconcile saved reply'); await screen.findByText(/Saved predecessor found/);
  click('Use saved version and discard displayed edits'); expect(replyBody()).toHaveProperty('value', f.draft.body);
  fireEvent.change(replyBody(), { target: { value: 'C' } }); expect(screen.getByRole('button', { name: 'Save edits' })).toHaveProperty('disabled', true);
  click('Retry same save'); await waitFor(() => expect(f.edit).toHaveBeenCalledTimes(2)); expect(f.edit.mock.calls[1][0]).toEqual(original); expect(replyBody()).toHaveProperty('value', 'C');
});
it('public pending operation survives close/remount, then original captured Daily guard rejects null/restore settlement', async () => {
  const f = editingFixture(), pending = deferred<ReplyDraftResult>(); f.edit.mockReturnValueOnce(pending.promise);
  const rendered = render(f.view()); click('Edit saved reply'); fireEvent.change(replyBody(), { target: { value: 'A' } }); click('Save edits');
  await waitFor(() => expect(f.edit).toHaveBeenCalledTimes(1)); click('Close editor'); rendered.unmount(); render(f.view()); click('Edit saved reply');
  expect(replyBody()).toHaveProperty('value', 'A'); expect(screen.getByRole('button', { name: 'Retry same save' })).toHaveProperty('disabled', true);
  expect(screen.getByRole('button', { name: 'Reconcile saved reply' })).toHaveProperty('disabled', true);
  const canonical: ReplyDraftResult = { draft: { ...f.draft, body: 'A', revision: 2, updatedAt: '2026-09-15T12:01:00.000Z' }, stale: false, capability: 'held' };
  act(() => { setDailySessionScope(f.api, null); setDailySessionScope(f.api, 'workspace'); });
  await act(async () => pending.resolve(canonical)); expect(screen.getByRole('alert').textContent).toMatch(/acknowledgement unavailable/);
  expect(screen.getByRole('button', { name: 'Retry same save' })).toHaveProperty('disabled', true); expect(f.reconcile).not.toHaveBeenCalled();
  f.setCurrent(canonical); click('Reconcile saved reply'); await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry same save' })).toBeNull());
  expect(replyBody()).toHaveProperty('value', 'A'); expect(f.edit).toHaveBeenCalledTimes(1); expect(f.reconcile).toHaveBeenCalledTimes(1);
});
it('stale historical recovery remains held and actionHold blocks Save Retry and Reconcile at the public panel', async () => {
  const f = editingFixture(); const stale = { ...f.item, stale: true }; const rendered = render(f.view(stale, 'Owner inactive')); click('Edit saved reply');
  fireEvent.change(replyBody(), { target: { value: 'Retain this' } }); click('Save edits'); click('Reconcile saved reply');
  expect(f.edit).not.toHaveBeenCalled(); expect(f.reconcile).not.toHaveBeenCalled();
  f.setCurrent({ draft: f.draft, stale: true, capability: 'held' }); rendered.rerender(f.view(stale)); click('Reconcile saved reply'); await waitFor(() => expect(f.reconcile).toHaveBeenCalledTimes(1));
  expect(screen.getByRole('button', { name: 'Save edits' })).toHaveProperty('disabled', true); expect(replyBody()).toHaveProperty('value', 'Retain this');
});
it('switching API identity or selected draft never exposes the other local editor text', () => {
  const a = editingFixture(), b = editingFixture(); const rendered = render(a.view()); click('Edit saved reply'); fireEvent.change(replyBody(), { target: { value: 'Only A' } });
  rendered.rerender(b.view()); expect(screen.queryByRole('textbox')).toBeNull(); click('Edit saved reply'); expect(replyBody()).toHaveProperty('value', b.draft.body);
  rendered.rerender(a.view()); expect(replyBody()).toHaveProperty('value', 'Only A');
});

import { REPLY_FIRST_DRAFT_STATES, REPLY_RECEIPT_STATES, replyApprovalConfirmation } from './OrdinaryReplyEditor';
import type { ReplyApprovalStatus, ReplyFirstDraftResult } from '../../../shared/contracts/replyFirstDraftContract';
/** The first draft, a regenerate and one approval, with every model and worker call recorded. */
function approvalFixture(options: { unconfigured?: boolean } = {}) {
  const base = editingFixture();
  const admit = vi.fn<NonNullable<CalliePreloadApi['delegation']['admitReplyFirstDraft']>>(async request => {
    if (options.unconfigured) {
      return { draft: base.current().draft, stale: false, capability: 'held', state: 'model_unconfigured', citedEvidenceIds: [] } satisfies ReplyFirstDraftResult;
    }
    const draft = { ...base.current().draft, revision: request.expectedRevision + 1, generation: 'edited' as const,
      subject: 'Re: Received question', body: `Written on the Mac, revision ${request.expectedRevision + 1}`, updatedAt: '2026-09-15T12:02:00.000Z' };
    base.setCurrent({ draft, stale: false, capability: 'held' });
    return { draft, stale: false, capability: 'held', state: 'model', citedEvidenceIds: ['thread:message'] } satisfies ReplyFirstDraftResult;
  });
  const approve = vi.fn<NonNullable<CalliePreloadApi['delegation']['approveReply']>>(async request => ({
    accountId: request.accountId, draftId: request.draftId, approvalId: request.approvalId, draftRevision: request.expectedRevision,
    statement: request.statement, approvalExpiresAt: '2026-09-15T13:03:00.000Z', approvalCommandId: request.commandId,
    submitCommandId: null, state: 'approved', receipt: null, reason: null,
  } satisfies ReplyApprovalStatus));
  const submit = vi.fn<NonNullable<CalliePreloadApi['delegation']['submitApprovedReply']>>(async request => ({
    accountId: request.accountId, draftId: 'ordinary', approvalId: request.approvalId, draftRevision: 1,
    statement: 'ongoing_correspondence', approvalExpiresAt: '2026-09-15T13:03:00.000Z',
    approvalCommandId: approve.mock.calls[0]![0].commandId, submitCommandId: request.commandId, state: 'pending',
    receipt: { commandId: request.commandId, status: 'pending', authorityGeneration: 1, aggregateVersion: 2, reason: null }, reason: null,
  } satisfies ReplyApprovalStatus));
  const api = { ...base.api, admitReplyFirstDraft: admit, approveReply: approve, submitApprovedReply: submit };
  setDailySessionScope(api, 'workspace');
  return { ...base, api, admit, approve, submit,
    view: (next = base.item, actionHold?: string) => <DailyAnswerDetail item={next} workspaceId="workspace" api={api} actionHold={actionHold} /> };
}

it('writes the first draft, regenerates against the same thread identity, and never calls a model in the renderer', async () => {
  const f = approvalFixture();
  const network = vi.fn((): never => { throw Error('Unexpected network effect'); });
  vi.stubGlobal('fetch', network);
  render(f.view());
  click('Write a first draft');
  await waitFor(() => expect(f.admit).toHaveBeenCalledTimes(1));
  expect(f.admit.mock.calls[0]![0]).toEqual({ accountId: 'a', draftId: 'ordinary', expectedRevision: 1, expectedThreadRevision: 1, expectedContextRevision: 'context' });
  await waitFor(() => expect(screen.getByText('Saved reply revision 2.')).toBeTruthy());
  expect(screen.getByText(REPLY_FIRST_DRAFT_STATES.model)).toBeTruthy();
  // The regenerate binds the same thread identity and the revision now saved.
  click('Write a first draft');
  await waitFor(() => expect(f.admit).toHaveBeenCalledTimes(2));
  expect(f.admit.mock.calls[1]![0]).toEqual({ accountId: 'a', draftId: 'ordinary', expectedRevision: 2, expectedThreadRevision: 1, expectedContextRevision: 'context' });
  expect(network).not.toHaveBeenCalled();
  expect(f.approve).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
});

it('says plainly that no key is saved instead of pretending a draft was written', async () => {
  const f = approvalFixture({ unconfigured: true });
  render(f.view());
  click('Write a first draft');
  await waitFor(() => expect(screen.getByText(REPLY_FIRST_DRAFT_STATES.model_unconfigured)).toBeTruthy());
  expect(screen.getByText('Saved reply revision 1.')).toBeTruthy();
  expect(f.reconcile).not.toHaveBeenCalled();
});

it('approves once behind a confirmation that names the recipient and the mailbox, then shows the worker receipt', async () => {
  const f = approvalFixture();
  render(f.view());
  expect(screen.getByRole('button', { name: 'Approve and send' })).toHaveProperty('disabled', true);
  expect(f.approve).not.toHaveBeenCalled();
  fireEvent.click(screen.getByLabelText(replyApprovalConfirmation(f.draft)));
  click('Approve and send');
  await waitFor(() => expect(f.submit).toHaveBeenCalledTimes(1));
  expect(f.approve).toHaveBeenCalledTimes(1);
  expect(f.approve.mock.calls[0]![0]).toMatchObject({ accountId: 'a', draftId: 'ordinary', expectedRevision: 1, statement: 'ongoing_correspondence' });
  // Approving and submitting are separate commands, and the submit names the approval.
  expect(f.submit.mock.calls[0]![0].approvalId).toBe(f.approve.mock.calls[0]![0].approvalId);
  await waitFor(() => expect(screen.getByText(new RegExp(REPLY_RECEIPT_STATES.pending))).toBeTruthy());
  expect(screen.getByRole('button', { name: 'Approve and send' })).toHaveProperty('disabled', true);
});

it('refuses to approve text that is not saved, and reports a failed approval as no send', async () => {
  const f = approvalFixture();
  f.approve.mockRejectedValue(Error('Lost'));
  render(f.view());
  fireEvent.click(screen.getByLabelText(replyApprovalConfirmation(f.draft)));
  click('Edit saved reply');
  fireEvent.change(replyBody(), { target: { value: 'Unsaved text' } });
  expect(screen.getByRole('button', { name: 'Approve and send' })).toHaveProperty('disabled', true);
  expect(screen.getByText(/Save your edits first/)).toBeTruthy();
  fireEvent.change(replyBody(), { target: { value: f.draft.body } });
  click('Approve and send');
  await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/Nothing was sent/));
  expect(f.submit).not.toHaveBeenCalled();
});
