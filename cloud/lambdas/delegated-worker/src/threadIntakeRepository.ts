import { mailCheckpointSchema, mailCursorEnvelopeSchema, type MailCursorEnvelope, threadProjectionSchema, accountReplyDraftSchema, type AccountReplyDraft, type SavedReplyDraft, type MailCheckpoint, type ThreadPage, type ThreadProjection, type IntakeResult } from '../../../../src/shared/contracts/mailThreadContract';
import { workerEventSchema } from '../../../../src/shared/contracts/delegationContract';
import { mergeThread, validateReplyDraftSave } from '../../../../src/main/outreach/threadIntake';
import { DynamoStore, fingerprint, integer, keyPart, type RepositoryOptions } from './dynamoStore';
import { authorityRecordSchema, executionAuthorityKey, executionAuthorityFields } from './executionRepository';
export const mailCursorKey = (account: string, subject: string) => `MAIL_CURSOR#${keyPart(account)}#${keyPart(subject)}`;
export const mailThreadKey = (account: string, thread: string) => `MAIL_THREAD#${keyPart(account)}#${keyPart(thread)}`;
export const mailDraftKey = (account: string, id: string) => `MAIL_DRAFT#${keyPart(account)}#${keyPart(id)}`;
export const mailSuppressionKey = (account: string) => `MAIL_SUPPRESSION#${keyPart(account)}`;
/** Durable SDK adapter, not a process-local store. Strong reads + all-or-nothing
 * CAS transaction bind intake to the same authority version dispatch fences. */
