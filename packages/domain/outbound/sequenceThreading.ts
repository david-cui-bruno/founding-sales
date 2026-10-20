import type { RepositoryContext } from '../db/workspaceScope.ts';
import type { OutboundFenceRow } from './fence.ts';
import { readStepExecution } from '../sequences/rows.ts';

export interface SequenceThreading {
  readonly threadId: string;
  readonly inReplyTo: string;
  readonly references: readonly string[];
}

type PriorEmail = {
  execution_state: string;
  completion_source: string | null;
  result: string | null;
  state: string | null;
  admin_resolution: string | null;
  mailbox_id: string | null;
  firm_id: string | null;
  contact_id: string | null;
  opportunity_id: string | null;
  recipient_address: string | null;
  subject: string | null;
  provider_message_id_header: string | null;
  provider_thread_id: string | null;
  account_matches: boolean | null;
};

export type SequenceThreadResult =
  | { readonly ok: true; readonly value: SequenceThreading | null }
  | { readonly ok: false; readonly reason: string };

/** Gmail also requires matching subjects. A deliberately different approved subject
 * starts a new conversation, without rewriting published copy or rendered hashes. */
export function threadSubject(subject: string): string {
  return subject.replace(/^(?:\s*re\s*:\s*)+/iu, '').trim();
}

/** Called under the dispatch transaction's send gate and enrollment lock, before
 * reserving capacity or minting an attempt. Only durable sent fences are evidence.
 * Their deterministic Message-IDs also survive uncertain-attempt reconciliation.
 * No mailbox reads, draft workflow, or provider request is needed to build lineage.
 */
export async function regularSequenceThreading(
  context: RepositoryContext,
  fence: OutboundFenceRow,
): Promise<SequenceThreadResult> {
  if (fence.originKind !== 'step_execution') {
    return { ok: true, value: null };
  }
  const execution = fence.stepExecutionId ? await readStepExecution(context, fence.stepExecutionId) : null;
  if (!execution || (fence.enrollmentId !== null && fence.enrollmentId !== execution.enrollmentId)) {
    return { ok: false, reason: 'sequence_thread_execution_mismatch' };
  }
  const { rows } = await context.db.query<PriorEmail>(
    `SELECT x.state AS execution_state,x.completion_source,x.result,f.state,f.admin_resolution,
       f.mailbox_id,f.firm_id,f.contact_id,f.opportunity_id,f.recipient_address,
       f.subject,f.provider_message_id_header,f.provider_thread_id,
       (o.owner_user_id=m.owner_user_id AND o.provider_account_id=m.provider_account_id) AS account_matches
     FROM step_executions current
     JOIN step_executions x ON x.workspace_id=current.workspace_id
       AND x.enrollment_id=current.enrollment_id AND x.ordinal<current.ordinal AND x.channel='email'
     LEFT JOIN outbound_messages f ON f.workspace_id=x.workspace_id AND f.step_execution_id=x.id
     LEFT JOIN mailboxes m ON m.workspace_id=f.workspace_id AND m.id=f.mailbox_id
     LEFT JOIN LATERAL (
       SELECT owner_user_id,provider_account_id FROM mailbox_oauth_grant_observations
       WHERE workspace_id=f.workspace_id AND mailbox_id=f.mailbox_id
         AND observed_at<=f.dispatch_started_at
       ORDER BY observed_at DESC,id DESC LIMIT 1
     ) o ON true
     WHERE current.workspace_id=$1 AND current.id=$2 AND current.enrollment_id=$3
     ORDER BY x.ordinal,x.id`,
    [context.scope.workspaceId, execution.id, execution.enrollmentId],
  );
  return sequenceThreadFromHistory(fence, rows);
}

/** Pure decision seam shared by the real database dispatch and boundary tests. */
export function sequenceThreadFromHistory(
  fence: Pick<OutboundFenceRow, 'mailboxId' | 'firmId' | 'contactId' | 'opportunityId' | 'recipientAddress' | 'subject'>,
  history: readonly PriorEmail[],
): SequenceThreadResult {
  const chain: PriorEmail[] = [];
  for (const prior of history) {
    if (prior.admin_resolution === 'skipped' ||
        (prior.state === null && prior.execution_state === 'completed' &&
          (['skipped', 'no_email'].includes(prior.result ?? '') ||
            (prior.completion_source === 'system' && prior.result === 'not_applicable')))) continue;
    // Even a different subject must not let an unresolved previous attempt advance.
    if (prior.state !== 'sent') return { ok: false, reason: 'sequence_thread_prior_unresolved' };
    if (prior.subject === null || threadSubject(prior.subject) !== threadSubject(fence.subject)) continue;
    if (prior.mailbox_id !== fence.mailboxId || prior.firm_id !== fence.firmId ||
        prior.contact_id !== fence.contactId || prior.opportunity_id !== fence.opportunityId ||
        prior.recipient_address !== fence.recipientAddress || prior.account_matches !== true) {
      return { ok: false, reason: 'sequence_thread_scope_changed' };
    }
    if (!prior.provider_thread_id || !/^[A-Za-z0-9_-]{1,128}$/u.test(prior.provider_thread_id) ||
        !prior.provider_message_id_header || !/^<[^<>\s@]+@[^<>\s@]+>$/u.test(prior.provider_message_id_header)) {
      return { ok: false, reason: 'sequence_thread_identity_missing' };
    }
    chain.push(prior);
  }
  const parent = chain.at(-1);
  if (!parent) return { ok: true, value: null };
  if (chain.length > 100 || chain.some(prior => prior.provider_thread_id !== parent.provider_thread_id)) {
    return { ok: false, reason: 'sequence_thread_conflict' };
  }
  return { ok: true, value: {
    threadId: parent.provider_thread_id!,
    inReplyTo: parent.provider_message_id_header!,
    references: [...new Set(chain.map(prior => prior.provider_message_id_header!))],
  } };
}
