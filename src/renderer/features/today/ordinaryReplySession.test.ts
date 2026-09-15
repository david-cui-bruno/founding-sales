import { expect, it, vi } from 'vitest';
import { type AccountReplyDraft, type ReplyDraftResult } from '../../../shared/contracts/mailThreadContract';
import { ordinaryReplySession, type OrdinaryReplyApi } from './ordinaryReplySession';
import { setDailySessionScope } from './dailySessionScope';
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function fixture() {
  const draft: AccountReplyDraft = { id: 'draft', accountId: 'account', threadId: 'thread', mailboxSubject: 'mailbox',
    threadRevision: 1, contextRevision: 'context', revision: 4, sender: 'founder@example.test', recipient: 'person@example.test',
    subject: 'Saved', body: 'Original  \n', evidenceIds: ['evidence'], generation: 'edited', updatedAt: '2026-09-15T12:00:00.000Z' };
  let canonical: ReplyDraftResult = { draft: structuredClone(draft), stale: false, capability: 'held' };
  const edit = vi.fn<OrdinaryReplyApi['editReplyDraft']>(async request => {
    canonical = { draft: { ...draft, revision: request.expectedRevision + 1, subject: request.subject, body: request.body, updatedAt: '2026-09-15T12:01:00.000Z' }, stale: false, capability: 'held' };
    return structuredClone(canonical);
  });
  const reconcile = vi.fn<OrdinaryReplyApi['reconcileReplyDraft']>(async () => structuredClone(canonical));
  const api: OrdinaryReplyApi = { editReplyDraft: edit, reconcileReplyDraft: reconcile };
  setDailySessionScope(api, 'workspace');
  const session = ordinaryReplySession(api, 'workspace', draft, false);
  return { draft, api, session, edit, reconcile, setCanonical: (value: ReplyDraftResult) => { canonical = value; }, next: (body = 'A'): ReplyDraftResult => ({ draft: { ...draft, revision: 5, body, updatedAt: '2026-09-15T12:01:00.000Z' }, stale: false, capability: 'held' }) };
}
it('C1 predecessor reconciliation plus Use saved never clears or replaces uncertain request', async () => {
  const f = fixture(); f.edit.mockRejectedValue(Error('Lost acknowledgement'));
  f.session.edit('body', 'A'); await f.session.save(); const original = f.edit.mock.calls[0][0];
  f.session.edit('body', 'B'); await f.session.reconcile(); f.session.useSaved();
  expect(f.session.snapshot().body).toBe(f.draft.body); expect(f.session.snapshot().pending?.request).toEqual(original);
  f.session.edit('body', 'C'); await f.session.save(); expect(f.edit).toHaveBeenCalledTimes(1);
  await f.session.retry(); expect(f.edit.mock.calls[1][0]).toEqual(original); expect(f.session.snapshot().body).toBe('C');
  expect(f.session.history()[0].outcome).toBe('unknown');
});
it('C1 in-flight remount serializes Save Retry and Reconcile without abandoning original', async () => {
  const f = fixture(), pending = deferred<ReplyDraftResult>(); f.edit.mockReturnValueOnce(pending.promise);
  f.session.edit('body', 'A'); const saving = f.session.save();
  const remount = ordinaryReplySession(f.api, 'workspace', f.draft, false); expect(remount).toBe(f.session);
  remount.close(); remount.open(); remount.edit('body', 'Later'); await remount.retry(); await remount.reconcile(); await remount.save();
  expect(f.edit).toHaveBeenCalledTimes(1); expect(f.reconcile).not.toHaveBeenCalled();
  pending.resolve(f.next()); await saving; expect(remount.snapshot().body).toBe('Later');
  expect(remount.snapshot().draft.body).toBe('A'); expect(remount.snapshot().pending).toBeNull();
});
it('matching canonical reconciliation settles only original effect while retaining newer displayed text', async () => {
  const f = fixture(); f.edit.mockRejectedValueOnce(Error('Lost'));
  f.session.edit('body', 'A'); await f.session.save(); f.session.edit('body', 'Later'); f.setCanonical(f.next()); await f.session.reconcile();
  expect(f.session.snapshot()).toMatchObject({ body: 'Later', pending: null, scopeHeld: false });
  expect(f.session.history()[0]).toMatchObject({ outcome: 'reconciled', result: f.next() }); expect(f.edit).toHaveBeenCalledTimes(1);
});
it.each(['same-content', 'recipient', 'sender', 'mailbox', 'evidence', 'timestamp', 'gap'])('C2 rejects schema-valid %s lineage corruption', async kind => {
  const f = fixture(); f.edit.mockRejectedValueOnce(Error('Lost')); f.session.edit('body', 'A'); await f.session.save();
  const corrupted = f.next();
  if (kind === 'same-content') corrupted.draft = { ...f.draft, body: 'Changed same revision' };
  if (kind === 'recipient') corrupted.draft.recipient = 'other@example.test';
  if (kind === 'sender') corrupted.draft.sender = 'other@example.test';
  if (kind === 'mailbox') corrupted.draft.mailboxSubject = 'other';
  if (kind === 'evidence') corrupted.draft.evidenceIds = ['other'];
  if (kind === 'timestamp') corrupted.draft.updatedAt = '2026-09-14T12:00:00.000Z';
  if (kind === 'gap') corrupted.draft.revision = 6;
  f.setCanonical(corrupted); await f.session.reconcile();
  expect(f.session.snapshot().draft).toEqual(f.draft); expect(f.session.snapshot().pending).not.toBeNull();
  expect(f.session.snapshot().body).toBe('A'); expect(f.session.snapshot().error).toMatch(/lineage/);
});
it('C2 applies full lineage validation to an edit acknowledgement too', async () => {
  const f = fixture(); const corrupt = f.next(); corrupt.draft.recipient = 'other@example.test'; f.edit.mockResolvedValueOnce(corrupt);
  f.session.edit('body', 'A'); await f.session.save(); expect(f.session.snapshot().draft.recipient).toBe(f.draft.recipient);
  expect(f.session.snapshot().pending).not.toBeNull(); expect(f.session.history()[0].outcome).toBe('unknown');
});
it('different next text is retained as conflict, never releases original request even through Use saved', async () => {
  const f = fixture(); f.edit.mockRejectedValueOnce(Error('Lost')); f.session.edit('body', 'A'); await f.session.save();
  f.setCanonical(f.next('Different')); await f.session.reconcile(); f.session.useSaved(); await f.session.save();
  expect(f.session.snapshot()).toMatchObject({ conflict: true, body: 'Different' }); expect(f.session.snapshot().pending?.request.body).toBe('A'); expect(f.edit).toHaveBeenCalledTimes(1);
});
it('C3 historical stale reconciliation obeys actionHold and current Daily scope', async () => {
  const f = fixture(); f.session.ingest(f.draft, true); f.session.edit('body', 'A'); f.session.setActionHold('Owner inactive');
  await f.session.save(); await f.session.retry(); await f.session.reconcile(); expect(f.edit).not.toHaveBeenCalled(); expect(f.reconcile).not.toHaveBeenCalled();
  f.session.setActionHold(undefined); f.setCanonical({ draft: f.draft, stale: true, capability: 'held' }); await f.session.reconcile();
  expect(f.reconcile).toHaveBeenCalledTimes(1); expect(f.session.snapshot().stale).toBe(true); await f.session.save(); expect(f.edit).not.toHaveBeenCalled();
  setDailySessionScope(f.api, null); await f.session.reconcile(); expect(f.reconcile).toHaveBeenCalledTimes(1);
});
it('C3 actionHold also blocks exact retry of retained failed save', async () => {
  const f = fixture(); f.edit.mockRejectedValueOnce(Error('Lost')); f.session.edit('body', 'A'); await f.session.save(); f.session.setActionHold('Refresh unavailable');
  await f.session.retry(); await f.session.reconcile(); expect(f.edit).toHaveBeenCalledTimes(1); expect(f.reconcile).not.toHaveBeenCalled();
});
it('C4 original guard survives same-API null/restore and separately explicit reconciliation captures fresh guard', async () => {
  const f = fixture(), pending = deferred<ReplyDraftResult>(); f.edit.mockReturnValueOnce(pending.promise);
  f.session.edit('body', 'A'); const saving = f.session.save();
  setDailySessionScope(f.api, null); setDailySessionScope(f.api, 'workspace');
  pending.resolve(f.next()); await saving;
  expect(f.session.snapshot()).toMatchObject({ scopeHeld: true, body: 'A', draft: f.draft });
  expect(f.session.snapshot().pending).not.toBeNull(); expect(f.session.history()[0].outcome).toBe('unknown');
  f.setCanonical(f.next()); await f.session.reconcile(); expect(f.session.snapshot().pending).toBeNull(); expect(f.session.snapshot().scopeHeld).toBe(false);
  expect(f.session.history()[0].outcome).toBe('reconciled');
});
it('known acknowledgement survives later scope failure and old Daily snapshot on remount', async () => {
  const f = fixture(); f.session.edit('body', 'A'); await f.session.save();
  setDailySessionScope(f.api, null); await f.session.reconcile(); setDailySessionScope(f.api, 'workspace');
  f.session.ingest(f.draft, false);
  expect(f.session.snapshot().draft.revision).toBe(5); expect(f.session.history()[0].outcome).toBe('acknowledged');
  f.setCanonical(f.next()); await f.session.reconcile();
  expect(f.session.snapshot().stale).toBe(false); expect(f.session.snapshot().conflict).toBe(false);
});
it('acknowledged revision does not become a false conflict when an older known Daily snapshot remounts', async () => {
  const f = fixture(); f.session.edit('body', 'A'); await f.session.save(); f.session.ingest(f.draft, false);
  expect(f.session.snapshot()).toMatchObject({ stale: false, conflict: false, body: 'A' });
});
it('API/workspace/draft identities do not share displayed text', () => {
  const f = fixture(); f.session.edit('body', 'Private');
  expect(ordinaryReplySession({ ...f.api }, 'workspace', f.draft, false).snapshot().body).toBe(f.draft.body);
  expect(ordinaryReplySession(f.api, 'other', f.draft, false).snapshot().body).toBe(f.draft.body);
  expect(ordinaryReplySession(f.api, 'workspace', { ...f.draft, id: 'other' }, false).snapshot().body).toBe(f.draft.body);
});
it('an unchanged older Daily observation cannot clear a stale historical reconciliation hold', async () => {
  const f = fixture(); f.setCanonical({ draft: f.draft, stale: true, capability: 'held' }); await f.session.reconcile();
  f.session.ingest(f.draft, false); f.session.edit('body', 'New edit'); await f.session.save();
  expect(f.session.snapshot().stale).toBe(true); expect(f.edit).not.toHaveBeenCalled();
});
it('later saved inbound staleness stays held when an earlier Save acknowledgement arrives', async () => {
  const f = fixture(), pending = deferred<ReplyDraftResult>(); f.edit.mockReturnValueOnce(pending.promise);
  f.session.edit('body', 'A'); const saving = f.session.save(); f.session.ingest(f.draft, true);
  pending.resolve(f.next()); await saving;
  expect(f.session.snapshot().draft.revision).toBe(5); expect(f.session.snapshot().stale).toBe(true);
});
it('a different incoming Daily candidate is not silently discarded by an older acknowledgement', async () => {
  const f = fixture(), pending = deferred<ReplyDraftResult>(); f.edit.mockReturnValueOnce(pending.promise);
  f.session.edit('body', 'A'); const saving = f.session.save(); f.session.ingest(f.next('Other owner text').draft, false);
  pending.resolve(f.next()); await saving;
  expect(f.session.snapshot().pending).toBeNull(); expect(f.session.history()[0].outcome).toBe('acknowledged');
  expect(f.session.snapshot().incoming?.draft.body).toBe('Other owner text'); expect(f.session.snapshot().conflict).toBe(true);
});
it('C4 a reconciliation retains its own original guard through a same-workspace leave/return', async () => {
  const f = fixture(); f.edit.mockRejectedValueOnce(Error('Lost')); f.session.edit('body', 'A'); await f.session.save();
  const pending = deferred<ReplyDraftResult>(); f.reconcile.mockReturnValueOnce(pending.promise); const reading = f.session.reconcile();
  setDailySessionScope(f.api, null); setDailySessionScope(f.api, 'workspace'); pending.resolve(f.next()); await reading;
  expect(f.session.snapshot().scopeHeld).toBe(true); expect(f.session.snapshot().pending).not.toBeNull();
  expect(f.session.history()[0].outcome).toBe('unknown'); f.setCanonical(f.next()); await f.session.reconcile();
  expect(f.session.snapshot().pending).toBeNull(); expect(f.session.history()[0].outcome).toBe('reconciled');
});
it('explicit clean reconciliation cannot clear a later incoming stale observation received while it waits', async () => {
  const f = fixture(), pending = deferred<ReplyDraftResult>(); f.reconcile.mockReturnValueOnce(pending.promise);
  const reading = f.session.reconcile(); f.session.ingest(f.draft, true);
  pending.resolve({ draft: f.draft, stale: false, capability: 'held' }); await reading; expect(f.session.snapshot().stale).toBe(true);
  await f.session.reconcile(); expect(f.session.snapshot().stale).toBe(false);
});
