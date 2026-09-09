import { createHash } from 'node:crypto';
import type { AppDatabase } from '../db/database';
import { mailCheckpointSchema, mailCursorEnvelopeSchema, type MailCursorEnvelope, threadProjectionSchema, accountReplyDraftSchema, type AccountReplyDraft, type SavedReplyDraft, type MailCheckpoint, type ThreadPage, type ThreadProjection, type IntakeResult } from '../../shared/contracts/mailThreadContract';
import { mergeThread, validateReplyDraftSave } from './threadIntake';
/** Real SQL adapter. Intake, immutable optout evidence, context fence and mailbox
 * checkpoint share one immediate transaction. No network occurs under its lock. */
export class SqlThreadIntakeRepository {
  constructor(readonly deps: { database: AppDatabase; workspaceId: string; clock: { now(): string } }) {}
  cursorState(accountId: string, mailboxSubject: string): { data: MailCursorEnvelope; rev: number } | null {
    const row = this.deps.database.raw.prepare('SELECT checkpoint_json,revision FROM delegated_mail_cursors WHERE workspace_id=? AND account_id=? AND mailbox_subject=?')
      .get(this.deps.workspaceId, accountId, mailboxSubject) as { checkpoint_json: string; revision: number } | undefined;
    if (!row) return null;
    const data = mailCursorEnvelopeSchema.parse(JSON.parse(row.checkpoint_json));
    for (const identity of [data.checkpoint, data.poll]) if (identity && (identity.accountId !== accountId || identity.mailboxSubject !== mailboxSubject)) throw new Error('mail_checkpoint_identity_conflict');
    return { data, rev: row.revision };
  }
  checkpoint(accountId: string, mailboxSubject: string): MailCheckpoint | null { return this.cursorState(accountId, mailboxSubject)?.data.checkpoint ?? null; }
  private writeCursor(accountId: string, mailboxSubject: string, value: MailCursorEnvelope): void {
    const envelope = mailCursorEnvelopeSchema.parse(value);
    this.deps.database.raw.prepare(`INSERT INTO delegated_mail_cursors(workspace_id,account_id,mailbox_subject,checkpoint_json,revision,updated_at) VALUES(?,?,?,?,1,?)
      ON CONFLICT(workspace_id,account_id,mailbox_subject) DO UPDATE SET checkpoint_json=excluded.checkpoint_json,revision=delegated_mail_cursors.revision+1,updated_at=excluded.updated_at`)
      .run(this.deps.workspaceId, accountId, mailboxSubject, JSON.stringify(envelope), this.deps.clock.now());
  }
  beginPoll(accountId: string, mailboxSubject: string, attemptId: string): void {
    const raw = this.deps.database.raw; if (raw.inTransaction) throw new Error('mail_poll_requires_own_transaction');
    raw.transaction(() => {
      const current = this.cursorState(accountId, mailboxSubject);
      this.writeCursor(accountId, mailboxSubject, { checkpoint: current?.data.checkpoint ?? null,
        poll: { attemptId, accountId, mailboxSubject, status: 'pending', startedAt: this.deps.clock.now(), completedAt: null } });
    }).immediate();
  }
  failPoll(accountId: string, mailboxSubject: string, attemptId: string): void {
    const raw = this.deps.database.raw; if (raw.inTransaction) throw new Error('mail_poll_requires_own_transaction');
    raw.transaction(() => {
      const current = this.cursorState(accountId, mailboxSubject);
      if (!current?.data.poll || current.data.poll.attemptId !== attemptId || current.data.poll.status !== 'pending') throw new Error('stale_poll_attempt');
      this.writeCursor(accountId, mailboxSubject, { ...current.data, poll: { ...current.data.poll, status: 'failed', completedAt: this.deps.clock.now() } });
    }).immediate();
  }
  getThread(accountId: string, threadId: string): ThreadProjection | null {
    const row = this.deps.database.raw.prepare('SELECT projection_json FROM delegated_threads WHERE workspace_id=? AND account_id=? AND id=?')
      .get(this.deps.workspaceId, accountId, threadId) as { projection_json: string } | undefined;
    return row ? threadProjectionSchema.parse(JSON.parse(row.projection_json)) : null;
  }
  isSuppressed(accountId: string): boolean {
    return Boolean(this.deps.database.raw.prepare('SELECT 1 FROM pm_account_suppression_tombstones WHERE account_id=? LIMIT 1').get(accountId));
  }
  getReplyDraft(accountId: string, id: string): SavedReplyDraft | null {
    const row = this.deps.database.raw.prepare('SELECT draft_json FROM delegated_reply_drafts WHERE workspace_id=? AND account_id=? AND id=?')
      .get(this.deps.workspaceId, accountId, id) as { draft_json: string } | undefined;
    if (!row) return null;
    const draft = accountReplyDraftSchema.parse(JSON.parse(row.draft_json));
    if (draft.accountId !== accountId || draft.id !== id) throw new Error('draft_identity_conflict');
    const thread = this.getThread(accountId, draft.threadId);
    return { draft, stale: !thread || thread.revision !== draft.threadRevision || thread.contextRevision !== draft.contextRevision || this.isSuppressed(accountId) };
  }
  saveReplyDraft(input: AccountReplyDraft, expectedRevision: number | null): AccountReplyDraft {
    const draft = accountReplyDraftSchema.parse(input); const raw = this.deps.database.raw;
    if (raw.inTransaction) throw new Error('mail_draft_requires_own_transaction');
    return raw.transaction(() => {
      const previous = this.getReplyDraft(draft.accountId, draft.id)?.draft ?? null;
      validateReplyDraftSave(draft, previous, expectedRevision, this.getThread(draft.accountId, draft.threadId));
      if (this.isSuppressed(draft.accountId) || raw.prepare("SELECT 1 FROM pm_handle_suppression_tombstones WHERE kind='email' AND normalized_value=? LIMIT 1").get(draft.recipient.toLowerCase())) throw new Error('reply_suppressed');
      raw.prepare(`INSERT INTO delegated_reply_drafts(workspace_id,account_id,id,thread_id,revision,thread_revision,context_revision,draft_json,updated_at) VALUES(?,?,?,?,?,?,?,?,?)
        ON CONFLICT(workspace_id,account_id,id) DO UPDATE SET revision=excluded.revision,draft_json=excluded.draft_json,updated_at=excluded.updated_at`)
        .run(this.deps.workspaceId, draft.accountId, draft.id, draft.threadId, draft.revision, draft.threadRevision, draft.contextRevision, JSON.stringify(draft), draft.updatedAt);
      return draft;
    }).immediate();
  }
  applyPage(page: ThreadPage, expected: MailCheckpoint | null, attemptId?: string): IntakeResult[] {
    const checkpoint = mailCheckpointSchema.parse(page.nextCursor);
    const raw = this.deps.database.raw;
    if (raw.inTransaction) throw new Error('mail_intake_requires_own_transaction');
    if (page.threads.length > 20 || new Set(page.threads.map(t => t.providerThreadId)).size !== page.threads.length) throw new Error('mail_page_capacity_exceeded');
    return raw.transaction(() => {
      const accountId = checkpoint.accountId; const workspaceId = this.deps.workspaceId;
      const authority = raw.prepare('SELECT owner,state FROM delegated_authorities WHERE workspace_id=? AND account_id=?').get(workspaceId, accountId) as { owner: string; state: string } | undefined;
      if (!authority) throw new Error('authority_missing');
      // A remote owner is observed through C1 ordered event replay, not local polling.
      if (authority.owner !== 'local' || authority.state !== 'local') throw new Error('mail_intake_wrong_owner');
      const cursor = this.cursorState(accountId, checkpoint.mailboxSubject);
      const current = cursor?.data.checkpoint ?? null;
      if (attemptId && (cursor?.data.poll?.attemptId !== attemptId || cursor.data.poll.status !== 'pending')) throw new Error('stale_poll_attempt');
      if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error('stale_mail_checkpoint');
      const now = this.deps.clock.now(); const results: IntakeResult[] = [];
      for (const thread of page.threads) {
        if (thread.accountId !== accountId || thread.mailboxSubject !== checkpoint.mailboxSubject) throw new Error('thread_identity_conflict');
        const result = mergeThread(this.getThread(accountId, thread.providerThreadId), thread); results.push(result);
        if (!result.changed) continue;
        raw.prepare(`INSERT INTO delegated_threads VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,account_id,id) DO UPDATE SET revision=excluded.revision,context_revision=excluded.context_revision,projection_json=excluded.projection_json,updated_at=excluded.updated_at`)
          .run(workspaceId, accountId, thread.providerThreadId, 'gmail', thread.providerThreadId, result.revision, result.projection.contextRevision, JSON.stringify(result.projection), now);
        for (const signal of result.signals.filter(s => s.kind === 'opt_out')) for (const evidence of signal.evidence) {
          const evidenceRef = `${thread.providerThreadId}:${evidence.messageId}`;
          const key = createHash('sha256').update(JSON.stringify([workspaceId, accountId, checkpoint.mailboxSubject, evidenceRef])).digest('hex');
          raw.prepare('INSERT OR IGNORE INTO pm_account_suppression_tombstones VALUES(?,?,?,?,?,?)').run(key, accountId, now, 'gmail_reply', evidenceRef, now);
          const message = thread.messages.find(m => m.id === evidence.messageId);
          for (const address of message?.from ?? []) raw.prepare('INSERT OR IGNORE INTO pm_handle_suppression_tombstones VALUES(?,?,?,?,?,?,?)')
            .run(`${key}:${address}`, 'email', address.toLowerCase(), now, 'gmail_reply', evidenceRef, now);
        }
      }
      // Local thread context is independent of the ordered remote execution stream.
      // Preserve aggregate_version so later delegation remains synchronizable.
      this.writeCursor(accountId, checkpoint.mailboxSubject, { checkpoint, poll: attemptId && cursor?.data.poll ? {
        ...cursor.data.poll, status: page.complete ? 'complete' : 'pending', completedAt: page.complete ? now : null } : null });
      return results;
    }).immediate();
  }
}
