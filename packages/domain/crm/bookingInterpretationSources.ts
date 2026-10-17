import { createHash } from 'node:crypto';
import type { BookingInterpretationSource } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { lockIdentityContext } from './identityAccess.ts';
import { readMailConversation, snapshotMailCopyAuthorityBatch, lockMailCopyAuthorityBatch } from '../mail/crmSources.ts';

/** Existing admitted-message seam: canonical copied mail, not caller-supplied text or permission. */
export async function loadBookingInterpretationSources(context: RepositoryContext, sources: readonly BookingInterpretationSource[]) {
  if (context.scope.actor.kind !== 'user' || sources.length < 1 || sources.length > 4 || new Set(sources.map(s => s.sourceId)).size !== sources.length) return null;
  const batch = await snapshotMailCopyAuthorityBatch(context, sources, { maxSources: 4 });
  if (!batch || !await lockIdentityContext(context, { firmIds: batch.firmIds, personIds: batch.personIds })
    || !await lockMailCopyAuthorityBatch(context, batch, { firmIds: batch.firmIds, personIds: batch.personIds })) return null;
  const originals = [];
  for (const exact of sources) {
    const read = await readMailConversation(context, exact);
    if (read.state !== 'available' || read.source.passage === null || Buffer.byteLength(read.source.passage) > 12000) return null;
    const current = (await context.db.query<{ provider_thread_id: string; provider_account_id: string; generation: number; status: string; diagnostic_authorization_id: string | null }>(
      `SELECT m.provider_thread_id,mb.provider_account_id,mb.generation,mb.status,s.diagnostic_authorization_id
       FROM crm_mail_sources s JOIN mail_messages m ON m.workspace_id=s.workspace_id AND m.id=s.source_id
       JOIN mailboxes mb ON mb.workspace_id=s.workspace_id AND mb.id=s.mailbox_id WHERE s.workspace_id=$1 AND s.source_id=$2`,
      [context.scope.workspaceId, exact.sourceId])).rows[0];
    if (!current || current.status !== 'connected' || current.generation !== read.source.acquiredGeneration || current.diagnostic_authorization_id !== null) return null;
    originals.push({ ...read.source, threadId: current.provider_thread_id, providerAccountId: current.provider_account_id });
  }
  const message = originals[0]!;
  if (message.direction !== 'incoming' || originals.some(s => s.mailboxId !== message.mailboxId || s.threadId !== message.threadId
    || s.accountBinding !== message.accountBinding || s.ownerUserId !== message.ownerUserId)
    || originals.slice(1).some(s => s.direction !== 'outgoing' || !s.sentProof || s.occurredAt > message.occurredAt)) return null;
  const snapshots = originals.map(({ passage: _passage, subject: _subject, attachments: _attachments, ...metadata }) => metadata);
  const fingerprint = createHash('sha256').update(JSON.stringify({ snapshots, contextIdentity: batch.contextIdentity })).digest('hex');
  return { originals, fingerprint, provenance: { source: sources[0]!, priorSources: sources.slice(1),
    occurredAt: message.occurredAt, observedAt: message.observedAt, rawSenderDate: message.rawSenderDate,
    participant: message.envelope.from, originalContexts: message.originalContexts, reviewedContexts: message.reviewedContexts,
    accountBinding: message.accountBinding, generation: message.acquiredGeneration } };
}