export class DynamoThreadIntakeRepository {
  readonly store: DynamoStore;
  constructor(options: RepositoryOptions) { this.store = new DynamoStore(options); }
  async cursorState(accountId: string, subject: string): Promise<{ data: MailCursorEnvelope; rev: number } | null> {
    const stored = await this.store.get<unknown>(mailCursorKey(accountId, subject));
    if (!stored) return null;
    const data = mailCursorEnvelopeSchema.parse(stored.data);
    for (const identity of [data.checkpoint, data.poll]) if (identity && (identity.accountId !== accountId || identity.mailboxSubject !== subject)) throw new Error('mail_checkpoint_identity_conflict');
    return { ...stored, data };
  }
  async checkpoint(accountId: string, subject: string): Promise<MailCheckpoint | null> { return (await this.cursorState(accountId, subject))?.data.checkpoint ?? null; }
  async beginPoll(accountId: string, mailboxSubject: string, attemptId: string): Promise<void> {
    const current = await this.cursorState(accountId, mailboxSubject);
    const data = mailCursorEnvelopeSchema.parse({ checkpoint: current?.data.checkpoint ?? null,
      poll: { attemptId, accountId, mailboxSubject, status: 'pending', startedAt: this.store.now(), completedAt: null } });
    await this.store.transact([this.store.put(mailCursorKey(accountId, mailboxSubject), data, current?.rev ?? null)]);
  }
  async failPoll(accountId: string, mailboxSubject: string, attemptId: string): Promise<void> {
    const current = await this.cursorState(accountId, mailboxSubject);
    if (!current?.data.poll || current.data.poll.attemptId !== attemptId || current.data.poll.status !== 'pending') throw new Error('stale_poll_attempt');
    await this.store.transact([this.store.put(mailCursorKey(accountId, mailboxSubject), mailCursorEnvelopeSchema.parse({ ...current.data,
      poll: { ...current.data.poll, status: 'failed', completedAt: this.store.now() } }), current.rev)]);
  }
  async getThread(accountId: string, threadId: string): Promise<ThreadProjection | null> {
    const stored = await this.store.get<unknown>(mailThreadKey(accountId, threadId));
    return stored ? threadProjectionSchema.parse(stored.data) : null;
  }
  async isSuppressed(accountId: string): Promise<boolean> { return (await this.store.get(mailSuppressionKey(accountId))) !== null; }
  async getReplyDraft(accountId: string, id: string): Promise<SavedReplyDraft | null> {
    const record = await this.store.get<unknown>(mailDraftKey(accountId, id));
    if (!record) return null;
    const draft = accountReplyDraftSchema.parse(record.data);
    if (draft.accountId !== accountId || draft.id !== id) throw new Error('draft_identity_conflict');
    const thread = await this.getThread(accountId, draft.threadId);
    return { draft, stale: !thread || thread.revision !== draft.threadRevision || thread.contextRevision !== draft.contextRevision || await this.isSuppressed(accountId) };
  }
  async saveReplyDraft(input: AccountReplyDraft, expectedRevision: number | null): Promise<AccountReplyDraft> {
    const draft = accountReplyDraftSchema.parse(input); const key = mailDraftKey(draft.accountId, draft.id);
    const previous = await this.store.get<unknown>(key);
    const thread = await this.store.get<unknown>(mailThreadKey(draft.accountId, draft.threadId));
    validateReplyDraftSave(draft, previous ? accountReplyDraftSchema.parse(previous.data) : null, expectedRevision, thread ? threadProjectionSchema.parse(thread.data) : null);
    const authorityKey = executionAuthorityKey(draft.accountId); const authority = await this.store.get<unknown>(authorityKey);
    if (!authority) throw new Error('authority_missing');
    const current = authorityRecordSchema.parse(authority.data);
    if (current.authority.accountId !== draft.accountId) throw new Error('authority_identity_conflict');
    if (await this.isSuppressed(draft.accountId)) throw new Error('reply_suppressed');
    await this.store.transact([this.store.put(key, draft, previous?.rev ?? null),
      this.store.check(mailThreadKey(draft.accountId, draft.threadId), thread!.rev),
      this.store.check(authorityKey, authority.rev, executionAuthorityFields(current)), this.store.absent(mailSuppressionKey(draft.accountId))]);
    return draft;
  }
  async applyPage(page: ThreadPage, expected: MailCheckpoint | null, attemptId?: string): Promise<IntakeResult[]> {
    const checkpoint = mailCheckpointSchema.parse(page.nextCursor); const accountId = checkpoint.accountId;
    if (page.threads.length > 20 || new Set(page.threads.map(t => t.providerThreadId)).size !== page.threads.length) throw new Error('mail_page_capacity_exceeded');
    const authKey = executionAuthorityKey(accountId); const authority = await this.store.get<unknown>(authKey);
    if (!authority) throw new Error('authority_missing');
    const current = authorityRecordSchema.parse(authority.data);
    if (current.authority.accountId !== accountId) throw new Error('authority_identity_conflict');
    const key = mailCursorKey(accountId, checkpoint.mailboxSubject); const cursor = await this.cursorState(accountId, checkpoint.mailboxSubject);
    if (attemptId && (cursor?.data.poll?.attemptId !== attemptId || cursor.data.poll.status !== 'pending')) throw new Error('stale_poll_attempt');
    if (JSON.stringify(cursor?.data.checkpoint ?? null) !== JSON.stringify(expected)) throw new Error('stale_mail_checkpoint');
    const envelope = mailCursorEnvelopeSchema.parse({ checkpoint, poll: attemptId && cursor?.data.poll ? { ...cursor.data.poll,
      status: page.complete ? 'complete' : 'pending', completedAt: page.complete ? this.store.now() : null } : null });
    const items = [this.store.put(key, envelope, cursor?.rev ?? null)]; const results: IntakeResult[] = [];
    const head = await this.store.get<{ sequence: number }>('EVENT_HEAD'); let sequence = integer.parse(head?.data.sequence ?? 0);
    const sequences: number[] = []; let version = current.version;
    for (const thread of page.threads) {
      if (thread.accountId !== accountId || thread.mailboxSubject !== checkpoint.mailboxSubject) throw new Error('thread_identity_conflict');
      const key = mailThreadKey(accountId, thread.providerThreadId); const stored = await this.store.get<unknown>(key);
      const result = mergeThread(stored ? threadProjectionSchema.parse(stored.data) : null, thread); results.push(result);
      if (!result.changed) continue;
      items.push(this.store.put(key, result.projection, stored?.rev ?? null));
      sequence = integer.parse(sequence + 1); version = integer.parse(version + 1); sequences.push(sequence);
      const event = workerEventSchema.parse({ id: `thread-${fingerprint([this.store.options.workspaceId, accountId, result.projection])}`,
        workspaceId: this.store.options.workspaceId, accountId, authorityGeneration: current.authority.generation, aggregateVersion: version,
        kind: 'thread.observed', payload: { projection: result.projection, approvalInvalidation: result.approvalInvalidation, observedAt: this.store.now() } });
      items.push(this.store.put(this.store.eventKey(sequence), { sequence, event, published: !this.store.options.publish }, null));
    }
    if (sequences.length) {
      const next = { ...current, version };
      items.push(this.store.put(authKey, next, authority.rev, executionAuthorityFields(next), executionAuthorityFields(current)), this.store.put('EVENT_HEAD', { sequence }, head?.rev ?? null));
      if (results.some(r => r.signals.some(s => s.kind === 'opt_out'))) {
        const old = await this.store.get(mailSuppressionKey(accountId));
        if (!old) items.push(this.store.put(mailSuppressionKey(accountId), { accountId, observedAt: this.store.now(), evidence: results.flatMap(r => r.signals.filter(s => s.kind === 'opt_out')) }, null));
      }
    } else items.push(this.store.check(authKey, authority.rev, executionAuthorityFields(current)));
    await this.store.transact(items);
    for (const seq of sequences) await this.store.publish(seq);
    return results;
  }
}
