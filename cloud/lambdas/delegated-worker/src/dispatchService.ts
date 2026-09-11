import { createPreparedGmailSender } from '../../../../src/main/outreach/providers/gmailProvider';
import type { EmailSendResult } from '../../../../src/main/outreach/providers/providerTypes';
import type { Reservation } from '../../../../src/shared/contracts/delegationContract';
import { type DynamoExecutionRepository } from './executionRepository';
import { type DynamoDispatchRepository, type SendEvidence } from './dispatchRepository';
import { type RemoteGoogleAuthorization } from './remoteGoogleAuthorization';
import { DynamoThreadIntakeRepository } from './threadIntakeRepository';
import { createMailPoller } from './mailPoller';
import { fingerprint } from './dynamoStore';
import type { ProviderIdentity } from './sendReconciler';

export type DispatchOutcome = { status: 'held' | 'not_sent' | 'provider_accepted' | 'unknown'; reason: string; providerIdentity?: ProviderIdentity };
export type DispatchDependencies = { execution: DynamoExecutionRepository; policy: DynamoDispatchRepository; authorization: RemoteGoogleAuthorization; fetch: typeof globalThis.fetch };
const reasons = new Set(['authority_missing', 'authority_not_active', 'stale_authority', 'dispatch_policy_missing', 'dispatch_evidence_missing', 'approval_not_current',
  'thread_not_current', 'route_not_current', 'recipient_permission_unproven', 'dispatch_suppressed', 'dispatch_cap_reached', 'dispatch_evidence_expired',
  'campaign_binding_unavailable', 'intake_unavailable', 'intake_incomplete', 'intake_stale', 'manual_outcome_pending', 'google_access_evidence_missing']);
function heldReason(error: unknown): string { return error instanceof Error && reasons.has(error.message) ? error.message : 'dispatch_prerequisite_unavailable'; }
/** No handler registration. Trusted source composition must explicitly provide all
 * stores and external boundaries. The provider continuation immediately follows reserve. */
export function createDispatchService(input: DispatchDependencies) {
  const threads = new DynamoThreadIntakeRepository(input.policy.store.options);
  const poller = createMailPoller({ authorization: input.authorization, store: threads, fetch: input.fetch });
  return { async dispatch(commandId: string, signal: AbortSignal = new AbortController().signal): Promise<DispatchOutcome> {
    let intent;
    try { signal.throwIfAborted(); intent = await input.policy.loadIntent(commandId); signal.throwIfAborted(); } catch { return { status: 'held', reason: 'dispatch_identity_unavailable' }; }
    if (!intent) return { status: 'held', reason: 'dispatch_intent_missing' };
    let reservation: Reservation;
    let prepared;
    try {
      const prior = await input.execution.readDispatch(intent.action.accountId, intent.action.actionId);
      if (!prior) return { status: 'held', reason: 'action_not_prepared' };
      if (prior.state === 'provider_accepted') return { status: 'provider_accepted', reason: 'already_accepted' };
      if (prior.state === 'cancelled') {
        const evidence = await input.policy.sendEvidence(commandId);
        const notSent = evidence.some(item => item.state === 'cancelled' && item.kind === 'provider_result' && item.reason === 'provider_not_sent'
          && fingerprint(item.reservation) === fingerprint(prior.reservation));
        return notSent ? { status: 'not_sent', reason: 'provider_not_sent' } : { status: 'held', reason: 'action_cancelled' };
      }
      if (prior.reservation || ['dispatching', 'unknown', 'human_reported_sent'].includes(prior.state)) return { status: 'unknown', reason: 'already_reserved' };
      if (!['prepared', 'queued'].includes(prior.state)) return { status: 'held', reason: 'action_not_eligible' };
      if (intent.kind !== 'phone_requested_followup') {
        const thread = await threads.getThread(intent.action.accountId, intent.frozenMessage.threadId);
        if (!thread) return { status: 'held', reason: 'thread_not_current' };
      }
      const scope = await threads.scope(intent.action.accountId, intent.mailboxSubject);
      if (!scope || !scope.participantAddresses.includes(intent.frozenMessage.to) || intent.kind !== 'phone_requested_followup' && !scope.knownThreadIds.includes(intent.frozenMessage.threadId)) {
        return { status: 'held', reason: 'intake_scope_missing' };
      }
      // Only identity crosses this boundary. C3 loads the complete authorized
      // account scope; the current recipient never narrows the account cursor.
      signal.throwIfAborted();
      const poll = await poller.pollOnce({ accountId: intent.action.accountId, pairingId: intent.pairingId, mailboxSubject: intent.mailboxSubject }, signal);
      if (!poll.complete || poll.suppressed) return { status: 'held', reason: 'intake_incomplete' };
      signal.throwIfAborted();
      const access = await input.authorization.authorizedAccess(intent.pairingId, ['send', 'relevant_read'], signal);
      signal.throwIfAborted();
      if (access.grant.subject !== intent.mailboxSubject || access.grant.email !== intent.frozenMessage.from || access.grant.owner !== 'remote') return { status: 'held', reason: 'sender_identity_conflict' };
      prepared = createPreparedGmailSender({ accountEmail: access.grant.email, accessToken: access.accessToken, fetch: input.fetch, signal, isCurrent: () => !signal.aborted });
      const expectedVersion = await input.execution.currentVersion(intent.action.accountId);
      // No refresh, publication or other async operation after this reservation.
      signal.throwIfAborted();
      reservation = await input.execution.reserveDispatch({ ...intent.action, expectedVersion }, access.accessEvidence, signal);
    } catch (error) {
      // A lost reservation response may have committed. Never infer non-delivery
      // from absence or attempt another reservation in this invocation.
      try {
        const current = await input.execution.readDispatch(intent.action.accountId, intent.action.actionId);
        if (current?.reservation) return { status: 'unknown', reason: 'reservation_result_unknown' };
      } catch { return { status: 'unknown', reason: 'reservation_result_unknown' }; }
      return { status: 'held', reason: heldReason(error) };
    }
    let result: EmailSendResult;
    try { result = await prepared.sendOnce(intent.frozenMessage); }
    catch { result = { status: 'unknown', reasonCode: 'provider_result_unknown' }; }
    const state = result.status === 'accepted' ? 'provider_accepted' : result.status === 'not_sent' ? 'cancelled' : 'unknown';
    const reason = result.status === 'accepted' ? 'provider_accepted' : result.status === 'not_sent' ? 'provider_not_sent' : 'provider_result_unknown';
    const observedAt = input.policy.store.now();
    const providerIdentity = result.status === 'accepted' ? { messageId: result.messageId, threadId: result.threadId } : null;
    const evidence: SendEvidence = { commandId, reservation, state, observedAt, kind: 'provider_result', reason,
      rfcMessageId: `<${commandId}@callie.invalid>`, providerIdentity };
    try { await input.execution.appendOutcome({ reservation, state, observedAt, evidenceRef: `send-${fingerprint(evidence)}` }, evidence); }
    catch { return { status: 'unknown', reason: 'evidence_uncommitted', ...(providerIdentity ? { providerIdentity } : {}) }; }
    return { status: result.status === 'accepted' ? 'provider_accepted' : result.status, reason, ...(providerIdentity ? { providerIdentity } : {}) };
  } };
}
