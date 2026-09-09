import { createHash } from 'node:crypto';
import { relevantThreadSchema, threadProjectionSchema, accountReplyDraftSchema, type AccountReplyDraft, type RelevantThread, type ThreadProjection, type IntakeResult } from '../../shared/contracts/mailThreadContract';
import { classifyReply } from './replyClassification';
export function associateThread(input: { knownReferences: string[]; incomingReferences: string[]; participantsMatch: boolean; providerThreadMatch?: boolean }): 'matched' | 'unmatched' {
  return input.participantsMatch && (input.providerThreadMatch || input.incomingReferences.some(ref => input.knownReferences.includes(ref))) ? 'matched' : 'unmatched';
}
/** Pure projection. Production repositories own the durable atomic write/fence. */
export function mergeThread(previous: ThreadProjection | null, input: RelevantThread): IntakeResult {
  const thread = relevantThreadSchema.parse(input);
  if (previous) {
    threadProjectionSchema.parse(previous);
    if (previous.thread.accountId !== thread.accountId || previous.thread.mailboxSubject !== thread.mailboxSubject || previous.thread.providerThreadId !== thread.providerThreadId) throw new Error('thread_identity_conflict');
  }
  const ids = new Set(previous?.thread.messages.map(m => m.id));
  const added = thread.messages.filter(m => { if (ids.has(m.id)) return false; ids.add(m.id); return true; });
  if (previous && !added.length) return { changed: false, revision: previous.revision, signals: [], projection: previous, approvalInvalidation: null };
  const messages = [...(previous?.thread.messages ?? []), ...added].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  if (messages.length > 200 || Buffer.byteLength(JSON.stringify(messages)) > 250000) throw new Error('thread_capacity_exceeded');
  const revision = (previous?.revision ?? 0) + 1;
  const contextRevision = createHash('sha256').update(JSON.stringify(messages)).digest('hex');
  const signals = added.map(classifyReply);
  const projection = threadProjectionSchema.parse({ thread: { ...thread, messages }, revision, contextRevision, signals: [...(previous?.signals ?? []), ...signals] });
  return { changed: true, revision, signals, projection, approvalInvalidation: { threadId: thread.providerThreadId, previousRevision: previous?.revision ?? 0, revision, contextRevision } };
}

/** Shared SQL/Dynamo save invariant. Draft provenance is never execution approval. */
export function validateReplyDraftSave(input: AccountReplyDraft, previous: AccountReplyDraft | null, expectedRevision: number | null, projection: ThreadProjection | null): AccountReplyDraft {
  const draft = accountReplyDraftSchema.parse(input);
  if ((previous?.revision ?? null) !== expectedRevision || draft.revision !== (expectedRevision ?? 0) + 1) throw new Error('stale_draft');
  if (previous && ['id', 'accountId', 'threadId', 'mailboxSubject', 'recipient', 'sender', 'threadRevision', 'contextRevision'].some(key =>
    previous[key as keyof AccountReplyDraft] !== draft[key as keyof AccountReplyDraft])) throw new Error('draft_identity_conflict');
  if (!projection || projection.thread.accountId !== draft.accountId || projection.thread.providerThreadId !== draft.threadId
    || projection.thread.mailboxSubject !== draft.mailboxSubject || projection.revision !== draft.threadRevision || projection.contextRevision !== draft.contextRevision) throw new Error('stale_thread');
  const latest = projection.thread.messages.at(-1);
  if (!latest || latest.from.length !== 1 || latest.from[0] !== draft.recipient || ![...latest.to, ...latest.cc].includes(draft.sender) || draft.sender === draft.recipient) throw new Error('draft_participant_conflict');
  if (projection.signals.some(s => s.kind === 'opt_out')) throw new Error('reply_suppressed');
  if (draft.evidenceIds.some(id => id.startsWith('mail:') && !projection.thread.messages.some(m => `mail:${m.id}` === id))) throw new Error('unsupported_draft_evidence');
  return draft;
}
